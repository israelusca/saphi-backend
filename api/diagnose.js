// api/diagnose.js  ·  Backend serverless (Vercel) para Saphi
// ─────────────────────────────────────────────────────────────
// Contrato: entra {imageBase64, mimeType, tone, plantData} y sale {result}.
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//   GEMINI_API_KEY   → tu clave de Google AI Studio  (obligatoria)
//   GEMINI_MODEL     → modelo a usar (opcional). Por defecto "gemini-3.6-flash".
//                      Si pones aquí un modelo YA APAGADO (gemini-1.x / 2.x),
//                      el backend lo ignora y usa el modelo vigente por defecto.
//   AI_DAILY_LIMIT   → máx. de análisis por IP y día (opcional, por defecto 10).
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN → activan el límite real.
//   ALLOWED_ORIGIN   → restringe el CORS a tu dominio (opcional; por defecto "*").
//   SAPHI_OWNER_KEY  → clave privada del propietario (acceso sin límite).
// ─────────────────────────────────────────────────────────────

// Modelo por defecto vigente (sept. 2026). gemini-3.6-flash: multimodal y equilibrado.
const DEFAULT_MODEL = 'gemini-3.6-flash';
// Respaldo si el principal falla por modelo no disponible.
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
// Patrón de generaciones ya apagadas → se ignoran si vienen en GEMINI_MODEL.
const DEPRECATED_RE = /^(models\/)?gemini-(0|1|1\.5|2|2\.0|2\.5)([.\-]|$)/i;

function pickModel() {
  const env = (process.env.GEMINI_MODEL || '').trim();
  if (env && !DEPRECATED_RE.test(env)) return env.replace(/^models\//, '');
  return DEFAULT_MODEL;
}

// Llama a Gemini; si el modelo primario falla por no-disponible, reintenta con el respaldo.
async function callGemini(apiKey, model, body) {
  const call = (m) => fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + apiKey,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  let r = await call(model);
  if (!r.ok) {
    const txt = await r.text();
    // Modelo no disponible / apagado → un reintento con el respaldo.
    if ((r.status === 404 || /not (found|available)|no longer available|deprecat/i.test(txt)) && model !== FALLBACK_MODEL) {
      const r2 = await call(FALLBACK_MODEL);
      return { r: r2, firstErr: txt };
    }
    return { r, firstErr: txt };
  }
  return { r, firstErr: null };
}

// Límite por IP y día usando Upstash Redis (REST). Devuelve {blocked} o null si no hay store.
async function rateLimit(ip, limit) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const day = new Date().toISOString().slice(0, 10);
  const key = 'saphi:rl:' + day + ':' + ip;
  try {
    const inc = await fetch(url + '/INCR/' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + token } });
    const j = await inc.json();
    const count = (j && typeof j.result === 'number') ? j.result : parseInt(j && j.result, 10) || 1;
    if (count === 1) {
      await fetch(url + '/EXPIRE/' + encodeURIComponent(key) + '/93600', { headers: { Authorization: 'Bearer ' + token } });
    }
    return { blocked: count > limit, count, remaining: Math.max(0, limit - count) };
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  const ALLOWED = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // ✔ CORS: se permite la cabecera personalizada del modo propietario.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Saphi-Owner-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ result: 'Usa POST.' });

  try {
    const { imageBase64, mimeType, tone, plantData } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') return res.status(400).json({ result: 'Falta la imagen.' });
    if (imageBase64.length > 8000000) return res.status(413).json({ result: 'La imagen es demasiado grande. Toma una foto más liviana.' });
    const OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    const mime = OK_MIME.includes(mimeType) ? mimeType : 'image/jpeg';
    const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ result: 'Falta configurar GEMINI_API_KEY en Vercel.' });
    const model = pickModel();

    // Acceso propietario (sin límite) por cabecera.
    const ownerKey = process.env.SAPHI_OWNER_KEY || '';
    const sentKey = req.headers['x-saphi-owner-key'] || '';
    const isOwner = ownerKey && sentKey && String(sentKey) === String(ownerKey);

    const LIMIT = parseInt(process.env.AI_DAILY_LIMIT || '10', 10);
    let quota = null;
    if (!isOwner) {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
      const rl = await rateLimit(ip, LIMIT);
      if (rl && rl.blocked) return res.status(429).json({ result: 'Llegaste al límite de ' + LIMIT + ' análisis por IA hoy. Vuelve mañana 🌱', quota: { remaining: 0 } });
      if (rl) quota = { remaining: rl.remaining };
    } else {
      quota = { unlimited: true };
    }

    const p = plantData || {};
    const esAgronomo = tone === 'agronomo';
    const persona = esAgronomo
      ? 'Eres un Ingeniero Agrónomo fitopatólogo de Saphi (Ecuador). Responde técnico y preciso, con terminología correcta (patógeno, manejo, dosis orientativas), pero claro. Sin adornos.'
      : 'Eres el asistente de Saphi (Ecuador) en modo Hogar: cálido y cercano, explicas fácil y con confianza, sin tecnicismos, con trato positivo.';

    const prompt = persona + '\n' +
'Analiza la FOTO de la hoja/planta del usuario y da un diagnóstico fitosanitario en español.\n' +
'Datos de la planta: nombre="' + clip(p.nombre, 60) + '", especie="' + clip(p.species, 60) + '", tipo="' + clip(p.type, 40) + '".\n' +
'Estructura tu respuesta EXACTAMENTE con estos 3 apartados usando encabezados <h4>:\n' +
'<h4>🩺 1. Diagnóstico</h4> (qué tiene, en una o dos frases)\n' +
'<h4>🔬 2. Causa observable</h4> (qué se ve en la foto que lo indica)\n' +
'<h4>💊 3. Qué hacer hoy</h4> (2 a 4 pasos concretos, preferencia por manejo orgánico)\n' +
'Sé honesto sobre la incertidumbre: si la imagen está oscura, borrosa o no se distingue la hoja, dilo claramente y pide una nueva foto con buena luz, en vez de inventar un diagnóstico.\n' +
'Usa **negritas** para lo importante. No inventes datos que no puedas ver en la foto.';

    const body = { contents: [{ parts: [ { text: prompt }, { inlineData: { mimeType: mime, data: imageBase64 } } ] }] };
    const { r, firstErr } = await callGemini(apiKey, model, body);

    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ result: 'El servicio de IA respondió con un error. Intenta de nuevo en un momento.', debug: (firstErr || errText || '').slice(0, 300), quota });
    }

    const j = await r.json();
    const text = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts
      ? j.candidates[0].content.parts.map(x => x.text || '').join('\n').trim()
      : '';

    return res.status(200).json({ result: text || 'No pude generar el diagnóstico. Intenta con otra foto.', quota });
  } catch (e) {
    return res.status(500).json({ result: 'Ocurrió un error procesando la imagen. Intenta de nuevo.' });
  }
}
