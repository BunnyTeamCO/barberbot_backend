require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json());

// --- 1. CONFIGURACIÓN ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const privateKey = process.env.GOOGLE_PRIVATE_KEY 
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') 
  : '';

const jwtClient = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  privateKey,
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

  if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const text = message.text ? message.text.body : '';

    console.log(`📩 Mensaje de ${from}: ${text}`);

    try {
      const aiAnalysis = await analyzeWithGemini(text);
      console.log("🧠 Análisis IA:", JSON.stringify(aiAnalysis, null, 2));

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        // Verificar disponibilidad con la fecha exacta que dio la IA
        const isFree = await checkRealAvailability(aiAnalysis.date);
        
        if (isFree) {
            finalResponse = `✅ ¡Sí! Tengo espacio libre para el ${aiAnalysis.humanDate}. ¿Quieres que te agende? (Responde SI para confirmar)`;
        } else {
            finalResponse = `⚠️ Lo siento, justo a esa hora (${aiAnalysis.humanDate}) ya aparece ocupado en mi agenda. ¿Te sirve otra hora?`;
        }
      } else {
        finalResponse = aiAnalysis.reply;
      }

      await sendToWhatsApp(from, finalResponse);

    } catch (error) {
      console.error("❌ Error General:", error.message);
      // No enviamos error al usuario para no spamear si es un error interno
    }
  }
});

// --- 3. FUNCIONES INTELIGENTES ---

async function analyzeWithGemini(userText) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    
    // TRUCO 1: Obtener la hora actual en COLOMBIA
    const nowCol = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    
    const prompt = `
      Actúa como el asistente de una barbería en Colombia.
      Fecha y hora actual en Colombia: ${nowCol}.
      Usuario dice: "${userText}"
      
      Instrucciones:
      1. Si quiere cita, calcula la fecha futura exacta basándote en la hora actual de Colombia.
      2. IMPORTANTE: La fecha 'date' debe estar en formato ISO 8601 con el offset de Colombia (-05:00). Ejemplo: "2024-02-05T14:00:00-05:00".
      3. Asume que las citas duran 1 hora.
      
      Responde SOLO este JSON:
      {
        "intent": "booking" | "chat",
        "date": "YYYY-MM-DDTHH:mm:ss-05:00" (o null),
        "humanDate": "Texto amigable ej: Mañana Jueves a las 2pm",
        "reply": "Respuesta corta" (si no es booking)
      }
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("Error Gemini:", e);
    return { intent: "chat", reply: "Hola, ¿en qué te puedo ayudar?" };
  }
}

async function checkRealAvailability(isoDateStart) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        // Convertir la fecha ISO a objeto Date
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // +1 Hora

        console.log(`📅 Buscando conflictos entre: ${start.toISOString()} y ${end.toISOString()}`);

        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID, 
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        // TRUCO 2: Filtrar eventos que no estén cancelados
        // A veces la API devuelve eventos borrados, hay que ignorarlos.
        const activeEvents = res.data.items.filter(event => event.status !== 'cancelled');

        if (activeEvents.length > 0) {
            console.log("⚠️ Conflicto encontrado:", activeEvents[0].summary);
            return false; // Ocupado
        }

        return true; // Libre

    } catch (error) {
        console.error("❌ Error Google Calendar:", error.message);
        return false; 
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
        console.error("❌ Error WhatsApp:", error.response ? error.response.data : error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BarberBot Hora Colombia Activo (${PORT})`);
});
