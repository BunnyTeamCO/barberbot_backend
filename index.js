require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURACIÓN ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Arreglar saltos de línea en la llave privada (Problema común en deploys)
const privateKey = process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '';

const jwtClient = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  privateKey,
  ['https://www.googleapis.com/auth/calendar']
);

// --- RUTAS ---

// Verificación Webhook (Meta)
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// Recepción de Mensajes
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder OK rápido

  const body = req.body;

  if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const text = message.text ? message.text.body : '';

    console.log(`📩 Mensaje de ${from}: ${text}`);

    try {
      // 1. PENSAR: Gemini analiza la intención
      const aiAnalysis = await analyzeWithGemini(text);
      console.log("🧠 Análisis IA:", aiAnalysis);

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        // 2. VERIFICAR: Consultar Calendario Real
        const isFree = await checkRealAvailability(aiAnalysis.date);
        
        if (isFree) {
            finalResponse = `✅ ¡Tengo espacio libre para el ${aiAnalysis.humanDate}! ¿Te agendo de una vez?`;
            // AQUÍ AGENDARÍAMOS EL EVENTO REALMENTE EN LA FASE 5
        } else {
            finalResponse = `⚠️ Uff, justo a esa hora (${aiAnalysis.humanDate}) ya estoy ocupado. ¿Te sirve una hora después?`;
        }
      } else {
        // Charla normal
        finalResponse = aiAnalysis.reply;
      }

      // 3. RESPONDER: Enviar a WhatsApp
      await sendToWhatsApp(from, finalResponse);

    } catch (error) {
      console.error("❌ Error General:", error.message);
    }
  }
});

// --- FUNCIONES ---

async function analyzeWithGemini(userText) {
  const model = genAI.getGenerativeModel({ model: "gemini-pro" }); 
  const now = new Date().toISOString();

  const prompt = `
    Hoy es: ${now}. Eres el asistente de una barbería.
    Usuario dice: "${userText}"
    
    Tu misión:
    1. Si quiere cita, extrae la fecha y hora futura en formato ISO (YYYY-MM-DDTHH:mm:ss). Asume citas de 1 hora.
    2. Si solo saluda, responde amable y corto.
    
    Responde SOLO este JSON:
    {
      "intent": "booking" | "chat",
      "date": "ISO_DATE_STRING" (Solo si es booking, sino null),
      "humanDate": "Texto legible ej: Mañana a las 10am",
      "reply": "Tu respuesta conversacional" (Si es chat)
    }
  `;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  let text = response.text().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

async function checkRealAvailability(isoDateStart) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // +1 hora

        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID, 
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        // Si la lista de eventos está vacía, es que está libre
        return res.data.items.length === 0;

    } catch (error) {
        console.error("❌ Error en Google Calendar:", error.message);
        return false; // Ante la duda, decimos que no hay espacio
    }
}

async function sendToWhatsApp(to, textBody) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${process.env.META_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: textBody }
            }
        });
        console.log("✅ Mensaje enviado a WhatsApp");
    } catch (error) {
        console.error("❌ Error enviando WhatsApp:", error.response ? error.response.data : error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BarberBot Inteligente Listo en puerto ${PORT}`);
});
