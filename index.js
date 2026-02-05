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
    // RESET
    if (text.toLowerCase() === '/reset') {
        await pool.query("DELETE FROM clients WHERE phone_number = $1", [from]);
        await sendToWhatsApp(from, "🔄 Memoria borrada. Escríbeme 'Hola'.");
        return;
    }

    // A. Identificar usuario
    let userRes = await pool.query('SELECT id, full_name, email, conversation_state FROM clients WHERE phone_number = $1', [from]);
    
    // B. Bienvenida (Registro Inicial)
    if (userRes.rows.length === 0) {
        const newId = crypto.randomUUID();
        await pool.query("INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')", [newId, from]);
        await sendToWhatsApp(from, "💈 ¡Hola! Bienvenido a *Alpelo*.\n\nPara atenderte mejor, primero **regálame tu nombre**.");
        return;
    }

    const user = userRes.rows[0];

    // C. Estado: Esperando NOMBRE
    if (user.conversation_state === 'WAITING_NAME') {
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Dame un nombre real, porfa. 😉");
            return;
        }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'WAITING_EMAIL' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Un gusto, *${cleanName}*! 🤝\n\nPor último, pásame tu **correo Gmail** para enviarte la invitación al calendario.`);
        return;
    }

    // D. Estado: Esperando EMAIL
    if (user.conversation_state === 'WAITING_EMAIL') {
        const email = text.toLowerCase().trim();
        if (!email.includes('@')) {
            await sendToWhatsApp(from, "Ese correo se ve raro. 🤔 Intenta de nuevo.");
            return;
        }
        await pool.query("UPDATE clients SET email = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [email, from]);
        await sendToWhatsApp(from, `¡Todo listo! ✅\n\nAhora sí, cuéntame: **¿Qué día y a qué hora quieres tu cita?**`);
        return;
    }

    // E. CHAT CON INTELIGENCIA (Memoria Corregida)
    const clientName = user.full_name || "Amigo";
    
    // 1. LEER HISTORIAL ANTES DE GUARDAR EL NUEVO (Evita duplicados en el prompt)
    const history = await getChatHistory(user.id);

    // 2. AHORA SÍ GUARDAR EL NUEVO MENSAJE
    await saveChatMessage(user.id, 'user', text);

    // 3. CONSULTAR IA
    const ai = await talkToGemini(text, clientName, history);
    console.log(`🧠 IA (${ai.intent}):`, ai.reply);

    let response = ai.reply;

    // --- ACCIONES ---

    if (ai.intent === 'booking' && ai.date) {
        const check = await checkCalendar(ai.date);
        
        if (check.status === 'busy') {
            response = `Uff ${clientName}, a las *${ai.humanDate}* ya estoy ocupado. 😅 ¿Te sirve otra hora ese mismo día?`;
        } else if (check.status === 'free') {
            const booked = await saveBooking(ai.date, from, user.id, clientName, user.email);
            response = booked 
              ? `✅ ¡Agendado! Nos vemos el *${ai.humanDate}*.\nTe envié la invitación a tu correo.`
              : `Tuve un error guardando la cita.`;
        } else {
            response = `Error técnico: ${check.message}`;
        }
    }
    
    else if (ai.intent === 'check') {
        const appointments = await getUserAppointments(user.id);
        if (appointments.length > 0) {
            const lista = appointments.map(cita => {
                const dateObj = new Date(cita.start_time);
                return `🗓️ *${dateObj.toLocaleDateString('es-CO', {weekday:'long', day:'numeric', month:'long'})}* a las *${dateObj.toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit'})}*`;
            }).join("\n");
            response = `Aquí están tus citas, ${clientName}:\n\n${lista}`;
        } else {
            response = `No tienes citas futuras programadas. ¿Agendamos una?`;
        }
    }

    else if (ai.intent === 'cancel') {
        const result = await cancelNextAppointment(user.id);
        response = result.success 
            ? `🗑️ Listo, cancelé tu cita del *${result.date}*.`
            : `No encontré ninguna cita pendiente para cancelar.`;
    }

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

    // 4. GUARDAR RESPUESTA DEL BOT
    await sendToWhatsApp(from, response);
    await saveChatMessage(user.id, 'assistant', response);

  } catch (error) {
    console.error("❌ ERROR CRÍTICO:", error.message);
  }
});

// --- FUNCIONES IA (CONTEXTO ROBUSTO) ---

async function talkToGemini(userInput, userName, history) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres el dueño de la barbería "Alpelo". Cliente: ${userName}. Hora actual: ${now}.
            
            --- HISTORIAL DE CONVERSACIÓN ---
            ${history}
            ---------------------------------
            
            CLIENTE DICE AHORA: "${userInput}"

            INSTRUCCIONES DE CONTEXTO:
            1. Analiza el HISTORIAL. Si el cliente dice "sí", "esa", "dale", "mejor a las 5", se refiere a lo último que hablamos.
            2. Si en el historial yo (el barbero) dije que estaba ocupado, y el cliente propone otra hora, es un intento de 'booking'.
            3. Si el cliente quiere cambiar una cita ya agendada, es 'reschedule'.

            FORMATO JSON OBLIGATORIO:
            {
                "intent": "booking" | "check" | "cancel" | "reschedule" | "chat",
                "date": "ISO_DATE-05:00" (Calcula la fecha exacta basada en la hora actual y el contexto. Ej: Si hoy es lunes y dice 'mañana', es martes),
                "humanDate": "Texto legible",
                "reply": "Respuesta natural y corta"
            }
        `;

        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    } catch (e) {
        return { intent: "chat", reply: "Cuéntame, ¿qué necesitas?" };
    }
}

// --- FUNCIONES AUXILIARES DE BD Y CALENDARIO ---

async function saveChatMessage(clientId, role, content) {
    try { await pool.query("INSERT INTO chat_history (client_id, role, content) VALUES ($1, $2, $3)", [clientId, role, content]); } catch (e) {}
}

async function getChatHistory(clientId) {
    try {
        // Traemos los últimos 10 mensajes para tener buen contexto
        const res = await pool.query("SELECT role, content FROM chat_history WHERE client_id = $1 ORDER BY created_at DESC LIMIT 10", [clientId]);
        // Los invertimos para que el prompt los lea en orden cronológico (Antiguo -> Nuevo)
        return res.rows.reverse().map(m => `${m.role==='user'?'Cliente':'Barbero'}: ${m.content}`).join("\n");
    } catch (e) { return ""; }
}

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
        const active = res.data.items.filter(e => e.status !== 'cancelled' && e.transparency !== 'transparent');
        return active.length > 0 ? { status: 'busy' } : { status: 'free' };
    } catch (e) { return { status: 'error', message: e.message }; }
}

async function saveBooking(isoDate, phone, userId, name, email) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        const event = {
            summary: `Cita: ${name}`,
            description: `Cliente: ${name}\nWhatsApp: ${phone}`,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
            colorId: '2',
            attendees: email ? [{ email }] : [],
            reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 180 }, { method: 'popup', minutes: 30 }] }
        };

        const gRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
            sendUpdates: 'all',
        });
        
        await pool.query("INSERT INTO appointments (id, client_id, start_time, end_time, google_event_id) VALUES ($1, $2, $3, $4, $5)", [crypto.randomUUID(), userId, start.toISOString(), end.toISOString(), gRes.data.id]);
        return true;
    } catch (e) { return false; }
}

async function getUserAppointments(clientId) {
    try {
        const res = await pool.query(`SELECT start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 3`, [clientId]);
        return res.rows;
    } catch (e) { return []; }
}

async function cancelNextAppointment(clientId) {
    try {
        const res = await pool.query(`SELECT id, google_event_id, start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`, [clientId]);
        if (res.rows.length === 0) return { success: false };
        const cita = res.rows[0];
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        try { await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: cita.google_event_id }); } catch (err) {}
        await pool.query(`DELETE FROM appointments WHERE id = $1`, [cita.id]);
        const dateStr = new Date(cita.start_time).toLocaleString('es-CO', { timeZone: 'America/Bogota', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' });
        return { success: true, date: dateStr };
    } catch (e) { return { success: false }; }
}

async function rescheduleNextAppointment(clientId, newIsoDate) {
    try {
        const res = await pool.query(`SELECT id, google_event_id FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`, [clientId]);
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
        await pool.query(`UPDATE appointments SET start_time = $1, end_time = $2 WHERE id = $3`, [start.toISOString(), end.toISOString(), cita.id]);
        return { success: true };
    } catch (e) { return { success: false, reason: 'error' }; }
}

async function sendToWhatsApp(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, {
            messaging_product: 'whatsapp', to, text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } });
    } catch (e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V28 (Contexto) Online`));
