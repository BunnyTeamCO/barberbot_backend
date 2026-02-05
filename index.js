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
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!key) return '';
  key = key.replace(/^["']|["']$/g, '');
  key = key.replace(/\\n/g, '\n');
  return key;
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
            finalResponse = `🔧 ERROR TÉCNICO:\n${availability.message}`;
        } else if (availability.status === 'busy') {
            finalResponse = `⚠️ Ya estoy ocupado el ${aiAnalysis.humanDate}. ¿Te sirve otra hora?`;
        } else {
            // 3. ¡AGENDAR REALMENTE! (NUEVO)
            // Si está libre, creamos el evento de inmediato
            const booking = await crearEventoCalendario(aiAnalysis.date, from);
            
            if (booking.status === 'success') {
                finalResponse = `✅ ¡Listo! Cita confirmada para el ${aiAnalysis.humanDate}.\n\nTe he agendado con el número ${from}.`;
            } else {
                finalResponse = `❌ Error al guardar en Google Calendar:\n${booking.error}`;
            }
        }
      } else {
        finalResponse = aiAnalysis.reply;
      }

      await sendToWhatsApp(from, finalResponse);

    } catch (error) {
      console.error("❌ Error General:", error);
    }
  }
});

// --- FUNCIONES ---
async function analyzeWithGemini(userText) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const nowCol = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    
    const prompt = `
      Eres BarberBot. Fecha actual en Colombia: ${nowCol}.
      Usuario: "${userText}"
      REGLAS:
      1. Si pide cita (ej: "quiero cita el viernes a las 10am"), extrae la fecha ISO (YYYY-MM-DDTHH:mm:ss-05:00).
      2. Si solo dice "Si", "Confirmar" o "Dale", asume que quiere confirmar lo anterior, pero como no tengo memoria, responde: "Por favor repíteme la fecha y hora completa para agendarte".
      3. Si saluda, responde amable.
      
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
        const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hora

        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true
        });

        const activeEvents = res.data.items.filter(e => e.status !== 'cancelled');
        return activeEvents.length > 0 ? { status: 'busy' } : { status: 'free' };

    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

// --- NUEVA FUNCIÓN: CREAR EVENTO ---
async function crearEventoCalendario(isoDateStart, clientPhone) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // Duración: 1 hora

        const event = {
            summary: `Cita BarberBot - Cliente ${clientPhone}`,
            description: `Agendado automáticamente por WhatsApp. Cliente: ${clientPhone}`,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
            colorId: '2' // Color verde en Google Calendar
        };

        const res = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
        });

        console.log("✅ Evento creado:", res.data.htmlLink);
        return { status: 'success', link: res.data.htmlLink };

    } catch (error) {
        console.error("❌ Error creando evento:", error);
        return { status: 'error', error: error.message };
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
app.listen(PORT, () => { console.log(`🚀 BarberBot V6 (Agendador) corriendo en puerto ${PORT}`); });
