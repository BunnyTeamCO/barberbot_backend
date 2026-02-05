require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

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

  if (body.object && body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const text = message.text ? message.text.body : '';

    console.log(`📩 Mensaje de ${from}: ${text}`);

    try {
      // COMANDO SECRETO: Reiniciar usuario para pruebas
      if (text.toLowerCase() === '/reset') {
          await resetUser(from);
          await sendToWhatsApp(from, "🔄 Memoria reiniciada. Escríbeme 'Hola' para empezar de cero.");
          return;
      }

      // 1. GESTIÓN DE ESTADO
      const userState = await checkUserState(from);

      // CASO A: Usuario Nuevo -> Saludar y Pedir Nombre
      if (userState.status === 'NEW') {
          await initializeUser(from);
          await sendToWhatsApp(from, "👋 ¡Hola! Bienvenido a *Alpelo*.\n\nSoy tu asistente virtual. Para atenderte como te mereces, **¿me regalas tu nombre?**");
          return; 
      }

      // CASO B: Usuario "Roto" (Existía pero sin nombre válido)
      if (userState.status === 'FORCE_UPDATE') {
          await sendToWhatsApp(from, "Disculpa, estoy actualizando mi agenda y no encuentro tu nombre. 🙏 **¿Me lo podrías escribir nuevamente?**");
          return;
      }

      // CASO C: Esperando Nombre -> Guardar
      if (userState.status === 'WAITING_NAME') {
          const newName = text.trim();
          if (newName.length < 3) {
             await sendToWhatsApp(from, "Ese nombre es muy corto. 🤔 ¿Cómo te llamas realmente?");
             return;
          }
          await updateUserName(from, newName);
          await sendToWhatsApp(from, `¡Listo ${newName}! Un gusto saludarte. 🤝\n\nCuéntame, ¿qué necesitas? Puedes pedirme una cita (ej: "mañana a las 4pm") o preguntarme horarios.`);
          return;
      }

      // CASO D: Usuario Activo -> Hablar con IA
      const clientName = userState.name; 
      const aiAnalysis = await analyzeWithGemini(text, clientName);
      console.log("🧠 IA:", JSON.stringify(aiAnalysis));

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        // Verificar Disponibilidad
        const availability = await checkRealAvailability(aiAnalysis.date);
        
        if (availability.status === 'error') {
            finalResponse = `🔧 Tuve un problema técnico revisando la agenda. Intenta en un momento.`;
            console.error(availability.message);
        } else if (availability.status === 'busy') {
            finalResponse = `Uff ${clientName}, justo a esa hora (${aiAnalysis.humanDate}) ya estoy ocupado. 😅 ¿Te sirve una hora antes o después?`;
        } else {
            // Agendar
            const booking = await crearEventoCompleto(aiAnalysis.date, from, clientName);
            if (booking.status === 'success') {
                finalResponse = `✅ ¡Agendado, ${clientName}!\n\nTe espero el *${aiAnalysis.humanDate}*.`;
            } else {
                finalResponse = `No pude guardar la cita por un error técnico. 😞`;
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

// --- 3. FUNCIONES DE ESTADO ---

async function resetUser(phone) {
    await pool.query('DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE phone_number = $1)', [phone]);
    await pool.query('DELETE FROM clients WHERE phone_number = $1', [phone]);
    console.log(`🗑️ Usuario ${phone} reseteado.`);
}

async function checkUserState(phone) {
    try {
        const res = await pool.query('SELECT conversation_state, full_name FROM clients WHERE phone_number = $1', [phone]);
        
        if (res.rows.length === 0) {
            return { status: 'NEW' };
        }

        const userData = res.rows[0];
        
        // Si está marcado como WAITING_NAME en la BD, devolver ese estado
        if (userData.conversation_state === 'WAITING_NAME') {
            return { status: 'WAITING_NAME' };
        }

        // AUTO-REPARACIÓN: Si está "ACTIVE" pero no tiene nombre válido
        if (!userData.full_name || userData.full_name === 'undefined' || userData.full_name.trim().length < 2) {
            console.log(`⚠️ Usuario ${phone} sin nombre válido. Forzando petición.`);
            // Cambiamos estado en BD a WAITING_NAME para que el PRÓXIMO mensaje lo capture como nombre
            await pool.query("UPDATE clients SET conversation_state = 'WAITING_NAME' WHERE phone_number = $1", [phone]);
            return { status: 'FORCE_UPDATE' }; // Devolvemos estado especial para pedir nombre AHORA
        }

        return { 
            status: 'ACTIVE', 
            name: userData.full_name 
        };
    } catch (e) {
        console.error("DB Error:", e);
        return { status: 'ACTIVE', name: 'Amigo' }; // Fallback de emergencia
    }
}

async function initializeUser(phone) {
    await pool.query(
        `INSERT INTO clients (id, phone_number, conversation_state) VALUES (gen_random_uuid(), $1, 'WAITING_NAME')`,
        [phone]
    );
}

async function updateUserName(phone, name) {
    await pool.query(
        `UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2`,
        [name, phone]
    );
}

// --- 4. INTELIGENCIA ARTIFICIAL (HUMANIZADA) ---

async function analyzeWithGemini(userText, userName) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const nowCol = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    
    // Prompt "Parcero"
    const prompt = `
      Actúa como el asistente de la barbería "Alpelo" en Colombia. 
      Hablas con: ${userName}.
      Fecha y hora actual: ${nowCol}.
      Mensaje del usuario: "${userText}"
      
      PERSONALIDAD:
      - Eres amable, profesional pero cercano (estilo colombiano educado).
      - NO seas repetitivo. Si el usuario solo saluda, no le preguntes "¿en qué te ayudo?" 5 veces seguidas. Varía tu respuesta.
      - Si el usuario dice "Gracias", responde con "Con gusto", "A la orden", etc.
      
      INSTRUCCIONES CLAVE:
      1. Si el usuario quiere cita (ej: "cita mañana a las 3", "tienes espacio el viernes"), extrae la fecha ISO (YYYY-MM-DDTHH:mm:ss-05:00).
      2. Si solo saluda ("Hola", "Buenas"), saluda de vuelta usando su nombre y espera a que él pida.
      
      Responde SOLO JSON:
      {
        "intent": "booking" | "chat",
        "date": "ISO"|null,
        "humanDate": "Ej: Viernes 3pm" (o null),
        "reply": "Texto de respuesta natural" (o null)
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { intent: "chat", reply: `Hola ${userName}, cuéntame, ¿qué necesitas hoy?` };
  }
}

// ... (Resto de funciones: checkRealAvailability, crearEventoCompleto, sendToWhatsApp se mantienen IGUAL que la V10)
// Copia las funciones auxiliares de la versión anterior o asegúrate de que estén en el archivo.
// AQUI LAS PONGO PARA QUE SEA COPY-PASTE COMPLETO:

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
    } catch (e) { console.error("DB Error:", e); }
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
                summary: `Cita: ${clientName}`,
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
app.listen(PORT, () => { console.log(`🚀 BarberBot V11 (Humanizado) puerto ${PORT}`); });
