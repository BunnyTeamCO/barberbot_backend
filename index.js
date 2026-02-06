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
        await sendToWhatsApp(from, "🔄 Reinicio total. Escríbeme como si fuera la primera vez.");
        return;
    }

    // A. IDENTIFICAR USUARIO
    let userRes = await pool.query('SELECT id, full_name, email, conversation_state FROM clients WHERE phone_number = $1', [from]);
    
    // B. BIENVENIDA (Usuario Nuevo)
    if (userRes.rows.length === 0) {
        const newId = crypto.randomUUID();
        await pool.query("INSERT INTO clients (id, phone_number, conversation_state) VALUES ($1, $2, 'WAITING_NAME')", [newId, from]);
        await sendToWhatsApp(from, "💈 ¡Qué más! Bienvenido a *Alpelo*.\n\nSoy Santiago, tu barbero virtual. Para guardarte en mis contactos, **¿cómo te llamas?**");
        return;
    }

    const user = userRes.rows[0];

    // C. GUARDAR NOMBRE (Fluido)
    if (user.conversation_state === 'WAITING_NAME') {
        const cleanName = text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        if (cleanName.length < 3) {
            await sendToWhatsApp(from, "Ese nombre está muy cortico 😅. Dime cómo te dicen tus amigos.");
            return;
        }
        await pool.query("UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2", [cleanName, from]);
        // Respuesta inmediata y proactiva
        await sendToWhatsApp(from, `¡Listo ${cleanName}! Un gusto. 👊\n\nAquí estoy para lo que necesites. ¿Te agendo un corte para esta semana o tienes alguna duda?`);
        return;
    }

    // D. CHAT CON CEREBRO MEJORADO
    const clientName = user.full_name || "Parcero";
    
    // 1. Historial
    await saveChatMessage(user.id, 'user', text);
    const history = await getChatHistory(user.id);

    // 2. IA
    const ai = await talkToGemini(text, clientName, history);
    console.log(`🧠 IA (${ai.intent}):`, ai.reply);

    let finalMessage = ai.reply; // La IA decide qué decir por defecto

    // --- ACCIONES DE AGENDAMIENTO ---

    if (ai.intent === 'booking' && ai.date) {
        const check = await checkCalendar(ai.date);
        
        if (check.status === 'busy') {
            finalMessage = `Uff ${clientName}, revisé la agenda y justo a las *${ai.humanDate}* ya estoy ocupado. 🚫\n\n¿Te queda fácil una hora antes o después?`;
        } else if (check.status === 'free') {
            // 1. Agendar en Barbero
            const result = await saveBooking(ai.date, from, user.id, clientName);
            
            if (result.success) {
                // 2. Link Mágico
                const link = generateGoogleCalendarLink(ai.date, "Cita en Alpelo", "Corte de cabello - Cliente: " + clientName);
                
                // Mensaje Híbrido: Confirmación humana + Utilidad técnica
                finalMessage = `✅ ¡Listo el pollo! Ya te separé el espacio para el *${ai.humanDate}*.\n\n👇 *Toca este link para que no se te olvide y quede en tu calendario:*\n${link}\n\n¡Nos vemos allá!`;
            } else {
                finalMessage = `❌ Ocurrió un error técnico al guardar. Intenta de nuevo porfa.`;
            }
        } else {
            finalMessage = `Tengo un problema conectando con la agenda. Dame un minuto.`;
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
                return `🗓️ *${fecha}* - ${hora}`;
            }).join("\n");
            finalMessage = `Claro que sí, aquí tienes tus citas pendientes:\n\n${lista}`;
        } else {
            finalMessage = `No te veo agendado todavía. ¿Te separo un espacio?`;
        }
    }

    // CANCELAR
    else if (ai.intent === 'cancel') {
        const result = await cancelNextAppointment(user.id);
        finalMessage = result.success ? `Listo, cita cancelada. 🗑️ Avísame cuando quieras volver a agendar.` : `No encontré ninguna cita para cancelar.`;
    }

    // REAGENDAR
    else if (ai.intent === 'reschedule' && ai.date) {
        const check = await checkCalendar(ai.date);
        if (check.status === 'busy') {
            finalMessage = `No puedo moverla a las *${ai.humanDate}* porque ya estoy ocupado. Busca otro hueco.`;
        } else {
            const result = await rescheduleNextAppointment(user.id, ai.date);
            finalMessage = result.success ? `🔄 Cambio realizado. Tu nueva cita es el *${ai.humanDate}*.` : `No encontré cita para mover.`;
        }
    }

    // ENVIAR
    await sendToWhatsApp(from, finalMessage);
    await saveChatMessage(user.id, 'assistant', finalMessage);

  } catch (error) {
    console.error("❌ ERROR CRÍTICO:", error.message);
  }
});

// --- 3. FUNCIONES DE CALENDARIO ---

function generateGoogleCalendarLink(isoDate, title, details) {
    const start = new Date(isoDate);
    const end = new Date(start.getTime() + 60 * 60 * 1000); 
    const format = (d) => d.toISOString().replace(/-|:|\.\d\d\d/g, "");
    return `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${format(start)}/${format(end)}&details=${encodeURIComponent(details)}&sf=true&output=xml`;
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
        };

        const gRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
        });
        
        await pool.query("INSERT INTO appointments (id, client_id, start_time, end_time, google_event_id) VALUES ($1, $2, $3, $4, $5)", [crypto.randomUUID(), userId, start.toISOString(), end.toISOString(), gRes.data.id]);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

// --- 4. CEREBRO IA (PERSONALIDAD SANTIAGO) ---

async function talkToGemini(userInput, userName, history) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres "Santiago", el barbero de "Alpelo" en Colombia. 
            Cliente: ${userName}. Hora actual: ${now}.
            
            HISTORIAL RECIENTE:
            ${history}
            
            CLIENTE DICE: "${userInput}"

            TU PERSONALIDAD:
            - Eres "parcero", relajado pero profesional.
            - NO seas repetitivo. Si en el historial ya saludaste, ve al grano.
            - NO uses frases genéricas como "¿En qué te ayudo?" todo el tiempo. Varía: "¿Qué nos hacemos hoy?", "¿Listo para el corte?", etc.
            - Si el cliente te agradece, responde con "A la orden", "Con gusto", "Hágale".

            INSTRUCCIONES DE FLUJO:
            1. "booking": Si dice "cita mañana a las 3" o "sí, a esa hora".
            2. "check": Si pregunta "¿cuándo voy?".
            3. "chat": Si solo saluda, bromea o pregunta precios.

            Responde JSON (sin markdown):
            {
                "intent": "booking" | "check" | "cancel" | "reschedule" | "chat",
                "date": "ISO_DATE-05:00",
                "humanDate": "Texto legible (ej: Viernes 3pm)",
                "reply": "Tu respuesta textual (Úsala para chat o para rechazos, NO para confirmar citas exitosas)"
            }
        `;

        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, '').trim());
    } catch (e) {
        return { intent: "chat", reply: "Cuéntame, ¿qué necesitas?" };
    }
}

// --- 5. EXTRAS ---
async function getUserAppointments(clientId) { try { const res = await pool.query(`SELECT start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 3`, [clientId]); return res.rows; } catch (e) { return []; } }
async function cancelNextAppointment(clientId) { try { const res = await pool.query(`SELECT id, google_event_id, start_time FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`, [clientId]); if (res.rows.length === 0) return { success: false }; const cita = res.rows[0]; await jwtClient.authorize(); const calendar = google.calendar({ version: 'v3', auth: jwtClient }); try { await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: cita.google_event_id }); } catch (err) {} await pool.query(`DELETE FROM appointments WHERE id = $1`, [cita.id]); return { success: true }; } catch (e) { return { success: false }; } }
async function rescheduleNextAppointment(clientId, newIsoDate) { try { const res = await pool.query(`SELECT id, google_event_id FROM appointments WHERE client_id = $1 AND start_time > NOW() ORDER BY start_time ASC LIMIT 1`, [clientId]); if (res.rows.length === 0) return { success: false, reason: 'no_appointment' }; const cita = res.rows[0]; const start = new Date(newIsoDate); const end = new Date(start.getTime() + 60 * 60 * 1000); await jwtClient.authorize(); const calendar = google.calendar({ version: 'v3', auth: jwtClient }); await calendar.events.patch({ calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: cita.google_event_id, resource: { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } } }); await pool.query(`UPDATE appointments SET start_time = $1, end_time = $2 WHERE id = $3`, [start.toISOString(), end.toISOString(), cita.id]); return { success: true }; } catch (e) { return { success: false, reason: 'error' }; } }
async function saveChatMessage(clientId, role, content) { try { await pool.query("INSERT INTO chat_history (client_id, role, content) VALUES ($1, $2, $3)", [clientId, role, content]); } catch (e) {} }
async function getChatHistory(clientId) { try { const res = await pool.query("SELECT role, content FROM chat_history WHERE client_id = $1 ORDER BY created_at DESC LIMIT 10", [clientId]); return res.rows.reverse().map(m => `${m.role==='user'?'Cliente':'Santiago'}: ${m.content}`).join("\n"); } catch (e) { return ""; } }
async function sendToWhatsApp(to, text) { try { await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, { messaging_product: 'whatsapp', to, text: { body: text } }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } }); } catch (e) {} }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V33 (Flow Master) Online`));
