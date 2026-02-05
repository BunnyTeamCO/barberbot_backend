require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const crypto = require('crypto'); // Nativo de Node.js, no necesita instalarse

const app = express();
app.use(bodyParser.json());

// --- 1. CONFIGURACIÓN ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false 
});

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

// --- 2. WEBHOOK ---
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
  if (!body.object || !body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return;

  const message = body.entry[0].changes[0].value.messages[0];
  const from = message.from; 
  const text = (message.text ? message.text.body : '').trim();

  let currentStep = "Iniciando";

  try {
    // COMANDO RESET
    if (text.toLowerCase() === '/reset') {
        currentStep = "Reseteando usuario";
        await pool.query("DELETE FROM clients WHERE phone_number = $1", [from]);
        await sendToWhatsApp(from, "🔄 Memoria borrada. Escríbeme 'Hola' para empezar.");
        return;
    }

    // PASO 1: Buscar usuario
    currentStep = "Buscando usuario en la base de datos";
    const userRes = await pool.query('SELECT id, full_name, conversation_state FROM clients WHERE phone_number = $1', [from]);
    
    // PASO 2: Registro si es nuevo
    if (userRes.rows.length === 0) {
        currentStep = "Registrando nuevo usuario";
        const newId = crypto.randomUUID(); // Generación nativa segura
        await pool.query(
            "INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')",
            [newId, from]
        );
        await sendToWhatsApp(from, "💈 ¡Hola! Bienvenido a *Alpelo*.\n\nQué nota saludarte. Antes de empezar, **¿cómo es tu nombre?**");
        return;
    }

    const user = userRes.rows[0];

    // PASO 3: Capturar nombre si está pendiente
    if (user.conversation_state === 'WAITING_NAME') {
        currentStep = "Guardando nombre del usuario";
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Dime un nombre un poco más largo, ¡no seas tímido! 😉");
            return;
        }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Qué nota, *${cleanName}*! 🤝 Ya te registré.\n\n¿Qué día quieres venir a motilarte? O si tienes dudas, ¡dime!`);
        return;
    }

    // PASO 4: Consultar a Gemini (IA)
    currentStep = "Consultando a la Inteligencia Artificial";
    const ai = await talkToGemini(text, user.full_name);
    console.log(`🧠 [${user.full_name}]: ${text} -> ${ai.intent}`);

    let response = ai.reply;

    // PASO 5: Lógica de Citas
    if (ai.intent === 'booking' && ai.date) {
        currentStep = "Verificando disponibilidad en Google Calendar";
        const calendarStatus = await checkCalendar(ai.date);
        
        if (calendarStatus === 'busy') {
            response = `Uff ${user.full_name}, esa hora ya la tengo ocupada. 😅 ¿Te sirve un poquito más tarde?`;
        } else if (calendarStatus === 'free') {
            currentStep = "Guardando cita en Calendario y Base de Datos";
            const booked = await saveBooking(ai.date, from, user.id, user.full_name);
            response = booked 
              ? `✅ ¡Listo, *${user.full_name}*! Agendado para el *${ai.humanDate}*. ¡Allá nos vemos!`
              : `Lo siento, no pude guardar la cita. Intenta de nuevo.`;
        } else {
            response = `Tuve un lío técnico con el calendario. ¿Podemos intentar en un minuto?`;
        }
    }

    // PASO 6: Enviar respuesta final
    currentStep = "Enviando respuesta por WhatsApp";
    await sendToWhatsApp(from, response);

  } catch (error) {
    console.error(`❌ ERROR en paso [${currentStep}]:`, error.message);
    // Enviar error detallado al usuario para diagnosticar
    const errorMsg = `⚠️ Error en sistema:\nFallo en: *${currentStep}*\nDetalle: ${error.message}`;
    await sendToWhatsApp(from, errorMsg);
  }
});

// --- FUNCIONES IA ---

async function talkToGemini(userInput, userName) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres el barbero y dueño de la barbería "Alpelo" en Colombia. 
            Cliente: ${userName}. Hora actual: ${now}.
            Él te dice: "${userInput}"

            INSTRUCCIONES:
            - Habla como un barbero amable: "parcero", "qué nota", "de una".
            - Si quiere cita, extrae fecha y hora.
            - Responde JSON: { "intent": "booking"|"chat", "date": "ISO"|null, "humanDate": "Texto", "reply": "Respuesta" }
        `;

        const result = await model.generateContent(prompt);
        const resText = result.response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(resText);
    } catch (e) {
        throw new Error(`Error en Gemini: ${e.message}`);
    }
}

// --- FUNCIONES AUXILIARES ---

async function checkCalendar(isoDate) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true
        });
        const active = res.data.items.filter(e => e.status !== 'cancelled');
        return active.length > 0 ? 'busy' : 'free';
    } catch (e) { return 'error'; }
}

async function saveBooking(isoDate, phone, userId, name) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        const gRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: {
                summary: `Cita: ${name}`,
                description: `WhatsApp: ${phone}`,
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
                colorId: '2'
            }
        });

        await pool.query(
            "INSERT INTO appointments (id, client_id, start_time, end_time, google_event_id) VALUES ($1, $2, $3, $4, $5)",
            [crypto.randomUUID(), userId, start.toISOString(), end.toISOString(), gRes.data.id]
        );
        return true;
    } catch (e) { 
        return false; 
    }
}

async function sendToWhatsApp(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, {
            messaging_product: 'whatsapp', to, text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } });
    } catch (e) { console.error("Error WhatsApp:", e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V16 (Diagnóstico) en ${PORT}`));
