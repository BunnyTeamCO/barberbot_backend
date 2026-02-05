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
    if (text.toLowerCase() === '/reset') {
        await pool.query("DELETE FROM clients WHERE phone_number = $1", [from]);
        await sendToWhatsApp(from, "🔄 Memoria borrada. Escríbeme 'Hola'.");
        return;
    }

    // A. Identificar usuario
    let userRes = await pool.query('SELECT id, full_name, conversation_state FROM clients WHERE phone_number = $1', [from]);
    
    // B. Bienvenida
    if (userRes.rows.length === 0) {
        const newId = crypto.randomUUID();
        await pool.query("INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')", [newId, from]);
        await sendToWhatsApp(from, "💈 ¡Hola! Bienvenido a *Alpelo*.\n\nPara atenderte mejor, **¿cuál es tu nombre?**");
        return;
    }

    const user = userRes.rows[0];

    if (user.conversation_state === 'WAITING_NAME') {
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Dame un nombre real, porfa. 😉");
            return;
        }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Listo, *${cleanName}*! Ya estás registrado.\n\n¿Quieres agendar una cita o consultar tu agenda?`);
        return;
    }

    // C. MEMORIA CHAT
    await saveChatMessage(user.id, 'user', text);
    const history = await getChatHistory(user.id);

    // D. CEREBRO IA
    const clientName = user.full_name || "Amigo";
    const ai = await talkToGemini(text, clientName, history);
    console.log(`🧠 IA (${ai.intent}):`, ai.reply);

    let response = ai.reply;

    // --- LÓGICA DE INTENCIONES ---

    // 1. AGENDAR (Booking)
    if (ai.intent === 'booking' && ai.date) {
        const check = await checkCalendar(ai.date);
        if (check.status === 'busy') {
            response = `Uff ${clientName}, a esa hora (*${ai.humanDate}*) ya estoy ocupado. 😅 ¿Te sirve otra hora?`;
        } else if (check.status === 'free') {
            const booked = await saveBooking(ai.date, from, user.id, clientName);
            response = booked 
              ? `✅ ¡Agendado! Nos vemos el *${ai.humanDate}*.`
              : `Tuve un error guardando la cita.`;
        } else {
            response = `Tuve un problema técnico con la agenda: ${check.message}`;
        }
    }

    // 2. CONSULTAR (Check) - MEJORADO CON MES
    else if (ai.intent === 'check') {
        const appointments = await getUserAppointments(user.id);
        if (appointments.length > 0) {
            const lista = appointments.map(cita => {
                const dateObj = new Date(cita.start_time);
                // FORMATO COMPLETO: Viernes 3 de Febrero, 2:00 PM
                const fecha = dateObj.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' });
                const hora = dateObj.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute:'2-digit' });
                return `🗓️ *${fecha}* a las *${hora}*`;
            }).join("\n");
            response = `Aquí están tus citas, ${clientName}:\n\n${lista}`;
        } else {
            response = `No tienes citas futuras programadas. ¿Agendamos una?`;
        }
    }

    // 3. CANCELAR (Cancel)
    else if (ai.intent === 'cancel') {
        const result = await cancelNextAppointment(user.id);
        response = result.success 
            ? `🗑️ Listo, cancelé tu cita del *${result.date}*.`
            : `No encontré ninguna cita pendiente para cancelar.`;
    }

    // 4. REAGENDAR (Reschedule)
    else if (ai.intent === 'reschedule' && ai.date) {
        const check = await checkCalendar(ai.date);
        if (check.status === 'busy') {
            response = `No puedo moverla a las *${ai.humanDate}* porque ya estoy ocupado. Busca otro hueco.`;
        } else {
            const result = await rescheduleNextAppointment(user.id, ai.date);
            if (result.success) {
                response = `🔄 ¡Hecho! Moví tu cita para el *${ai.humanDate}*.`;
            } else if (result.reason === 'no_appointment') {
                response = `No tienes ninguna cita vieja para mover. ¿Quieres agendar una nueva?`;
            } else {
                response = `Tuve un error técnico moviendo la cita.`;
            }
        }
    }

    await sendToWhatsApp(from, response);
    await saveChatMessage(user.id, 'assistant', response);

  } catch (error) {
    console.error("❌ ERROR CRÍTICO:", error.message);
  }
});

// --- 3. GESTIÓN DE CITAS ---

async function getUserAppointments(clientId) {
    try {
        const res = await pool.query(
            `SELECT start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 3`,
            [clientId]
        );
        return res.rows;
    } catch (e) { return []; }
}

async function cancelNextAppointment(clientId) {
    try {
        const res = await pool.query(
            `SELECT id, google_event_id, start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`,
            [clientId]
        );
        if (res.rows.length === 0) return { success: false };
        const cita = res.rows[0];

        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        try {
            await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: cita.google_event_id });
        } catch (err) {}

        await pool.query(`DELETE FROM appointments WHERE id = $1`, [cita.id]);
        
        const dateStr = new Date(cita.start_time).toLocaleString('es-CO', { timeZone: 'America/Bogota', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return { success: true, date: dateStr };
    } catch (e) { return { success: false }; }
}

async function rescheduleNextAppointment(clientId, newIsoDate) {
    try {
        const res = await pool.query(
            `SELECT id, google_event_id FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`,
            [clientId]
        );
        if (res.rows.length === 0) return { success: false, reason: 'no_appointment' };
        
        const cita = res.rows[0];
        const start = new Date(newIsoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        await calendar.events.patch({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            eventId: cita.google_event_id,
            resource: { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
        });

        await pool.query(
            `UPDATE appointments SET start_time = $1, end_time = $2 WHERE id = $3`,
            [start.toISOString(), end.toISOString(), cita.id]
        );
        return { success: true };
    } catch (e) { return { success: false, reason: 'error' }; }
}

async function saveChatMessage(clientId, role, content) {
    try { await pool.query("INSERT INTO chat_history (client_id, role, content) VALUES ($1, $2, $3)", [clientId, role, content]); } catch (e) {}
}

async function getChatHistory(clientId) {
    try {
        const res = await pool.query("SELECT role, content FROM chat_history WHERE client_id = $1 ORDER BY created_at DESC LIMIT 6", [clientId]);
        return res.rows.reverse().map(m => `${m.role==='user'?'Cliente':'Barbero'}: ${m.content}`).join("\n");
    } catch (e) { return ""; }
}

// --- 4. CEREBRO IA (PERFECCIONADO) ---

async function talkToGemini(userInput, userName, history) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres el dueño de la barbería "Alpelo" en Colombia. Cliente: ${userName}. Hora: ${now}.
            HISTORIAL: ${history}
            CLIENTE: "${userInput}"

            INTENCIONES:
            - "booking": Cita nueva con fecha/hora específica.
            - "check": Pregunta por sus citas ("¿cuándo tengo cita?", "¿qué día es?", "¿de qué mes?"). SI PREGUNTA DETALLES DE UNA CITA, ES CHECK.
            - "cancel": Borrar cita.
            - "reschedule": Cambiar cita.
            - "chat": Saludos, gracias, o mensajes sin intención clara.

            REGLA DE ORO:
            - Si el cliente pregunta "¿De qué mes?" o "¿A qué hora?", clasifícalo como "check". Así yo (el sistema) le daré la fecha completa.
            - NO inventes fechas en el campo 'reply'. Si es 'check', deja que el sistema responda.

            JSON:
            {
                "intent": "booking" | "check" | "cancel" | "reschedule" | "chat",
                "date": "YYYY-MM-DDTHH:mm:ss-05:00" (Para booking/reschedule),
                "humanDate": "Texto legible (ej: Viernes 3 de Febrero 3pm)",
                "reply": "Respuesta natural"
            }
        `;

        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    } catch (e) {
        return { intent: "chat", reply: `Cuéntame ${userName}, ¿en qué te ayudo?` };
    }
}

// --- 5. AUXILIARES ---
async function checkCalendar(isoDate) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        const res = await calendar.events.list({ calendarId: process.env.GOOGLE_CALENDAR_ID, timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true });
        const conflicts = res.data.items.filter(e => e.status !== 'cancelled' && e.transparency !== 'transparent');
        return conflicts.length > 0 ? { status: 'busy' } : { status: 'free' };
    } catch (e) { return { status: 'error', message: e.message }; }
}

async function saveBooking(isoDate, phone, userId, name) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        const gRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: { summary: `Cita: ${name}`, description: `WhatsApp: ${phone}`, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, colorId: '2' }
        });
        await pool.query("INSERT INTO appointments (id, client_id, start_time, end_time, google_event_id) VALUES ($1, $2, $3, $4, $5)", [crypto.randomUUID(), userId, start.toISOString(), end.toISOString(), gRes.data.id]);
        return true;
    } catch (e) { return false; }
}

async function sendToWhatsApp(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, {
            messaging_product: 'whatsapp', to, text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } });
    } catch (e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V26 (Precisión) Online`));
