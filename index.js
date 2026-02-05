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

  if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const text = message.text ? message.text.body : '';

    console.log(`📩 Mensaje de ${from}: ${text}`);

    try {
      // --- PASO A: GESTIÓN DE ESTADO INTELIGENTE ---
      const userState = await checkUserState(from);

      // CASO 1: NUEVO -> Bienvenida
      if (userState.status === 'NEW') {
          await initializeUser(from);
          await sendToWhatsApp(from, "👋 ¡Hola! Te comunicas con *Alpelo*.\n\nPara empezar, por favor **dime tu nombre**.");
          return; 
      }

      // CASO 2: ESPERANDO NOMBRE (O REPARACIÓN) -> Guardar
      if (userState.status === 'WAITING_NAME') {
          const newName = text.trim(); 
          if (newName.length < 2) {
             await sendToWhatsApp(from, "Por favor escribe un nombre válido.");
             return;
          }
          await updateUserName(from, newName);
          await sendToWhatsApp(from, `¡Un gusto, ${newName}! 🤝 Ya actualicé tu registro.\n\nAhora sí, ¿en qué te puedo ayudar? (Ej: "Quiero una cita mañana")`);
          return;
      }

      // CASO 3: ACTIVO -> Flujo IA
      // Corrección Defensiva: Si por alguna razón el nombre es null, usamos "Amigo"
      const clientName = userState.name || "Amigo"; 
      
      const aiAnalysis = await analyzeWithGemini(text, clientName);
      console.log("🧠 IA:", JSON.stringify(aiAnalysis));

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        const availability = await checkRealAvailability(aiAnalysis.date);
        
        if (availability.status === 'error') {
            finalResponse = `🔧 ERROR TÉCNICO:\n${availability.message}`;
        } else if (availability.status === 'busy') {
            finalResponse = `⚠️ ${clientName}, a esa hora (${aiAnalysis.humanDate}) ya estoy ocupado. ¿Te sirve otra?`;
        } else {
            const booking = await crearEventoCompleto(aiAnalysis.date, from, clientName);
            if (booking.status === 'success') {
                finalResponse = `✅ ¡Listo ${clientName}! Cita confirmada para el ${aiAnalysis.humanDate}.`;
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

// --- 3. FUNCIONES BD (Estado y Reparación) ---

async function checkUserState(phone) {
    try {
        const res = await pool.query('SELECT conversation_state, full_name FROM clients WHERE phone_number = $1', [phone]);
        
        if (res.rows.length === 0) {
            return { status: 'NEW' };
        }

        const userData = res.rows[0];

        // --- LÓGICA DE AUTO-REPARACIÓN ---
        // Si el usuario existe pero NO tiene nombre (o es "undefined"), lo obligamos a dar el nombre
        if (!userData.full_name || userData.full_name === 'undefined' || userData.full_name.trim() === '') {
            console.log(`⚠️ Usuario ${phone} detectado sin nombre. Forzando actualización.`);
            // Actualizamos DB para ponerlo en espera de nombre
            await pool.query("UPDATE clients SET conversation_state = 'WAITING_NAME' WHERE phone_number = $1", [phone]);
            return { status: 'WAITING_NAME' };
        }

        return { 
            status: userData.conversation_state || 'ACTIVE', 
            name: userData.full_name 
        };
    } catch (e) {
        console.error("DB Error:", e.message);
        return { status: 'ERROR' }; 
    }
}

async function initializeUser(phone) {
    try {
        await pool.query(
            `INSERT INTO clients (id, phone_number, conversation_state) VALUES (gen_random_uuid(), $1, 'WAITING_NAME')`,
            [phone]
        );
    } catch (e) { console.error(e); }
}

async function updateUserName(phone, name) {
    try {
        await pool.query(
            `UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2`,
            [name, phone]
        );
        console.log(`✅ Usuario ${phone} actualizado: ${name}`);
    } catch (e) { console.error(e); }
}

async function saveAppointmentToDB(clientPhone, startTime, endTime, googleId) {
    try {
        const res = await pool.query('SELECT id FROM clients WHERE phone_number = $1', [clientPhone]);
        if (res.rows.length > 0) {
            const clientId = res.rows[0].id;
            await pool.query(
                `INSERT INTO appointments (id, client_id, start_time, end_time, status, google_event_id, service_type) 
                 VALUES (gen_random_uuid(), $1, $2, $3, 'confirmed', $4, 'Corte General')`,
                [clientId, startTime, endTime, googleId]
            );
        }
    } catch (e) { console.error("Error DB Cita:", e); }
}

// --- 4. FUNCIONES NEGOCIO ---

async function analyzeWithGemini(userText, userName) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const nowCol = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    
    // Si userName es null, usar "Amigo" en el prompt para evitar "undefined"
    const safeName = userName || "Amigo";

    const prompt = `
      Eres BarberBot de "Alpelo".
      Hablas con: ${safeName}.
      Fecha actual: ${nowCol}.
      Usuario dice: "${userText}"
      
      REGLAS:
      1. Si pide cita, extrae fecha ISO (YYYY-MM-DDTHH:mm:ss-05:00).
      2. Usa el nombre "${safeName}" en tu respuesta.
      
      Responde JSON: { "intent": "booking"|"chat", "date": "ISO"|null, "humanDate": "Texto"|null, "reply": "Texto"|null }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { intent: "chat", reply: `Hola ${userName || 'Amigo'}, ¿en qué te ayudo?` };
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

async function crearEventoCompleto(isoDateStart, clientPhone, clientName) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000); 

        const googleRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: {
                summary: `Cita: ${clientName || 'Cliente'}`,
                description: `Cliente: ${clientPhone}`,
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
                colorId: '2'
            },
        });
        
        await saveAppointmentToDB(clientPhone, start.toISOString(), end.toISOString(), googleRes.data.id);
        return { status: 'success' };
    } catch (error) {
        return { status: 'error', error: error.message };
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
app.listen(PORT, () => { console.log(`🚀 BarberBot V10 (Auto-Fix) corriendo en puerto ${PORT}`); });
