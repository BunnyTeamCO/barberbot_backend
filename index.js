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
        await sendToWhatsApp(from, "🔄 Reset completo.");
        return;
    }

    // A. Usuario
    let userRes = await pool.query('SELECT id, full_name, email, conversation_state FROM clients WHERE phone_number = $1', [from]);
    
    if (userRes.rows.length === 0) {
        const newId = crypto.randomUUID();
        await pool.query("INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')", [newId, from]);
        await sendToWhatsApp(from, "💈 ¡Hola! Bienvenido a *Alpelo*.\n\nPara empezar, **¿cuál es tu nombre?**");
        return;
    }

    const user = userRes.rows[0];

    // B. Nombre
    if (user.conversation_state === 'WAITING_NAME') {
        const cleanName = text;
        if (cleanName.length < 3) { await sendToWhatsApp(from, "Nombre muy corto."); return; }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'WAITING_EMAIL' WHERE phone_number = $2", [cleanName, from]);
        await sendToWhatsApp(from, `¡Un gusto ${cleanName}! 🤝\nAhora pásame tu **correo Gmail** para las invitaciones.`);
        return;
    }

    // C. Email
    if (user.conversation_state === 'WAITING_EMAIL') {
        if (!text.includes('@')) { await sendToWhatsApp(from, "Correo inválido. Intenta de nuevo."); return; }
        await pool.query("UPDATE clients SET email = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [text.toLowerCase().trim(), from]);
        await sendToWhatsApp(from, `¡Listo! Configurado. ✅\n\n¿Qué día quieres tu cita?`);
        return;
    }

    // D. IA
    const clientName = user.full_name || "Amigo";
    await saveChatMessage(user.id, 'user', text);
    const history = await getChatHistory(user.id);
    const ai = await talkToGemini(text, clientName, history);
    
    let response = ai.reply;

    if (ai.intent === 'booking' && ai.date) {
        // Validar fecha antes de procesar
        if (isNaN(new Date(ai.date).getTime())) {
            response = "⚠️ La fecha que entendí no es válida. ¿Podrías repetirme día y hora?";
        } else {
            const check = await checkCalendar(ai.date);
            if (check.status === 'busy') {
                response = `Ocupado a esa hora (${ai.humanDate}). 😅 ¿Otra hora?`;
            } else if (check.status === 'free') {
                // INTENTO DE GUARDADO CON REPORTE DE ERROR
                const result = await saveBooking(ai.date, from, user.id, clientName, user.email);
                if (result.success) {
                    response = `✅ ¡Agendado para el *${ai.humanDate}*!\nTe llegará invitación a ${user.email}.`;
                } else {
                    // AQUÍ ESTÁ LA CLAVE: Mostramos el error real
                    response = `❌ ERROR TÉCNICO AL GUARDAR:\n${result.error}`;
                }
            } else {
                response = `Error verificando agenda: ${check.message}`;
            }
        }
    }
    
    // ... (Check, Cancel, Reschedule omitidos por brevedad, funcionan igual)

    await sendToWhatsApp(from, response);
    await saveChatMessage(user.id, 'assistant', response);

  } catch (error) {
    console.error("❌ ERROR CRÍTICO:", error.message);
    await sendToWhatsApp(from, `Error interno crítico: ${error.message}`);
  }
});

// --- FUNCIONES CRÍTICAS (CON DIAGNÓSTICO) ---

async function saveBooking(isoDate, phone, userId, name, email) {
    let step = 'inicio';
    try {
        step = 'autenticación google';
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        const event = {
            summary: `Cita: ${name}`,
            description: `Cliente: ${name} (${phone})`,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
            colorId: '2',
            attendees: email ? [{ email }] : [],
            reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] }
        };

        step = 'insertar en google calendar';
        const gRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
            sendUpdates: 'all',
        });
        
        step = 'insertar en base de datos';
        await pool.query(
            "INSERT INTO appointments (id, client_id, start_time, end_time, google_event_id) VALUES ($1, $2, $3, $4, $5)",
            [crypto.randomUUID(), userId, start.toISOString(), end.toISOString(), gRes.data.id]
        );
        
        return { success: true };

    } catch (e) {
        console.error(`Fallo en ${step}:`, e);
        // Devolvemos el paso exacto donde falló y el mensaje del error
        return { success: false, error: `Fallo en paso [${step}]: ${e.message}` };
    }
}

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

async function checkCalendar(isoDate) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        const res = await calendar.events.list({ calendarId: process.env.GOOGLE_CALENDAR_ID, timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true });
        return res.data.items.filter(e => e.status !== 'cancelled').length > 0 ? { status: 'busy' } : { status: 'free' };
    } catch (e) { return { status: 'error', message: e.message }; }
}

// Auxiliares
async function saveChatMessage(clientId, role, content) { try { await pool.query("INSERT INTO chat_history (client_id, role, content) VALUES ($1, $2, $3)", [clientId, role, content]); } catch (e) {} }
async function getChatHistory(clientId) { try { const res = await pool.query("SELECT role, content FROM chat_history WHERE client_id = $1 ORDER BY created_at DESC LIMIT 5", [clientId]); return res.rows.reverse().map(m => `${m.role==='user'?'Cliente':'Barbero'}: ${m.content}`).join("\n"); } catch (e) { return ""; } }
async function sendToWhatsApp(to, text) { try { await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, { messaging_product: 'whatsapp', to, text: { body: text } }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } }); } catch (e) {} }
async function getUserAppointments(id) {return []} 
async function cancelNextAppointment(id) {return {success: false}} 
async function rescheduleNextAppointment(id, d) {return {success: false}}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V29 (Diagnóstico) Online`));
