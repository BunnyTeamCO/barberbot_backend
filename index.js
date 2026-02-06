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
        await sendToWhatsApp(from, "🔄 Memoria borrada. Empecemos de cero.");
        return;
    }

    // A. IDENTIFICAR USUARIO
    let userRes = await pool.query('SELECT id, full_name, conversation_state FROM clients WHERE phone_number = $1', [from]);
    
    // B. BIENVENIDA (Usuario Nuevo)
    if (userRes.rows.length === 0) {
        const newId = crypto.randomUUID();
        await pool.query("INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')", [newId, from]);
        await sendToWhatsApp(from, "💈 ¡Hola! Bienvenido a *Alpelo*.\n\nPara atenderte mejor, primero **regálame tu nombre**.");
        return;
    }

    const user = userRes.rows[0];

    // C. GUARDAR NOMBRE (Y saltar directo a activo, SIN pedir email)
    if (user.conversation_state === 'WAITING_NAME') {
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Dame un nombre real, porfa. 😉");
            return;
        }
        // Activamos de inmediato
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Un gusto, *${cleanName}*! 🤝 Ya estás registrado.\n\nCuéntame, **¿qué día quieres venir a motilarte?**`);
        return;
    }

    // D. CHAT ACTIVO
    const clientName = user.full_name || "Amigo";
    
    await saveChatMessage(user.id, 'user', text);
    const history = await getChatHistory(user.id);
    const ai = await talkToGemini(text, clientName, history);
    
    console.log(`🧠 IA (${ai.intent}):`, ai.reply);

    let response = ai.reply;

    // --- ACCIONES ---

    if (ai.intent === 'booking' && ai.date) {
        const check = await checkCalendar(ai.date);
        
        if (check.status === 'busy') {
            response = `Uff ${clientName}, a las *${ai.humanDate}* ya estoy ocupado. 😅 ¿Te sirve otra hora?`;
        } else if (check.status === 'free') {
            // 1. AGENDAR EN TU CALENDARIO (Sin invitar)
            const result = await saveBooking(ai.date, from, user.id, clientName);
            
            if (result.success) {
                // 2. GENERAR LINK MÁGICO PARA EL CLIENTE
                const link = generateGoogleCalendarLink(ai.date, "Cita en Alpelo", "Corte de cabello y barba");
                
                response = `✅ ¡Listo el pollo! Agendado para el *${ai.humanDate}*.\n\n📅 *Agrégalo a tu calendario aquí:*\n${link}`;
            } else {
                response = `❌ Error técnico: ${result.error}`;
            }
        } else {
            response = `Error verificando agenda: ${check.message}`;
        }
    }
    
    // CONSULTAR
    else if (ai.intent === 'check') {
        const appointments = await getUserAppointments(user.id);
        if (appointments.length > 0) {
            const lista = appointments.map(cita => {
                const dateObj = new Date(cita.start_time);
                const fecha = dateObj.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' });
                const hora = dateObj.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute:'2-digit' });
                return `🗓️ *${fecha}* a las *${hora}*`;
            }).join("\n");
            response = `Aquí están tus citas, ${clientName}:\n\n${lista}`;
        } else {
            response = `No tienes citas futuras. ¿Agendamos?`;
        }
    }

    // CANCELAR Y REAGENDAR
    else if (ai.intent === 'cancel') {
        const result = await cancelNextAppointment(user.id);
        response = result.success ? `🗑️ Listo, cita cancelada.` : `No encontré citas para cancelar.`;
    }
    else if (ai.intent === 'reschedule' && ai.date) {
        const check = await checkCalendar(ai.date);
        if (check.status === 'busy') {
            response = `Ocupado a esa hora (${ai.humanDate}). Busca otra.`;
        } else {
            const result = await rescheduleNextAppointment(user.id, ai.date);
            response = result.success ? `🔄 Cita movida para el *${ai.humanDate}*.` : `No encontré cita para mover.`;
        }
    }

    await sendToWhatsApp(from, response);
    await saveChatMessage(user.id, 'assistant', response);

  } catch (error) {
    console.error("❌ ERROR CRÍTICO:", error.message);
  }
});

// --- 3. FUNCIONES DE CALENDARIO ---

// FUNCIÓN NUEVA: Generar Link Público
function generateGoogleCalendarLink(isoDate, title, details) {
    const start = new Date(isoDate);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hora

    // Formato requerido por Google: YYYYMMDDTHHmmssZ (En UTC)
    const format = (d) => d.toISOString().replace(/-|:|\.\d\d\d/g, "");
    
    return `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${format(start)}/${format(end)}&details=${encodeURIComponent(details)}`;
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

async function saveBooking(isoDate, phone, userId, name) {
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
            // YA NO USAMOS ATTENDEES NI REMINDERS AQUÍ PARA EVITAR EL ERROR
        };

        const gRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
        });
        
        await pool.query("INSERT INTO appointments (id, client_id, start_time, end_time, google_event_id) VALUES ($1, $2, $3, $4, $5)", [crypto.randomUUID(), userId, start.toISOString(), end.toISOString(), gRes.data.id]);
        return { success: true };
    } catch (e) { 
        return { success: false, error: e.message }; 
    }
}

// --- 4. CEREBRO IA ---
async function talkToGemini(userInput, userName, history) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
        const prompt = `
            Eres "Alpelo" (Colombia). Cliente: ${userName}. Hora: ${now}.
            HISTORIAL: ${history}
            CLIENTE: "${userInput}"
            INTENCIONES: "booking", "check", "cancel", "reschedule", "chat".
            JSON: { "intent": "...", "date": "ISO_DATE-05:00", "humanDate": "Texto", "reply": "Texto" }
        `;
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    } catch (e) { return { intent: "chat", reply: "Cuéntame." }; }
}

// --- 5. EXTRAS ---
async function getUserAppointments(clientId) { try { const res = await pool.query(`SELECT start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 3`, [clientId]); return res.rows; } catch (e) { return []; } }
async function cancelNextAppointment(clientId) { try { const res = await pool.query(`SELECT id, google_event_id, start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`, [clientId]); if (res.rows.length === 0) return { success: false }; const cita = res.rows[0]; await jwtClient.authorize(); const calendar = google.calendar({ version: 'v3', auth: jwtClient }); try { await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: cita.google_event_id }); } catch (err) {} await pool.query(`DELETE FROM appointments WHERE id = $1`, [cita.id]); return { success: true }; } catch (e) { return { success: false }; } }
async function rescheduleNextAppointment(clientId, newIsoDate) { try { const res = await pool.query(`SELECT id, google_event_id FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`, [clientId]); if (res.rows.length === 0) return { success: false, reason: 'no_appointment' }; const cita = res.rows[0]; const start = new Date(newIsoDate); const end = new Date(start.getTime() + 60 * 60 * 1000); await jwtClient.authorize(); const calendar = google.calendar({ version: 'v3', auth: jwtClient }); await calendar.events.patch({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: cita.google_event_id, resource: { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } } }); await pool.query(`UPDATE appointments SET start_time = $1, end_time = $2 WHERE id = $3`, [start.toISOString(), end.toISOString(), cita.id]); return { success: true }; } catch (e) { return { success: false, reason: 'error' }; } }
async function saveChatMessage(clientId, role, content) { try { await pool.query("INSERT INTO chat_history (client_id, role, content) VALUES ($1, $2, $3)", [clientId, role, content]); } catch (e) {} }
async function getChatHistory(clientId) { try { const res = await pool.query("SELECT role, content FROM chat_history WHERE client_id = $1 ORDER BY created_at DESC LIMIT 5", [clientId]); return res.rows.reverse().map(m => `${m.role==='user'?'Cliente':'Barbero'}: ${m.content}`).join("\n"); } catch (e) { return ""; } }
async function sendToWhatsApp(to, text) { try { await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, { messaging_product: 'whatsapp', to, text: { body: text } }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } }); } catch (e) {} }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V31 (Link Mágico) Online`));
