require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURACIÓN ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Limpieza robusta de la llave privada
const privateKey = process.env.GOOGLE_PRIVATE_KEY 
  ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') 
  : '';

const jwtClient = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  privateKey,
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
      // 1. PENSAR (IA)
      const aiAnalysis = await analyzeWithGemini(text);
      console.log("🧠 Análisis IA:", JSON.stringify(aiAnalysis));

      let finalResponse = "";

      if (aiAnalysis.intent === 'booking' && aiAnalysis.date) {
        // 2. VERIFICAR CALENDARIO
        const availability = await checkRealAvailability(aiAnalysis.date);
        
        if (availability.status === 'error') {
            // ERROR TÉCNICO: Avisar al usuario para arreglarlo
            finalResponse = `🔧 **Error de Sistema:** \n${availability.message}\n\n(Revisa tus variables en Coolify)`;
        } else if (availability.status === 'busy') {
            // OCUPADO REAL
            finalResponse = `😅 Uff, revisé mi agenda y justo a esa hora (${aiAnalysis.humanDate}) ya estoy ocupado. ¿Te sirve probar una hora más tarde?`;
        } else {
            // LIBRE
            finalResponse = `✅ ¡Listo! Tengo espacio libre para el ${aiAnalysis.humanDate}. ¿Te lo aparto de una vez?`;
        }
      } else {
        // CHARLA CASUAL
        finalResponse = aiAnalysis.reply;
      }

      await sendToWhatsApp(from, finalResponse);

    } catch (error) {
      console.error("❌ Error Crítico:", error);
    }
  }
});

// --- FUNCIONES ---

async function analyzeWithGemini(userText) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const nowCol = new Date().toLocaleString("es-CO", { timeZone: "America/Bogota" });
    
    const prompt = `
      Eres BarberBot, un asistente amable y relajado de una barbería en Colombia.
      Fecha actual: ${nowCol}.
      Usuario dice: "${userText}"
      
      REGLAS DE ORO:
      1. Si el usuario dice "Hola", "Buenos días", "Precios", o NO menciona una fecha/hora específica -> Intent es "chat". NO inventes fechas.
      2. Solo si dice explícitamente "quiero cita mañana", "el viernes a las 3", etc -> Intent es "booking".
      
      Responde SOLO JSON:
      {
        "intent": "booking" | "chat",
        "date": "YYYY-MM-DDTHH:mm:ss-05:00" (Solo si es booking, sino null),
        "humanDate": "Ej: Viernes 3pm" (o null),
        "reply": "Tu respuesta amable aquí" (Solo si es chat)
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { intent: "chat", reply: "Hola, ¿en qué te puedo ayudar hoy?" };
  }
}

async function checkRealAvailability(isoDateStart) {
    try {
        await jwtClient.authorize();
        const calendar = google.calendar({ version: 'v3', auth: jwtClient });
        
        const start = new Date(isoDateStart);
        const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hora

        const calendarId = process.env.GOOGLE_CALENDAR_ID;
        if (!calendarId) throw new Error("Falta la variable GOOGLE_CALENDAR_ID");

        const res = await calendar.events.list({
            calendarId: calendarId,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true
        });

        // Filtrar eventos cancelados
        const activeEvents = res.data.items.filter(e => e.status !== 'cancelled');

        if (activeEvents.length > 0) {
            return { status: 'busy' };
        }
        return { status: 'free' };

    } catch (error) {
        console.error("❌ Error Calendario:", error.message);
        
        // Diagnóstico de errores comunes para enviar al chat
        let userMsg = "No pude conectar con el calendario.";
        
        if (error.message.includes("Not Found")) {
            userMsg = `❌ Error: No encuentro el calendario "${process.env.GOOGLE_CALENDAR_ID}". \n👉 Asegúrate de haberlo COMPARTIDO con el email del robot: ${process.env.GOOGLE_CLIENT_EMAIL}`;
        } else if (error.message.includes("Invalid grant") || error.message.includes("signing")) {
            userMsg = "❌ Error: La LLAVE PRIVADA (Private Key) está mal copiada en Coolify.";
        } else if (error.message.includes("Service accounts cannot invite")) {
             userMsg = "❌ Error: Permisos insuficientes. Dale permiso de 'Hacer cambios' al robot.";
        }

        return { status: 'error', message: userMsg };
    }
}

async function sendToWhatsApp(to, textBody) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v18.0/${process.env.META_PHONE_ID}/messages`,
            headers: {
                'Authorization': `Bearer ${process.env.META_TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: textBody }
            }
        });
    } catch (error) {
        console.error("Error envío WhatsApp", error.message);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 BarberBot V3 (Diagnóstico) puerto ${PORT}`);
});
