require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// 1. Verificación del Webhook (Para que Meta no se queje)
app.get('/webhook', (req, res) => {
  const verifyToken = process.env.META_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('✅ WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Fallo de verificación de token');
      res.sendStatus(403);
    }
  }
});

// 2. Recepción de Mensajes (Diagnóstico)
app.post('/webhook', async (req, res) => {
  // Respondemos 200 OK inmediatamente
  res.sendStatus(200);

  const body = req.body;

  // Verificamos si es un mensaje
  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from; 
      const text = message.text ? message.text.body : '(Sin texto)';

      console.log(`📩 MENSAJE RECIBIDO DE: ${from}`);
      console.log(`💬 TEXTO: ${text}`);
      
      // INTENTO DE RESPUESTA DIRECTA
      await enviarRespuestaPrueba(from);
    }
  }
});

async function enviarRespuestaPrueba(to) {
    const token = process.env.META_TOKEN;
    const phoneId = process.env.META_PHONE_ID;

    console.log(`🔄 Intentando enviar respuesta...`);
    console.log(`   -> Usando Phone ID: ${phoneId}`);
    // No mostramos el token completo por seguridad, solo el inicio
    console.log(`   -> Token (inicio): ${token ? token.substring(0, 10) + '...' : 'NO DEFINIDO'}`);

    try {
        const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
        
        await axios({
            method: 'POST',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            data: {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: "✅ ¡Conexión Exitosa! El servidor puede responder." }
            }
        });
        console.log("🚀 ¡ÉXITO! Mensaje enviado a WhatsApp.");

    } catch (error) {
        console.error("❌ ERROR AL ENVIAR A WHATSAPP:");
        if (error.response) {
            // El servidor respondió con un código de estado fuera del rango 2xx
            console.error("   Datos del error:", JSON.stringify(error.response.data, null, 2));
            console.error("   Status:", error.response.status);
        } else if (error.request) {
            // La petición fue hecha pero no se recibió respuesta
            console.error("   No hubo respuesta del servidor de Meta.");
        } else {
            // Algo pasó al configurar la petición
            console.error("   Error de configuración:", error.message);
        }
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🛠️ Servidor de Diagnóstico corriendo en puerto ${PORT}`);
});
