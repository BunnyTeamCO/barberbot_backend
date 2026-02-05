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

// A. Base de Datos (CORREGIDO)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false // <--- CAMBIO CRÍTICO: Desactivamos SSL para red interna de Coolify
});

// B. Inteligencia Artificial
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// C. Google Calendar
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

  if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const fromName = message.push_name || "Cliente Nuevo";
    const text = message.text ? message.text.body : '';

    console.log(`📩 Mensaje de ${fromName} (${from}): ${text}`);

    try {
      // 1. PENSAR
      const aiAnalysis = await analyzeWithGemini(text);
      console.log("🧠 IA:", JSON.stringify(aiAnalysis));

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        // 2. VERIFICAR
        const availability = await checkRealAvailability(aiAnalysis.date);
        
        if (availability.status === 'error') {
            finalResponse = `🔧 ERROR TÉCNICO:\n${availability.message}`;
        } else if (availability.status === 'busy') {
            finalResponse = `⚠️ Ya estoy ocupado el ${aiAnalysis.humanDate}. ¿Te sirve otra hora?`;
        } else {
            // 3. AGENDAR (Calendar + DB)
            const booking = await crearEventoCompleto(aiAnalysis.date, from, fromName);
            
            if (booking.status === 'success') {
                finalResponse = `✅ ¡Listo! Cita confirmada para el ${aiAnalysis.humanDate}.\n\nGuardado en sistema bajo: ${fromName}`;
            } else {
                finalResponse = `❌ Error al guardar: ${booking.error}`;
            }
        }
      } else {
        finalResponse = aiAnalysis.reply;
      }

      await sendToWhatsApp(from, finalResponse);

    } catch (error) {
      console.error("❌ Error General:", error);
    }
  }
});

// --- 3. FUNCIONES DE BASE DE DATOS ---

async function getOrCreateClient(phone, name) {
    try {
        const res = await pool.query('SELECT id FROM clients WHERE phone_number = $1', [phone]);
        if (res.rows.length > 0) {
            return res.rows[0].id;
        }
        const insert = await pool.query(
            'INSERT INTO clients (id, phone_number, full_name) VALUES (gen_random_uuid(), $1, $2) RETURNING id',
            [phone, name]
        );
        console.log("🆕 Cliente nuevo registrado en DB");
        return insert.rows[0].id;
    } catch (e) {
        console.error("Error DB Cliente:", e);
        throw e;
    }
}

async function saveAppointmentToDB(clientId, startTime, endTime, googleId) {
    try {
        await pool.query(
            `INSERT INTO appointments (id, client_id, start_time, end_time, status, google_event_id, service_type) 
             VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', $4, 'Corte General')`,
            [clientId, startTime, endTime, googleId]
        );
        console.log("💾 Cita guardada en PostgreSQL");
    } catch (e) {
        console.error("Error DB Cita:", e);
    }
}

// --- 4. FUNCIONES DE NEGOCIO ---

async function crearEventoCompleto(isoDateStart, clientPhone, clientName) {
    try {
        // A. Google Calendar
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000); 

        const event = {
            summary: `Cita: ${clientName}`,
            description: `Cliente: ${clientPhone} - Agendado por BarberBot`,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
            colorId: '2'
        };

        const googleRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
        });
        
        // B. Base de Datos
        const clientId = await getOrCreateClient(clientPhone, clientName);
        await saveAppointmentToDB(clientId, start.toISOString(), end.toISOString(), googleRes.data.id);

        return { status: 'success' };

    } catch (error) {
        console.error("❌ Error Agendamiento:", error);
        return { status: 'error', error: error.message };
    }
}

// --- RESTO DE FUNCIONES ---

async function analyzeWithGemini(userText) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const nowCol = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    const prompt = `
      Eres BarberBot. Fecha actual en Colombia: ${nowCol}.
      Usuario: "${userText}"
      REGLAS:
      1. Si pide cita, extrae fecha ISO (YYYY-MM-DDTHH:mm:ss-05:00).
      2. Si saluda, responde amable.
      Responde JSON: { "intent": "booking"|"chat", "date": "ISO"|null, "humanDate": "Texto"|null, "reply": "Texto"|null }
    `;
    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { intent: "chat", reply: "Hola, ¿en qué te ayudo?" };
  }
}

async function checkRealAvailability(isoDateStart) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        const res = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true
        });
        const activeEvents = res.data.items.filter(e => e.status !== 'cancelled');
        return activeEvents.length > 0 ? { status: 'busy' } : { status: 'free' };
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

async function sendToWhatsApp(to, textBody) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`,
            headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}`, 'Content-Type': 'application/json' },
            data: { messaging_product: 'whatsapp', to: to, text: { body: textBody } }
        });
    } catch (error) { console.error("Error envío WhatsApp", error.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 BarberBot V8 (SSL Fix) corriendo en puerto ${PORT}`); });
