require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.json());

// 1. Configuración de Base de Datos
// Usamos SSL false para evitar errores con certificados autofirmados internos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false 
});

// 2. Verificación del Webhook (Lo que pide Meta para conectarse)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const MY_TOKEN = process.env.META_VERIFY_TOKEN;

  if (mode && token) {
    if (mode === 'subscribe' && token === MY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 3. Recepción de Mensajes (Aquí llega todo lo de WhatsApp)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder OK rápido a Meta

  const body = req.body;

  // Verificar si es un mensaje de WhatsApp
  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from; 
      const text = message.text ? message.text.body : '';

      console.log(`Mensaje recibido de ${from}: ${text}`);

      // AQUÍ IRÁ LA LÓGICA DE IA Y BASE DE DATOS MÁS ADELANTE
    }
  }
});

// Endpoint de Salud (Para ver si el servidor vive)
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.send(`🟢 BarberBot Backend Operativo. Hora DB: ${result.rows[0].now}`);
  } catch (err) {
    res.status(500).send('🔴 Error conectando a BD: ' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});