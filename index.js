require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

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
  if (!body.object || !body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) return;

  const message = body.entry[0].changes[0].value.messages[0];
  const from = message.from; 
  const text = (message.text ? message.text.body : '').trim();

  try {
    // COMANDO RESET (Para pruebas)
    if (text.toLowerCase() === '/reset') {
        await pool.query("DELETE FROM clients WHERE phone_number = $1", [from]);
        await sendToWhatsApp(from, "🔄 Memoria borrada. Escríbeme 'Hola' para empezar.");
        return;
    }

    // A. Buscar usuario en la base de datos
    const userResult = await pool.query('SELECT full_name, conversation_state FROM clients WHERE phone_number = $1', [from]);
    
    // B. FLUJO DE BIENVENIDA ESTRICTO
    if (userResult.rows.length === 0) {
        // No existe: Lo creamos y pedimos nombre
        await pool.query("INSERT INTO clients (phone_number, conversation_state) VALUES ($1, 'WAITING_NAME')", [from]);
        await sendToWhatsApp(from, "💈 ¡Hola! Bienvenido a *Alpelo*.\n\nSoy tu asistente virtual. Antes de empezar, **¿me regalas tu nombre?**");
        return;
    }

    const user = userResult.rows[0];

    if (user.conversation_state === 'WAITING_NAME') {
        // Estamos esperando el nombre
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Dime un nombre un poco más largo para registrarte bien. 😉");
            return;
        }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Qué nota saludarte, *${cleanName}*! 🤝 Ya te tengo en mi sistema.\n\nCuéntame, ¿qué día quieres venir a motilarte?`);
        return;
    }

    // C. FLUJO DE IA (Solo si ya es ACTIVE y tiene nombre)
    const clientName = user.full_name;
    const ai = await talkToGemini(text, clientName);
    console.log("🧠 IA Analizó:", JSON.stringify(ai));

    let finalReply = ai.reply;

    if (ai.intent === 'booking' && ai.date) {
        const isFree = await checkAvailability(ai.date);
        if (isFree === 'busy') {
            finalReply = `Uff ${clientName}, justo a esa hora (${ai.humanDate}) ya estoy ocupado. 😅 ¿Te sirve otra hora?`;
        } else if (isFree === 'free') {
            const booked = await finalizeBooking(ai.date, from, clientName);
            if (booked) {
                finalReply = `✅ ¡Todo listo, *${clientName}*! Agendado para el *${ai.humanDate}*. ¡Allá nos vemos!`;
            } else {
                finalReply = `Lo siento, no pude guardar la cita en mi agenda. 😞`;
            }
        } else {
            finalReply = `Tuve un problema revisando mi calendario. Intenta de nuevo en un minuto.`;
        }
    }

    await sendToWhatsApp(from, finalReply);

  } catch (error) {
    console.error("❌ ERROR:", error);
    await sendToWhatsApp(from, "Lo siento, tuve un error interno. 😵‍💫 ¿Puedes repetirme eso?");
  }
});

// --- 3. FUNCIONES AUXILIARES ---

async function talkToGemini(userInput, userName) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres el barbero dueño de la barbería "Alpelo" en Colombia. 
            Cliente: ${userName}. Hora actual: ${now}.
            El cliente dice: "${userInput}"

            ESTILO:
            - Sé muy amable y "parcero" (estilo colombiano: qué nota, de una, un gusto).
            - Si pide cita, extrae la fecha.
            - Si solo saluda o agradece, sé natural y no repitas frases de robot.

            FORMATO JSON:
            {
                "intent": "booking" | "chat",
                "date": "YYYY-MM-DDTHH:mm:ss-05:00" (o null),
                "humanDate": "Texto legible",
                "reply": "Tu respuesta amable"
            }
        `;

        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    } catch (e) {
        return { intent: "chat", reply: `¡Qué hubo ${userName}! ¿En qué te colaboro?` };
    }
}

async function checkAvailability(isoDate) {
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
        return res.data.items.filter(e => e.status !== 'cancelled').length > 0 ? 'busy' : 'free';
    } catch (e) { return 'error'; }
}

async function finalizeBooking(isoDate, phone, name) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        const event = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: {
                summary: `Cita: ${name}`,
                description: `WhatsApp: ${phone}`,
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
                colorId: '2'
            }
        });

        const client = await pool.query('SELECT id FROM clients WHERE phone_number = $1', [phone]);
        await pool.query(
            "INSERT INTO appointments (client_id, start_time, end_time, google_event_id) VALUES ($1, $2, $3, $4)",
            [client.rows[0].id, start.toISOString(), end.toISOString(), event.data.id]
        );
        return true;
    } catch (e) { return false; }
}

async function sendToWhatsApp(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, {
            messaging_product: 'whatsapp', to, text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } });
    } catch (e) { console.error("Error WhatsApp:", e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V14 Listo`));
