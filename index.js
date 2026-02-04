require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Verificación Webhook
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// Recepción de Mensajes
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; 
    const text = message.text ? message.text.body : '(Sin texto)';

    console.log(`📩 Mensaje recibido: ${text}`);

    // RESPUESTA SIMPLE (ECO)
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
                to: from,
                text: { body: `🤖 Dijiste: "${text}". \n\nSi lees esto, ¡WhatsApp está conectado!` }
            }
        });
        console.log("✅ Respuesta enviada");
    } catch (error) {
        console.error("❌ Error enviando: ", error.response ? error.response.data : error.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Modo Eco Activo en puerto ${PORT}`);
});
