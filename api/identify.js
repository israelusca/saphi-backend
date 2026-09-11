const crypto = require('crypto');
const attempts = globalThis.__saphiIdentifyAttempts || new Map();
globalThis.__saphiIdentifyAttempts = attempts;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Saphi-Owner-Key');
  res.setHeader('Cache-Control', 'no-store');
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function allowAttempt(deviceId) {
  const key = `${dayKey()}:${String(deviceId || 'anon').slice(0, 120)}`;
  const count = attempts.get(key) || 0;
  if (count >= 5) return false;
  return true;
}

function countAttempt(deviceId) {
  const key = `${dayKey()}:${String(deviceId || 'anon').slice(0, 120)}`;
  const count = attempts.get(key) || 0;
  attempts.set(key, count + 1);
  if (attempts.size > 5000) {
    for (const storedKey of attempts.keys()) {
      if (!storedKey.startsWith(`${dayKey()}:`)) attempts.delete(storedKey);
    }
  }
  return Math.max(0, 5 - (count + 1));
}

function remainingAttempts(deviceId) {
  const key = `${dayKey()}:${String(deviceId || 'anon').slice(0, 120)}`;
  return Math.max(0, 5 - (attempts.get(key) || 0));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function requestIp(req) {
  return String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim().replace(/^::ffff:/, '');
}

function isOwner(req) {
  const secret = process.env.SAPHI_OWNER_KEY || '';
  const supplied = req.headers['x-saphi-owner-key'] || '';
  if (secret && safeEqual(supplied, secret)) return true;
  const allowedIps = String(process.env.SAPHI_OWNER_IPS || '').split(',').map(value => value.trim()).filter(Boolean);
  return allowedIps.includes(requestIp(req));
}

function quotaStatus(owner, deviceId) {
  return owner ? { limit: null, remaining: null, unlimited: true } : { limit: 5, remaining: remainingAttempts(deviceId), unlimited: false };
}

function cleanBase64(value) {
  return String(value || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Falta configurar la clave de Gemini en Vercel.' });

  const body = req.body || {};
  const owner = isOwner(req);
  const imageBase64 = cleanBase64(body.imageBase64);
  const mimeType = /^image\/(jpeg|png|webp|heic|heif)$/i.test(body.mimeType || '')
    ? body.mimeType
    : 'image/jpeg';
  const catalogue = Array.isArray(body.catalogue) ? body.catalogue.slice(0, 600) : [];

  if (!imageBase64 || imageBase64.length > 9_000_000) {
    return res.status(400).json({ error: 'La imagen está vacía o supera el tamaño permitido.', quota: quotaStatus(owner, body.deviceId) });
  }
  if (!catalogue.length) return res.status(400).json({ error: 'No se recibió el catálogo de Saphi.', quota: quotaStatus(owner, body.deviceId) });
  if (!owner && !allowAttempt(body.deviceId)) {
    return res.status(429).json({ error: 'Alcanzaste el límite de 5 identificaciones de hoy.', quota: { limit: 5, remaining: 0 } });
  }

  const allowedIds = new Set(catalogue.map(row => Array.isArray(row) ? String(row[0]) : '').filter(Boolean));
  const prompt = [
    'Actúa como taxónomo botánico prudente.',
    'Identifica la planta visible usando exclusivamente una especie del catálogo proporcionado.',
    'Evalúa hojas, nervaduras, tallo, hábito de crecimiento, disposición foliar y estructuras visibles.',
    'No inventes una coincidencia. Si la fotografía no permite distinguirla o no está en el catálogo, usa matchId null.',
    'Devuelve solo JSON válido con matchId, confidence entre 0 y 1 y hasta tres alternatives.',
    `CATÁLOGO: ${JSON.stringify(catalogue)}`
  ].join('\n');

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                matchId: { type: 'STRING', nullable: true },
                confidence: { type: 'NUMBER' },
                alternatives: { type: 'ARRAY', items: { type: 'STRING' } }
              },
              required: ['matchId', 'confidence', 'alternatives']
            }
          }
        })
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || 'Gemini no pudo procesar la identificación.';
      return res.status(response.status).json({ error: message });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const matchId = allowedIds.has(String(parsed.matchId)) ? String(parsed.matchId) : null;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const alternatives = [...new Set(Array.isArray(parsed.alternatives) ? parsed.alternatives.map(String) : [])]
      .filter(id => id !== matchId && allowedIds.has(id))
      .slice(0, 3);

    const remaining = owner ? null : countAttempt(body.deviceId);
    return res.status(200).json({ identification: { matchId, confidence, alternatives }, quota: owner ? quotaStatus(true, body.deviceId) : { limit: 5, remaining, unlimited: false } });
  } catch (error) {
    return res.status(502).json({ error: 'La identificación no produjo una respuesta válida. Intenta con otra fotografía.', quota: quotaStatus(owner, body.deviceId) });
  }
}
