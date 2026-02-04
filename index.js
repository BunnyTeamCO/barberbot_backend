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

// Limpieza de la llave privada (Corrige errores comunes de copiado)
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

// Verificación Webhook (Lo que pide Meta)
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// Recepción de Mensajes (El Cerebro)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder OK rápido a Meta

  const body = req.body;

  // Verificar si es un mensaje de texto válido
  if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const text = message.text ? message.text.body : '';

    console.log(`📩 Mensaje de ${from}: ${text}`);

    try {
      // A. PENSAR: Gemini analiza la intención
      const aiAnalysis = await analyzeWithGemini(text);
      console.log("🧠 Análisis IA:", aiAnalysis);

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        // B. VERIFICAR: Consultar Calendario Real
        const isFree = await checkRealAvailability(aiAnalysis.date);
        
        if (isFree) {
            // C. RESPONDER: Disponible
            finalResponse = `✅ ¡Sí! Tengo espacio libre para el ${aiAnalysis.humanDate}. ¿Quieres que te agende? (Responde SI para confirmar)`;
            // NOTA: Aquí agregaríamos la lógica de "crear evento" en el siguiente paso
        } else {
            // C. RESPONDER: Ocupado
            finalResponse = `⚠️ Lo siento, justo a esa hora (${aiAnalysis.humanDate}) ya tengo una cita. ¿Te sirve una hora más tarde?`;
        }
      } else {
        // Conversación normal (Hola, precios, etc.)
        finalResponse = aiAnalysis.reply;
      }

      // D. ENVIAR: WhatsApp
      await sendToWhatsApp(from, finalResponse);

    } catch (error) {
      console.error("❌ Error General:", error.message);
      await sendToWhatsApp(from, "Tuve un pequeño error técnico, ¿puedes repetir?");
    }
  }
});

// --- 3. FUNCIONES AUXILIARES ---

async function analyzeWithGemini(userText) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const now = new Date().toISOString();

    const prompt = `
      Hoy es: ${now}. Eres BarberBot, un asistente útil.
      Usuario dice: "${userText}"
      
      Instrucciones:
      1. Si el usuario pide una cita específica (ej: "mañana a las 4pm"), extrae la fecha en formato ISO (YYYY-MM-DDTHH:mm:ss).
      2. Si solo saluda, pregunta precios o dudas, responde amable y corto (máximo 2 frases).
      
      Responde SOLO este JSON sin markdown:
      {
        "intent": "booking" o "chat",
        "date": "ISO_DATE_STRING" (o null),
        "humanDate": "Texto legible ej: Mañana 4pm" (o null),
        "reply": "Texto de respuesta" (o null)
      }
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("Error Gemini:", e);
    return { intent: "chat", reply: "Hola, ¿en qué te puedo ayudar hoy?" };
  }
}

async function checkRealAvailability(isoDateStart) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // Citas de 1 hora

        console.log(`📅 Verificando agenda: ${start.toISOString()} - ${end.toISOString()}`);

        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID, 
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        // Si la lista está vacía, está libre. Si tiene eventos, está ocupado.
        return res.data.items.length === 0;

    } catch (error) {
        console.error("❌ Error Google Calendar:", error.message);
        return false; // Ante error, asumimos ocupado por seguridad
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
        console.log(`✅ Respondido a ${to}`);
    } catch (error) {
        console.error("❌ Error enviando WhatsApp:", error.response ? error.response.data : error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BarberBot INTELIGENTE Online en puerto ${PORT}`);
});
