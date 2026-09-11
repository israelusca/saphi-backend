const attempts = globalThis.__saphiIdentifyAttempts || new Map();
globalThis.__saphiIdentifyAttempts = attempts;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function quotaKey(deviceId) {
  return `${dayKey()}:${String(deviceId || 'anon').slice(0, 120)}`;
}

function allowAttempt(deviceId) {
  return (attempts.get(quotaKey(deviceId)) || 0) < 5;
}

function countAttempt(deviceId) {
  const key = quotaKey(deviceId);
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
  return Math.max(0, 5 - (attempts.get(quotaKey(deviceId)) || 0));
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
  const imageBase64 = cleanBase64(body.imageBase64);
  const mimeType = /^image\/(jpeg|png|webp|heic|heif)$/i.test(body.mimeType || '')
    ? body.mimeType
    : 'image/jpeg';
  const catalogue = Array.isArray(body.catalogue) ? body.catalogue.slice(0, 600) : [];

  if (!imageBase64 || imageBase64.length > 9_000_000) {
    return res.status(400).json({ error: 'La imagen está vacía o supera el tamaño permitido.', quota: { limit: 5, remaining: remainingAttempts(body.deviceId) } });
  }
  if (!catalogue.length) {
    return res.status(400).json({ error: 'No se recibió el catálogo de Saphi.', quota: { limit: 5, remaining: remainingAttempts(body.deviceId) } });
  }
  if (!allowAttempt(body.deviceId)) {
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
      return res.status(response.status).json({ error: message, quota: { limit: 5, remaining: remainingAttempts(body.deviceId) } });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const matchId = allowedIds.has(String(parsed.matchId)) ? String(parsed.matchId) : null;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const alternatives = [...new Set(Array.isArray(parsed.alternatives) ? parsed.alternatives.map(String) : [])]
      .filter(id => id !== matchId && allowedIds.has(id))
      .slice(0, 3);

    const remaining = countAttempt(body.deviceId);
    return res.status(200).json({ identification: { matchId, confidence, alternatives }, quota: { limit: 5, remaining } });
  } catch (error) {
    return res.status(502).json({ error: 'La identificación no produjo una respuesta válida. Intenta con otra fotografía.', quota: { limit: 5, remaining: remainingAttempts(body.deviceId) } });
  }
}
