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

const getCleanPrivateKey = () => {
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!key) return '';
  if (key.includes('-----BEGIN PRIVATE KEY-----') && key.includes('\n')) return key;
  return key.replace(/\\n/g, '\n');
};

const jwtClient = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  getCleanPrivateKey(),
  ['https://www.googleapis.com/auth/calendar']
);

// --- RUTAS ---
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const text = message.text ? message.text.body : '';

    console.log(`📩 Mensaje de ${from}: ${text}`);

    try {
      // 1. PENSAR
      const aiAnalysis = await analyzeWithGemini(text);
      console.log("🧠 IA:", JSON.stringify(aiAnalysis));

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        // 2. VERIFICAR
        const availability = await checkRealAvailability(aiAnalysis.date);
        
        if (availability.status === 'error') {
            // AQUÍ ESTÁ EL CAMBIO: Te enviará el error técnico exacto
            finalResponse = `💀 ERROR TÉCNICO EXACTO:\n${availability.rawError}`;
        } else if (availability.status === 'busy') {
            finalResponse = `⚠️ Ocupado a esa hora (${aiAnalysis.humanDate}). Intenta otra.`;
        } else {
            finalResponse = `✅ ¡Libre! ${aiAnalysis.humanDate}. ¿Agendamos?`;
        }
      } else {
        finalResponse = aiAnalysis.reply;
      }

      await sendToWhatsApp(from, finalResponse);

    } catch (error) {
      console.error("❌ Error General:", error);
      await sendToWhatsApp(from, `Error Crítico del Servidor: ${error.message}`);
    }
  }
});

// --- FUNCIONES ---
async function analyzeWithGemini(userText) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const nowCol = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    
    const prompt = `
      Eres BarberBot. Fecha en Colombia: ${nowCol}.
      Usuario: "${userText}"
      REGLA: Si pide cita, extrae fecha ISO (YYYY-MM-DDTHH:mm:ss-05:00).
      Responde JSON: { "intent": "booking"|"chat", "date": "ISO"|null, "humanDate": "Texto"|null, "reply": "Texto"|null }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { intent: "chat", reply: "Hola, ¿en qué te ayudo?" };
  }
}

async function checkRealAvailability(isoDateStart) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true
        });

        const activeEvents = res.data.items.filter(e => e.status !== 'cancelled');
        return activeEvents.length > 0 ? { status: 'busy' } : { status: 'free' };

    } catch (error) {
        console.error("❌ ERROR GOOGLE:", error);
        // Devolvemos el mensaje crudo para que lo veas en WhatsApp
        return { status: 'error', rawError: error.message }; 
    }
}

async function sendToWhatsApp(to, textBody) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`,
            headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}`, 'Content-Type': 'application/json' },
            data: { messaging_product: 'whatsapp', to: to, text: { body: textBody } }
        });
    } catch (error) { console.error("Error envío:", error.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 BarberBot V4 Debug (${PORT})`); });
