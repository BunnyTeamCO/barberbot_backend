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
    // RESET
    if (text.toLowerCase() === '/reset') {
        await pool.query("DELETE FROM clients WHERE phone_number = $1", [from]); // El cascade borra el historial también
        await sendToWhatsApp(from, "🔄 Memoria borrada. Escríbeme 'Hola'.");
        return;
    }

    // A. Identificar usuario
    let userRes = await pool.query('SELECT id, full_name, conversation_state FROM clients WHERE phone_number = $1', [from]);
    let user = userRes.rows[0];

    // B. BIENVENIDA (Sin memoria aún)
    if (!user) {
        const newId = crypto.randomUUID();
        await pool.query("INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')", [newId, from]);
        await sendToWhatsApp(from, "💈 ¡Hola! Bienvenido a *Alpelo*.\n\nPara atenderte mejor, **¿cuál es tu nombre?**");
        return;
    }

    // C. CAPTURAR NOMBRE
    if (user.conversation_state === 'WAITING_NAME') {
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Porfa dame un nombre válido para registrarte. 😉");
            return;
        }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Listo, *${cleanName}*! Ya estás registrado.\n\n¿En qué te puedo ayudar hoy?`);
        return;
    }

    // D. CHAT CON MEMORIA 🧠
    
    // 1. Guardar mensaje del usuario en historial
    await saveChatMessage(user.id, 'user', text);

    // 2. Recuperar últimos 6 mensajes para contexto
    const history = await getChatHistory(user.id);

    // 3. Consultar a Gemini con contexto
    const clientName = user.full_name || "Amigo";
    const ai = await talkToGemini(text, clientName, history);
    console.log(`🧠 IA (${clientName}): ${ai.intent}`);

    let response = ai.reply;

    // Lógica de Citas
    if (ai.intent === 'booking' && ai.date) {
        const calendarStatus = await checkCalendar(ai.date);
        if (calendarStatus === 'busy') {
            response = `Uff ${clientName}, a esa hora (${ai.humanDate}) ya estoy ocupado. 😅 ¿Te sirve otra?`;
        } else if (calendarStatus === 'free') {
            const booked = await saveBooking(ai.date, from, user.id, clientName);
            response = booked 
              ? `✅ ¡Agendado, *${clientName}*! Nos vemos el *${ai.humanDate}*.`
              : `Tuve un error guardando la cita. Intenta de nuevo.`;
        } else {
            response = `Tuve un problema técnico con la agenda. Intenta en un minuto.`;
        }
    }

    // 4. Enviar y Guardar respuesta del bot
    await sendToWhatsApp(from, response);
    await saveChatMessage(user.id, 'assistant', response);

  } catch (error) {
    console.error("❌ ERROR:", error.message);
  }
});

// --- 3. FUNCIONES DE MEMORIA (NUEVO) ---

async function saveChatMessage(clientId, role, content) {
    try {
        await pool.query(
            "INSERT INTO chat_history (client_id, role, content) VALUES ($1, $2, $3)",
            [clientId, role, content]
        );
    } catch (e) { console.error("Error guardando chat:", e.message); }
}

async function getChatHistory(clientId) {
    try {
        // Traer últimos 6 mensajes ordenados cronológicamente
        const res = await pool.query(
            "SELECT role, content FROM chat_history WHERE client_id = $1 ORDER BY created_at DESC LIMIT 6",
            [clientId]
        );
        // Invertir para que estén en orden de lectura (antiguo -> nuevo)
        const rows = res.rows.reverse();
        
        // Formatear para Gemini
        let historyText = "";
        rows.forEach(msg => {
            historyText += `${msg.role === 'user' ? 'Cliente' : 'Barbero'}: ${msg.content}\n`;
        });
        return historyText;
    } catch (e) { return ""; }
}

// --- 4. CEREBRO CONTEXTUAL ---

async function talkToGemini(userInput, userName, history) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres el dueño de la barbería "Alpelo" en Colombia.
            Cliente: ${userName}.
            Hora actual: ${now}.

            HISTORIAL DE CONVERSACIÓN RECIENTE:
            ${history}
            
            Cliente dice ahora: "${userInput}"

            INSTRUCCIONES DE PERSONALIDAD:
            - Responde de forma fluida basándote en el historial. NO saludes de nuevo si ya nos saludamos hace poco.
            - Si el cliente tiene dudas, respóndele directo y corto.
            - Usa lenguaje colombiano natural (parcero, listo, de una).
            - Sé breve. Máximo 2 frases.

            FORMATO JSON OBLIGATORIO:
            {
                "intent": "booking" | "chat",
                "date": "ISO_DATE" (si pide cita),
                "humanDate": "Texto legible",
                "reply": "Tu respuesta contextual"
            }
        `;

        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    } catch (e) {
        return { intent: "chat", reply: `Claro ${userName}, cuéntame.` };
    }
}

// --- 5. AUXILIARES ---

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
        return res.data.items.filter(e => e.status !== 'cancelled').length > 0 ? 'busy' : 'free';
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
app.listen(PORT, () => console.log(`🚀 BarberBot V21 (Memoria) Online`));
