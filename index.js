require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const crypto = require('crypto');

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

// --- 2. RUTAS WEBHOOK ---
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

  try {
    // COMANDO RESET
    if (text.toLowerCase() === '/reset') {
        await pool.query("DELETE FROM clients WHERE phone_number = $1", [from]);
        await sendToWhatsApp(from, "🔄 Memoria borrada. Escríbeme 'Hola' para empezar.");
        return;
    }

    // A. Identificar usuario (Con manejo de error si la columna no existe)
    let user = null;
    try {
        const userRes = await pool.query('SELECT id, full_name, conversation_state FROM clients WHERE phone_number = $1', [from]);
        if (userRes.rows.length > 0) {
            user = userRes.rows[0];
        }
    } catch (dbError) {
        console.error("Error leyendo tabla clients:", dbError.message);
        await sendToWhatsApp(from, "🔧 Estoy teniendo un problema con mi base de datos. Por favor, avísale al administrador que falta la columna 'conversation_state'.");
        return;
    }

    // B. FLUJO DE BIENVENIDA
    if (!user) {
        const newId = crypto.randomUUID();
        await pool.query(
            "INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')",
            [newId, from]
        );
        await sendToWhatsApp(from, "👋 ¡Hola! Bienvenido a *Alpelo*.\n\nQué nota saludarte. Antes de empezar, **¿cómo es tu nombre?**");
        return;
    }

    // C. CAPTURAR NOMBRE
    if (user.conversation_state === 'WAITING_NAME') {
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Dime un nombre un poco más largo para registrarte bien. 😉");
            return;
        }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Qué nota saludarte, *${cleanName}*! 🤝 Ya te registré.\n\n¿Para cuándo quieres agendar tu cita? O si tienes dudas, ¡dispara!`);
        return;
    }

    // D. CHAT CON IA
    const ai = await talkToGemini(text, user.full_name || "Amigo");
    console.log(`🧠 IA responde a ${user.full_name}: ${ai.intent}`);

    let response = ai.reply;

    if (ai.intent === 'booking' && ai.date) {
        const calendarStatus = await checkCalendar(ai.date);
        if (calendarStatus === 'busy') {
            response = `Uff ${user.full_name}, esa hora ya la tengo ocupada. 😅 ¿Te sirve un poquito más tarde?`;
        } else if (calendarStatus === 'free') {
            const booked = await saveBooking(ai.date, from, user.id, user.full_name);
            response = booked 
              ? `✅ ¡Listo, *${user.full_name}*! Agendado para el *${ai.humanDate}*. ¡Allá nos vemos!`
              : `Lo siento, no pude guardar la cita. Intenta de nuevo.`;
        }
    }

    await sendToWhatsApp(from, response);

  } catch (error) {
    console.error("❌ ERROR CRÍTICO:", error.message);
  }
});

// --- FUNCIONES IA ---

async function talkToGemini(userInput, userName) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres el barbero dueño de la barbería "Alpelo" en Colombia. 
            Cliente: ${userName}. Hora actual: ${now}.
            El cliente dice: "${userInput}"

            INSTRUCCIONES:
            - Habla como un barbero amable: "parcero", "qué nota", "de una".
            - Si quiere cita, extrae fecha y hora.
            - Responde JSON: { "intent": "booking"|"chat", "date": "ISO"|null, "humanDate": "Texto", "reply": "Respuesta" }
        `;

        const result = await model.generateContent(prompt);
        const resText = result.response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(resText);
    } catch (e) {
        return { intent: "chat", reply: `¡Qué hubo! ¿En qué te colaboro hoy?` };
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
app.listen(PORT, () => console.log(`🚀 BarberBot V17 Online`));
