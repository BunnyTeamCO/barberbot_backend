require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json());

// --- 1. CONFIGURACIÓN ROBUSTA DE LLAVES ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// FUNCIÓN MÁGICA: Limpia la llave privada sin importar cómo se pegó
const getCleanPrivateKey = () => {
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!key) return '';
  
  // Si ya tiene saltos de línea reales, devolverla tal cual
  if (key.includes('-----BEGIN PRIVATE KEY-----') && key.includes('\n')) {
    return key;
  }
  
  // Si está todo en una línea con "\n" literal, convertirlo
  return key.replace(/\\n/g, '\n');
};

const jwtClient = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  getCleanPrivateKey(),
  ['https://www.googleapis.com/auth/calendar']
);

// --- 2. RUTAS ---
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
      // PENSAR
      const aiAnalysis = await analyzeWithGemini(text);
      console.log("🧠 Análisis IA:", JSON.stringify(aiAnalysis));

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        // VERIFICAR CALENDARIO
        const availability = await checkRealAvailability(aiAnalysis.date);
        
        if (availability.status === 'error') {
            finalResponse = `🔧 **Error Técnico:** \n${availability.message}`;
        } else if (availability.status === 'busy') {
            finalResponse = `😅 Uff, justo a esa hora (${aiAnalysis.humanDate}) ya estoy ocupado. ¿Te sirve una hora más tarde?`;
        } else {
            finalResponse = `✅ ¡Sí! Tengo espacio libre para el ${aiAnalysis.humanDate}. ¿Te lo aparto de una vez?`;
        }
      } else {
        // CHARLA
        finalResponse = aiAnalysis.reply;
      }

      await sendToWhatsApp(from, finalResponse);

    } catch (error) {
      console.error("❌ Error Crítico:", error);
    }
  }
});

// --- 3. FUNCIONES ---

async function analyzeWithGemini(userText) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const nowCol = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    
    const prompt = `
      Eres BarberBot, asistente de una barbería en Colombia.
      Fecha actual: ${nowCol}.
      Usuario dice: "${userText}"
      
      REGLAS:
      1. Si el usuario pide cita (ej: "mañana a las 10am"), extrae la fecha ISO (YYYY-MM-DDTHH:mm:ss-05:00).
      2. Si solo saluda, responde amable y corto. NO inventes fechas.
      
      Responde SOLO JSON:
      {
        "intent": "booking" | "chat",
        "date": "ISO_STRING" (o null),
        "humanDate": "Ej: Viernes 10am" (o null),
        "reply": "Respuesta" (o null)
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { intent: "chat", reply: "Hola, ¿en qué te puedo ayudar hoy?" };
  }
}

async function checkRealAvailability(isoDateStart) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hora

        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true
        });

        // Filtrar eventos cancelados
        const activeEvents = res.data.items.filter(e => e.status !== 'cancelled');

        if (activeEvents.length > 0) {
            return { status: 'busy' };
        }
        return { status: 'free' };

    } catch (error) {
        console.error("❌ Error Calendario:", error.message);
        
        // Diagnóstico preciso para el usuario
        let msg = "No pude conectar al calendario.";
        if (error.message.includes("PEM routines")) msg = "❌ Error: La llave privada (PRIVATE KEY) sigue teniendo formato incorrecto.";
        if (error.message.includes("Not Found")) msg = `❌ Error: No encuentro el calendario o el email del robot (${process.env.GOOGLE_CLIENT_EMAIL}) no tiene permiso.`;
        
        return { status: 'error', message: msg };
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
    } catch (error) {
        console.error("Error envío WhatsApp", error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BarberBot Final (Key Fix) puerto ${PORT}`);
});
