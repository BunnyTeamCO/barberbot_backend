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
    const text = (message.text ? message.text.body : '').trim();

    console.log(`📩 Mensaje de ${from}: ${text}`);

    try {
      // COMANDO DE RESCATE
      if (text.toLowerCase() === '/reset') {
          await resetUser(from);
          await sendToWhatsApp(from, "🔄 He borrado tu registro. Escríbeme cualquier cosa para empezar de nuevo.");
          return;
      }

      // --- PASO A: IDENTIFICAR QUIÉN ES EL USUARIO ---
      const user = await getDetailedUserState(from);

      // ESCENARIO 1: No existe en la base de datos
      if (user.status === 'NOT_FOUND') {
          await createInitialUser(from);
          await sendToWhatsApp(from, "👋 ¡Hola! Te comunicas con *Alpelo*.\n\nAntes de empezar, **¿cómo es tu nombre?** (Escríbelo aquí abajo)");
          return;
      }

      // ESCENARIO 2: Existe pero no nos ha dado el nombre (conversation_state = 'WAITING_NAME')
      if (user.status === 'WAITING_NAME') {
          if (text.length < 3) {
              await sendToWhatsApp(from, "No seas tímido, ¡dime tu nombre completo para registrarte bien! 😉");
              return;
          }
          await saveNameAndActivate(from, text);
          await sendToWhatsApp(from, `¡Qué nota saludarte, *${text}*! 🤝 Ya estás en mi sistema.\n\nAhora sí, ¿en qué te puedo colaborar? Puedo agendarte una cita o decirte qué servicios tenemos.`);
          return;
      }

      // ESCENARIO 3: Usuario Activo -> Hablar con Gemini
      const clientName = user.name;
      const aiResponse = await talkToGemini(text, clientName);
      console.log("🧠 Respuesta IA:", JSON.stringify(aiResponse));

      let messageToSend = "";

      if (aiResponse.intent === 'booking' && aiResponse.date) {
          // Lógica de agendamiento
          const availability = await checkRealAvailability(aiResponse.date);
          
          if (availability.status === 'busy') {
              messageToSend = `Uff ${clientName}, a esa hora (${aiResponse.humanDate}) ya estoy ocupado. 😅 ¿De pronto te sirve un poquito más tarde?`;
          } else if (availability.status === 'error') {
              messageToSend = `Tuve un problema revisando la agenda, ¿puedes intentar en un minuto? 🙏`;
          } else {
              // Agendar
              const success = await createFinalBooking(aiResponse.date, from, clientName);
              messageToSend = success 
                ? `✅ ¡Listo, *${clientName}*! Te espero el *${aiResponse.humanDate}*. ¡Allá nos vemos!` 
                : `Lo siento, no pude guardar la cita en el calendario.`;
          }
      } else {
          // Respuesta normal de chat
          messageToSend = aiResponse.reply;
      }

      await sendToWhatsApp(from, messageToSend);

    } catch (error) {
      console.error("❌ Error General:", error);
    }
  }
});

// --- 3. FUNCIONES DE BASE DE DATOS ---

async function getDetailedUserState(phone) {
    const res = await pool.query('SELECT full_name, conversation_state FROM clients WHERE phone_number = $1', [phone]);
    if (res.rows.length === 0) return { status: 'NOT_FOUND' };
    
    const row = res.rows[0];
    if (row.conversation_state === 'WAITING_NAME' || !row.full_name || row.full_name === 'undefined') {
        return { status: 'WAITING_NAME' };
    }
    
    return { status: 'ACTIVE', name: row.full_name };
}

async function createInitialUser(phone) {
    await pool.query(
        "INSERT INTO clients (id, phone_number, conversation_state) VALUES (gen_random_uuid(), $1, 'WAITING_NAME')",
        [phone]
    );
}

async function saveNameAndActivate(phone, name) {
    await pool.query(
        "UPDATE clients SET full_name = $1, conversation_state = 'ACTIVE' WHERE phone_number = $2",
        [name, phone]
    );
}

async function resetUser(phone) {
    await pool.query("DELETE FROM appointments WHERE client_id IN (SELECT id FROM clients WHERE phone_number = $1)", [phone]);
    await pool.query("DELETE FROM clients WHERE phone_number = $1", [phone]);
}

// --- 4. CEREBRO GEMINI (NUEVA PERSONALIDAD) ---

async function talkToGemini(userInput, userName) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const now = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });

        const prompt = `
            Eres el barbero dueño de la barbería "Alpelo" en Colombia.
            Tu cliente se llama: ${userName}.
            Hora actual: ${now}.
            Él te dice: "${userInput}"

            TU PERSONALIDAD:
            - Hablas con estilo colombiano (parcero, qué nota, de una, un gusto).
            - Eres PROACTIVO. Si él dice "Hola", no solo digas hola; dile que estás listo para motilarlo o agendarlo.
            - NO repitas la misma frase dos veces. Sé natural.
            - Si pide cita, debes extraer la fecha.

            REGLA DE ORO: Responde SIEMPRE en este formato JSON (sin markdown):
            {
                "intent": "booking" o "chat",
                "date": "ISO_DATE" (si es booking),
                "humanDate": "Texto legible",
                "reply": "Tu respuesta al cliente (si es chat o respuesta de error)"
            }
        `;

        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(text);
    } catch (e) {
        return { intent: "chat", reply: `¡Hola ${userName}! ¿Qué más de cosas? ¿En qué te puedo ayudar hoy?` };
    }
}

// --- 5. FUNCIONES AUXILIARES (Calendario & WhatsApp) ---

async function checkRealAvailability(isoDate) {
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
        const active = res.data.items.filter(e => e.status !== 'cancelled');
        return active.length > 0 ? { status: 'busy' } : { status: 'free' };
    } catch (e) { return { status: 'error', message: e.message }; }
}

async function createFinalBooking(isoDate, phone, name) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        const start = new Date(isoDate);
        const end = new Date(start.getTime() + 60 * 60 * 1000);

        const googleRes = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: {
                summary: `Cita: ${name}`,
                description: `WhatsApp: ${phone}`,
                start: { dateTime: start.toISOString() },
                end: { dateTime: end.toISOString() },
                colorId: '2'
            }
        });

        // Guardar en DB SQL
        const clientRes = await pool.query('SELECT id FROM clients WHERE phone_number = $1', [phone]);
        if (clientRes.rows.length > 0) {
            await pool.query(
                "INSERT INTO appointments (id, client_id, start_time, end_time, google_event_id) VALUES (gen_random_uuid(), $1, $2, $3, $4)",
                [clientRes.rows[0].id, start.toISOString(), end.toISOString(), googleRes.data.id]
            );
        }
        return true;
    } catch (e) { return false; }
}

async function sendToWhatsApp(to, text) {
    try {
        await axios.post(`https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`, {
            messaging_product: 'whatsapp',
            to: to,
            text: { body: text }
        }, { headers: { 'Authorization': `Bearer ${process.env.META_TOKEN}` } });
    } catch (e) { console.error("Error WhatsApp:", e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BarberBot V12 (Humanizado) en puerto ${PORT}`));
