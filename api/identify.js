// api/identify.js  ·  Backend serverless (Vercel) para Saphi
// ─────────────────────────────────────────────────────────────
// Identifica la ESPECIE de la foto SOLO contra el catálogo que envía la app.
// Entra: {imageBase64, mimeType, catalogue:[[id,n,sci,t],...], instruction?}
// Sale : {identification:{matchId, confidence, alternatives:[id,...]}, quota}
//
// Variables de entorno: las mismas que api/diagnose.js
//   GEMINI_API_KEY (obligatoria), GEMINI_MODEL, AI_DAILY_LIMIT,
//   UPSTASH_REDIS_REST_URL/TOKEN, ALLOWED_ORIGIN, SAPHI_OWNER_KEY.
// ─────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const DEPRECATED_RE = /^(models\/)?gemini-(0|1|1\.5|2|2\.0|2\.5)([.\-]|$)/i;

function pickModel() {
  const env = (process.env.GEMINI_MODEL || '').trim();
  if (env && !DEPRECATED_RE.test(env)) return env.replace(/^models\//, '');
  return DEFAULT_MODEL;
}
async function callGemini(apiKey, model, body) {
  const call = (m) => fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + apiKey,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  let r = await call(model);
  if (!r.ok) {
    const txt = await r.text();
    if ((r.status === 404 || /not (found|available)|no longer available|deprecat/i.test(txt)) && model !== FALLBACK_MODEL) {
      return { r: await call(FALLBACK_MODEL), firstErr: txt };
    }
    return { r, firstErr: txt };
  }
  return { r, firstErr: null };
}
async function rateLimit(ip, limit) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const day = new Date().toISOString().slice(0, 10);
  const key = 'saphi:idrl:' + day + ':' + ip;
  try {
    const inc = await fetch(url + '/INCR/' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + token } });
    const j = await inc.json();
    const count = (j && typeof j.result === 'number') ? j.result : parseInt(j && j.result, 10) || 1;
    if (count === 1) await fetch(url + '/EXPIRE/' + encodeURIComponent(key) + '/93600', { headers: { Authorization: 'Bearer ' + token } });
    return { blocked: count > limit, remaining: Math.max(0, limit - count) };
  } catch (e) { return null; }
}
function stripFences(s) { return String(s || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'').trim(); }

export default async function handler(req, res) {
  const ALLOWED = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Saphi-Owner-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Usa POST.' });

  try {
    const { imageBase64, mimeType, catalogue, instruction } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') return res.status(400).json({ message: 'Falta la imagen.' });
    if (imageBase64.length > 8000000) return res.status(413).json({ message: 'La imagen es demasiado grande. Toma una foto más liviana.' });
    if (!Array.isArray(catalogue) || !catalogue.length) return res.status(400).json({ message: 'Falta el catálogo de referencia.' });
    const OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    const mime = OK_MIME.includes(mimeType) ? mimeType : 'image/jpeg';

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ message: 'Falta configurar GEMINI_API_KEY en Vercel.' });
    const model = pickModel();

    const ownerKey = process.env.SAPHI_OWNER_KEY || '', sentKey = req.headers['x-saphi-owner-key'] || '';
    const isOwner = ownerKey && sentKey && String(sentKey) === String(ownerKey);
    const LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '10', 10);
    let quota = null;
    if (!isOwner) {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
      const rl = await rateLimit(ip, LIMIT);
      if (rl && rl.blocked) return res.status(429).json({ message: 'Llegaste al límite de identificaciones por IA de hoy. Vuelve mañana 🌱', quota: { remaining: 0 } });
      if (rl) quota = { remaining: rl.remaining };
    } else { quota = { unlimited: true }; }

    // Catálogo compacto: id | nombre | científico  (recortado por seguridad de tokens)
    const ids = new Set();
    const lines = catalogue.slice(0, 600).map(row => {
      const id = String(row[0] || '').slice(0, 40); ids.add(id);
      return id + ' | ' + String(row[1] || '').slice(0, 60) + ' | ' + String(row[2] || '').slice(0, 60);
    }).join('\n');

    const prompt =
'Eres un botánico de Saphi (Ecuador). Identifica la planta de la IMAGEN comparándola ÚNICAMENTE con este catálogo (formato: id | nombre común | nombre científico):\n' +
lines + '\n\n' +
(instruction ? instruction + '\n' : '') +
'Reglas estrictas:\n' +
'- matchId DEBE ser exactamente uno de los id del catálogo, o null si no hay coincidencia razonable.\n' +
'- No inventes id que no estén en la lista.\n' +
'- confidence es un número entre 0 y 1 (qué tan seguro estás).\n' +
'- alternatives: hasta 3 id del catálogo que también podrían ser, ordenados por probabilidad.\n' +
'- Si la foto está borrosa, oscura o no muestra una planta reconocible, devuelve matchId null y confidence baja.\n' +
'Responde SOLO con JSON válido: {"matchId": string|null, "confidence": number, "alternatives": string[]}';

    const body = {
      contents: [{ parts: [ { text: prompt }, { inlineData: { mimeType: mime, data: imageBase64 } } ] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
    };
    const { r, firstErr } = await callGemini(apiKey, model, body);
    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ message: 'El servicio de identificación respondió con un error. Intenta de nuevo.', debug: (firstErr || errText || '').slice(0, 300), quota });
    }
    const j = await r.json();
    const raw = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts
      ? j.candidates[0].content.parts.map(x => x.text || '').join('') : '';
    let parsed = null;
    try { parsed = JSON.parse(stripFences(raw)); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      return res.status(200).json({ identification: { matchId: null, confidence: 0, alternatives: [] }, quota });
    }
    // Validación: solo ids reales del catálogo.
    let matchId = parsed.matchId && ids.has(String(parsed.matchId)) ? String(parsed.matchId) : null;
    let confidence = Number(parsed.confidence); if (!isFinite(confidence)) confidence = 0;
    if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
    confidence = Math.max(0, Math.min(1, confidence));
    const alternatives = (Array.isArray(parsed.alternatives) ? parsed.alternatives : [])
      .map(x => String(typeof x === 'object' && x ? (x.matchId || x.id || '') : x))
      .filter(id => id && ids.has(id) && id !== matchId)
      .filter((id, i, a) => a.indexOf(id) === i).slice(0, 3);

    return res.status(200).json({ identification: { matchId, confidence, alternatives }, quota });
  } catch (e) {
    return res.status(500).json({ message: 'Ocurrió un error identificando la imagen. Intenta de nuevo.' });
  }
}
