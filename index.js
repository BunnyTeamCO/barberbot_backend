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
        await sendToWhatsApp(from, "🔄 Memoria borrada.");
        return;
    }

    // A. Identificar usuario
    let userRes = await pool.query('SELECT id, full_name, conversation_state FROM clients WHERE phone_number = $1', [from]);
    let user = userRes.rows[0];

    // B. Bienvenida
    if (!user) {
        const newId = crypto.randomUUID();
        await pool.query("INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')", [newId, from]);
        await sendToWhatsApp(from, "💈 ¡Hola! Bienvenido a *Alpelo*.\n\nPara atenderte mejor, **¿cuál es tu nombre?**");
        return;
    }

    if (user.conversation_state === 'WAITING_NAME') {
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Dame un nombre real, porfa. 😉");
            return;
        }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Listo, *${cleanName}*! Ya estás registrado.\n\n¿Quieres agendar, consultar o cancelar una cita?`);
        return;
    }

    // C. MEMORIA DE CHAT
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
        const calendarStatus = await checkCalendar(ai.date);
        if (calendarStatus === 'busy') {
            response = `Uff ${clientName}, a esa hora ya estoy ocupado. 😅 ¿Te sirve otra?`;
        } else if (calendarStatus === 'free') {
            const booked = await saveBooking(ai.date, from, user.id, clientName);
            response = booked 
              ? `✅ ¡Agendado! Nos vemos el *${ai.humanDate}*.`
              : `Tuve un error guardando la cita.`;
        }
    }

    // 2. CONSULTAR (Check)
    else if (ai.intent === 'check') {
        const appointments = await getUserAppointments(user.id);
        if (appointments.length > 0) {
            const lista = appointments.map(cita => {
                const dateObj = new Date(cita.start_time);
                return `🗓️ *${dateObj.toLocaleDateString('es-CO')}* a las *${dateObj.toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit'})}*`;
            }).join("\n");
            response = `Aquí están tus citas pendientes:\n\n${lista}`;
        } else {
            response = `No tienes citas futuras programadas. ¿Agendamos una?`;
        }
    }

    // 3. CANCELAR (Cancel) - ¡NUEVO!
    else if (ai.intent === 'cancel') {
        const result = await cancelNextAppointment(user.id);
        response = result.success 
            ? `🗑️ Listo ${clientName}, he cancelado tu cita del *${result.date}*.`
            : `No encontré ninguna cita pendiente para cancelar.`;
    }

    // 4. REAGENDAR (Reschedule) - ¡NUEVO!
    else if (ai.intent === 'reschedule' && ai.date) {
        // Verificar disponibilidad de la NUEVA fecha
        const calendarStatus = await checkCalendar(ai.date);
        if (calendarStatus === 'busy') {
            response = `No puedo cambiarla a esa hora (${ai.humanDate}) porque ya estoy ocupado. Intenta otro horario.`;
        } else {
            // Intentar mover la cita
            const result = await rescheduleNextAppointment(user.id, ai.date);
            if (result.success) {
                response = `🔄 ¡Hecho! Moví tu cita anterior para el *${ai.humanDate}*.`;
            } else if (result.reason === 'no_appointment') {
                response = `No encontré ninguna cita vieja para mover. ¿Quieres agendar una nueva?`;
            } else {
                response = `Tuve un error técnico moviendo la cita.`;
            }
        }
    }

    // Enviar y guardar respuesta
    await sendToWhatsApp(from, response);
    await saveChatMessage(user.id, 'assistant', response);

  } catch (error) {
    console.error("❌ ERROR:", error.message);
  }
});

// --- 3. FUNCIONES DE GESTIÓN DE CITAS ---

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
        // 1. Buscar la cita más próxima
        const res = await pool.query(
            `SELECT id, google_event_id, start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`,
            [clientId]
        );
        
        if (res.rows.length === 0) return { success: false };
        const cita = res.rows[0];

        // 2. Borrar de Google Calendar
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        try {
            await calendar.events.delete({
                calendarId: process.env.GOOGLE_CALENDAR_ID,
                eventId: cita.google_event_id
            });
        } catch (err) { console.error("Error borrando en Google (puede que ya no exista):", err.message); }

        // 3. Borrar de Base de Datos
        await pool.query(`DELETE FROM appointments WHERE id = $1`, [cita.id]);

        const dateStr = new Date(cita.start_time).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
        return { success: true, date: dateStr };

    } catch (e) { 
        console.error(e);
        return { success: false }; 
    }
}

async function rescheduleNextAppointment(clientId, newIsoDate) {
    try {
        // 1. Buscar cita vieja
        const res = await pool.query(
            `SELECT id, google_event_id FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`,
            [clientId]
        );
        
        if (res.rows.length === 0) return { success: false, reason: 'no_appointment' };
        const cita = res.rows[0];

        // 2. Calcular nuevos tiempos
        const start = new Date(newIsoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        // 3. Actualizar Google Calendar
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        await calendar.events.patch({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            eventId: cita.google_event_id,
            resource: {
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() }
            }
        });

        // 4. Actualizar Base de Datos
        await pool.query(
            `UPDATE appointments SET start_time = $1, end_time = $2 WHERE id = $3`,
            [start.toISOString(), end.toISOString(), cita.id]
        );

        return { success: true };

    } catch (e) {
        console.error(e);
        return { success: false, reason: 'error' };
    }
}

async function saveChatMessage(clientId, role, content) {
    try { await pool.query("INSERT INTO chat_history (client_id, role, content) VALUES ($1, $2, $3)", [clientId, role, content]); } catch (e) {}
}

async function getChatHistory(clientId) {
    try {
        const res = await pool.query("SELECT role, content FROM chat_history WHERE client_id = $1 ORDER BY created_at DESC LIMIT 5", [clientId]);
        return res.rows.reverse().map(m => `${m.role==='user'?'Cliente':'Barbero'}: ${m.content}`).join("\n");
    } catch (e) { return ""; }
}

// --- 4. CEREBRO IA ---

async function talkToGemini(userInput, userName, history) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres el dueño de la barbería "Alpelo". Cliente: ${userName}. Hora: ${now}.
            HISTORIAL: ${history}
            Cliente: "${userInput}"

            INTENCIONES:
            - "booking": Quiere cita NUEVA.
            - "check": Consulta sus citas.
            - "cancel": Quiere cancelar o borrar su cita.
            - "reschedule": Quiere cambiar, mover o posponer su cita (extrae la NUEVA fecha deseada).
            - "chat": Saludos, dudas.

            JSON OBLIGATORIO:
            {
                "intent": "booking" | "check" | "cancel" | "reschedule" | "chat",
                "date": "ISO_DATE" (para booking/reschedule),
                "humanDate": "Texto fecha",
                "reply": "Respuesta contextual"
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
        const res = await calendar.events.list({ calendarId: process.env.GOOGLE_CALENDAR_ID, timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true });
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
            resource: { summary: `Cita: ${name}`, description: `WhatsApp: ${phone}`, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
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
app.listen(PORT, () => console.log(`🚀 BarberBot V23 (Gestión Total) Online`));
