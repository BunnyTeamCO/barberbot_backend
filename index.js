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

// --- CONFIGURACIÓN ---
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
        await sendToWhatsApp(from, `¡Listo, *${cleanName}*! Ya estás registrado.\n\n¿Quieres agendar, cancelar o cambiar una cita?`);
        return;
    }

    // C. MEMORIA & CONTEXTO
    await saveChatMessage(user.id, 'user', text);
    const history = await getChatHistory(user.id);

    // D. CEREBRO IA (Con Hora Colombia explícita)
    const clientName = user.full_name || "Amigo";
    const ai = await talkToGemini(text, clientName, history);
    console.log(`🧠 IA (${ai.intent}) [Date: ${ai.date}]:`, ai.reply);

    let response = ai.reply;

    // --- LÓGICA DE INTENCIONES ---

    // 1. AGENDAR (Booking)
    if (ai.intent === 'booking' && ai.date) {
        const check = await checkCalendar(ai.date); // Verifica disponibilidad
        if (check.status === 'busy') {
            response = `Uff ${clientName}, a las *${ai.humanDate}* ya estoy ocupado. 😅 ¿Te sirve otra hora?`;
        } else if (check.status === 'free') {
            const booked = await saveBooking(ai.date, from, user.id, clientName);
            response = booked 
              ? `✅ ¡Agendado! Nos vemos el *${ai.humanDate}*.`
              : `Tuve un error guardando la cita.`;
        } else {
            response = `Error técnico: ${check.message}`;
        }
    }

    // 2. CONSULTAR (Check)
    else if (ai.intent === 'check') {
        const appointments = await getUserAppointments(user.id);
        if (appointments.length > 0) {
            const lista = appointments.map(cita => {
                // Truco para mostrar hora Colombia correcta desde DB
                const dateObj = new Date(cita.start_time);
                return `🗓️ *${dateObj.toLocaleString('es-CO', { timeZone: 'America/Bogota', weekday:'long', day:'numeric', hour: '2-digit', minute:'2-digit' })}*`;
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
        // A. Verificar si el NUEVO espacio está libre
        const check = await checkCalendar(ai.date);
        
        if (check.status === 'busy') {
            response = `No puedo moverla a las *${ai.humanDate}* porque ya estoy ocupado. Busca otro hueco.`;
        } else {
            // B. Mover la cita
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

// --- FUNCIONES DE CALENDARIO Y ZONA HORARIA ---

async function checkCalendar(isoDate) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        // Calcular inicio y fin (1 hora) asegurando formato correcto
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000); 

        console.log(`📅 Verificando: ${start.toISOString()} (UTC)`);

        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true
        });

        // Filtrar solo eventos "Ocupado"
        const conflicts = res.data.items.filter(e => e.status !== 'cancelled' && e.transparency !== 'transparent');
        
        if (conflicts.length > 0) {
            console.log(`⚠️ Conflicto con: ${conflicts[0].summary}`);
            return { status: 'busy' };
        }
        return { status: 'free' };

    } catch (e) { 
        return { status: 'error', message: e.message }; 
    }
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
                start: { dateTime: start.toISOString() }, // Google espera ISO con offset o Z
                end: { dateTime: end.toISOString() },
                colorId: '2' 
            }
        });
        
        // Guardar en DB
        await pool.query("INSERT INTO appointments (id, client_id, start_time, end_time, google_event_id) VALUES ($1, $2, $3, $4, $5)", [crypto.randomUUID(), userId, start.toISOString(), end.toISOString(), gRes.data.id]);
        return true;
    } catch (e) { return false; }
}

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

        // Borrar de Google
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        try {
            await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: cita.google_event_id });
        } catch (err) {}

        // Borrar de DB
        await pool.query(`DELETE FROM appointments WHERE id = $1`, [cita.id]);
        
        // Devolver fecha formateada Colombia
        const dateStr = new Date(cita.start_time).toLocaleString('es-CO', { timeZone: 'America/Bogota', weekday:'long', hour:'numeric', minute:'2-digit' });
        return { success: true, date: dateStr };
    } catch (e) { return { success: false }; }
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

        // 2. Tiempos nuevos
        const start = new Date(newIsoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        // 3. Mover en Google
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        await calendar.events.patch({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            eventId: cita.google_event_id,
            resource: { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
        });

        // 4. Mover en DB
        await pool.query(
            `UPDATE appointments SET start_time = $1, end_time = $2 WHERE id = $3`,
            [start.toISOString(), end.toISOString(), cita.id]
        );
        return { success: true };
    } catch (e) { return { success: false, reason: 'error' }; }
}

// --- 4. CEREBRO IA (TIMEZONE AWARE) ---

async function talkToGemini(userInput, userName, history) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        // FECHA ACTUAL EN BOGOTÁ
        const nowCol = new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour12: false });
        // Calculamos el día de la semana para ayudar a la IA
        const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const dayName = days[new Date().getDay()];

        const prompt = `
            Eres "Alpelo" (Colombia). Cliente: ${userName}. 
            
            CONTEXTO TEMPORAL IMPORTANTE:
            - Hora Actual en Colombia: ${nowCol} (${dayName}).
            - TODAS las fechas que generes DEBEN tener el offset -05:00.
            
            HISTORIAL: ${history}
            CLIENTE: "${userInput}"

            INTENCIONES:
            - "booking": Cita nueva.
            - "check": Consultar cita actual.
            - "cancel": Borrar cita.
            - "reschedule": Cambiar hora/día de cita existente.
            - "chat": Otros.

            JSON (Sin Markdown):
            {
                "intent": "booking"|"check"|"cancel"|"reschedule"|"chat",
                "date": "YYYY-MM-DDTHH:mm:ss-05:00" (Para booking/reschedule. EJEMPLO: 2024-02-28T15:00:00-05:00),
                "humanDate": "Texto legible (ej: Mañana 3pm)",
                "reply": "Respuesta"
            }
        `;

        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    } catch (e) {
        return { intent: "chat", reply: `Cuéntame ${userName}, ¿en qué te ayudo?` };
    }
}

// --- 5. EXTRAS ---
async function saveChatMessage(clientId, role, content) { try { await pool.query("INSERT INTO chat_history (client_id, role, content) VALUES ($1, $2, $3)", [clientId, role, content]); } catch (e) {} }
async function getChatHistory(clientId) { try { const res = await pool.query("SELECT role, content FROM chat_history WHERE client_id = $1 ORDER BY created_at DESC LIMIT 6", [clientId]); return res.rows.reverse().map(m => `${m.role==='user'?'Cliente':'Barbero'}: ${m.content}`).join("\n"); } catch (e) { return ""; } }
async function sendToWhatsApp(to, text) { try { await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, { messaging_product: 'whatsapp', to, text: { body: text } }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } }); } catch (e) {} }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V25 (Timezone) Online`));
