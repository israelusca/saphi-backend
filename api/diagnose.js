export default async function handler(req, res) {
  // Permite que la app de Saphi se comunique sin bloqueos CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Solo se acepta método POST' });
  }

  // Toma TU clave secreta guardada en Vercel
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
  }

  const { imageBase64, mimeType, plantData, tone } = req.body || {};
  if (!imageBase64) {
    return res.status(400).json({ error: 'No se recibió la foto' });
  }

  const promptText = `Eres el fitopatólogo experto de Saphi en Ecuador. 
Analiza la fotografía de esta hoja enferma.

DATOS DE LA PLANTA:
- Nombre: "${plantData?.nombre || 'Planta'}" (${plantData?.species || ''})
- Tipo: ${plantData?.type || ''}
- Modo: ${tone === 'vecina' ? 'Estilo Vecina Sabia (sencillo, cariñoso y práctico)' : 'Rigor técnico agronómico'}

RESPONDE OBLIGATORIAMENTE EN ESTAS 3 SECCIONES:
<h4>🩺 1. Diagnóstico exacto</h4>
[Qué enfermedad, plaga o daño físico específico observas en la foto]

<h4>🔬 2. Causa observable</h4>
[Qué detalles visibles en la hoja confirman este diagnóstico]

<h4>💊 3. Qué hacer hoy (Tratamiento)</h4>
[Pasos concretos e inmediatos para salvar la planta hoy]`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: promptText },
            { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || `Error HTTP ${response.status}`);
    }

    const output = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return res.status(200).json({ result: output });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
