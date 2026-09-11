const attempts = globalThis.__saphiHealthAttempts || new Map();
globalThis.__saphiHealthAttempts = attempts;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Saphi-Owner-Key');
  res.setHeader('Cache-Control', 'no-store');
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function quotaKey(deviceId) {
  return `${dayKey()}:${String(deviceId || 'anon').slice(0, 120)}`;
}

function remainingAttempts(deviceId) {
  return Math.max(0, 5 - (attempts.get(quotaKey(deviceId)) || 0));
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

function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
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
  const mimeType = /^image\/(jpeg|png|webp|heic|heif)$/i.test(body.mimeType || '') ? body.mimeType : 'image/jpeg';
  const plantData = body.plantData || {};

  if (!imageBase64 || imageBase64.length > 9_000_000) {
    return res.status(400).json({ error: 'La imagen está vacía o supera el tamaño permitido.', quota: quotaStatus(owner, body.deviceId) });
  }
  if (!owner && remainingAttempts(body.deviceId) <= 0) {
    return res.status(429).json({ error: 'Alcanzaste el límite de 5 diagnósticos de hoy.', quota: { limit: 5, remaining: 0, unlimited: false } });
  }

  const promptText = [
    'Eres el asistente fitosanitario prudente de Saphi en Ecuador.',
    'Analiza solamente lo que se observa en la fotografía. No afirmes un diagnóstico definitivo si la imagen no lo permite.',
    `Planta: ${String(plantData.nombre || 'Sin nombre').slice(0, 100)} (${String(plantData.species || '').slice(0, 160)})`,
    `Grupo: ${String(plantData.type || '').slice(0, 160)}`,
    `Nivel: ${body.tone === 'agronomo' ? 'técnico agronómico' : 'hogar, claro y práctico'}`,
    'Responde en español con estas secciones: 1. Hipótesis principal y nivel de confianza. 2. Evidencia visible. 3. Qué revisar antes de tratar. 4. Acciones de bajo riesgo para hoy. 5. Cuándo consultar a un profesional.',
    'No recomiendes plaguicidas de alta toxicidad ni dosis inventadas. Para cualquier insumo, indica seguir la etiqueta y normativa local.'
  ].join('\n');

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
          generationConfig: { temperature: 0.2 }
        })
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || 'Gemini no pudo procesar el diagnóstico.';
      return res.status(response.status).json({ error: message, quota: quotaStatus(owner, body.deviceId) });
    }

    const output = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
    if (!output) return res.status(502).json({ error: 'La IA no devolvió un diagnóstico utilizable.', quota: quotaStatus(owner, body.deviceId) });
    const remaining = owner ? null : countAttempt(body.deviceId);
    return res.status(200).json({ result: output, quota: owner ? quotaStatus(true, body.deviceId) : { limit: 5, remaining, unlimited: false } });
  } catch (error) {
    return res.status(502).json({ error: 'No se pudo completar el diagnóstico. Intenta con otra fotografía.', quota: quotaStatus(owner, body.deviceId) });
  }
};
