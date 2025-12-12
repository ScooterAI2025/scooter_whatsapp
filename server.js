// server.js
require('dotenv').config();
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const { Pool } = require('pg');
const app = express();
// Twilio client for sending WhatsApp messages
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require('twilio')(accountSid, authToken);
const reply=process.env.PUBLIC_MESSAGE || 'Thank you for your message! We will get back to you shortly.';
// PostgreSQL connection
const pool = new Pool({
  host: `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,          // your user
  password: process.env.DB_PASSWORD,  // your password
  database: process.env.DB_NAME,      // your database name
});
// Body parsers
app.use(express.urlencoded({ extended: false })); // for Twilio webhook (x-www-form-urlencoded)
app.use(express.json());
// for your frontend JSON requests
// Serve static files 
app.use(express.static(__dirname));
//-----
// app.post('/api/send-message', (req, res) => {
//   console.log('RAW BODY:', req.body);
//   res.json({ body: req.body });
// });
//-----
const cors = require('cors');
app.use(cors());

const port = process.env.PORT || 3000;
app.get('/', (req, res) => {
  res.send('Twilio WhatsApp webhook is running');
});
const clients = new Map();
// SSE endpoint for real-time updates
app.get('/api/messages/stream', (req, res) => {
  const clientId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
  clients.set(clientId, res);
  console.log(`Client ${clientId} connected. Total: ${clients.size}`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch (err) {
      clearInterval(heartbeat);
      clients.delete(clientId);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    console.log(`Client ${clientId} disconnected. Total: ${clients.size}`);
  });
});

function notifyClients(eventData) {
  const data = JSON.stringify(eventData);
  clients.forEach((clientRes, clientId) => {
    try {
      clientRes.write(`data: ${data}\n\n`);
    } catch (err) {
      clients.delete(clientId);
    }
  });
}




// Webhook to receive WhatsApp messages (INBOUND)
app.post('/whatsapp/webhook', async (req, res) => {
  const { From, To, Body, MessageSid } = req.body;
  const message = {
    from: From,
    to: To,
    body: Body,
    messageSid: MessageSid,
    direction: 'inbound',
  };
  // console.log('Inbound message JSON:', message);
  // try {
  //   await pool.query(
  //     'INSERT INTO messages (from_number, to_number, body, direction, message_sid) VALUES ($1, $2, $3, $4, $5)',
  //     [message.from, message.to, message.body, message.direction, message.messageSid]
  //   );
  // } catch (err) {
  try {
    const result = await pool.query(
      'INSERT INTO messages (from_number, to_number, body, direction, message_sid) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [message.from, message.to, message.body, message.direction, message.messageSid]
    );
    
    // Add this line
    notifyClients({ type: 'new_message', message: result.rows[0] });
    
  } catch (err) {
    console.error('DB insert error (inbound):', err);
  }
  //   const twiml = new MessagingResponse();
  //   //twiml.message('Message received!');
  //   res.type('text/xml').send(twiml.toString());

  client.messages
    .create({
      from: message.to,
      to: message.from,
      body: reply , 
    })
    .then(msg => {console.log('Sent with SID:', msg.sid);console.log('Auto-reply sent',reply)})
    .catch(err => console.error(err));

  res.json({ message: "Message received successfully" });
});
// List conversations with last message (for left sidebar)
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (phone)
        phone,
        last_body,
        last_direction,
        last_created_at
      FROM (
        SELECT
          CASE
            WHEN direction = 'inbound' THEN from_number
            ELSE to_number
          END AS phone,
          body        AS last_body,
          direction   AS last_direction,
          created_at  AS last_created_at
        FROM messages
        ORDER BY created_at DESC
      ) sub
      ORDER BY phone, last_created_at DESC;
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('DB select error (conversations list):', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Send WhatsApp message (OUTBOUND) and store in DB
app.post('/api/send-message', async (req, res) => {
  const { to, body } = req.body; // e.g. { "to": "whatsapp:+919363284383", "body": "Hello" }

  // try {
  //   // 1) Send via Twilio
  //   const msg = await client.messages.create({
  //     from: `whatsapp:${process.env.FROM_NUMBER}`, // your Twilio WhatsApp / sandbox number
  //     to,
  //     body,
  //   });
  //   // 2) Save outgoing message
  //   await pool.query(
  //     'INSERT INTO messages (from_number, to_number, body, direction, message_sid) VALUES ($1, $2, $3, $4, $5)',
  //     ['whatsapp:+14155238886', to, body, 'outbound', msg.sid]
  //   );

  //   res.json({ success: true, sid: msg.sid });
  // } catch (err) {
  try {
    const msg = await client.messages.create({
      from: `whatsapp:${process.env.FROM_NUMBER}`,
      to,
      body,
    });
    
    const result = await pool.query(
      'INSERT INTO messages (from_number, to_number, body, direction, message_sid) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      ['whatsapp:+14155238886', to, body, 'outbound', msg.sid]
    );

    // Add this line
    notifyClients({ type: 'new_message', message: result.rows[0] });

    res.json({ success: true, sid: msg.sid });
  } catch (err) {

    console.error('Error sending outbound message:', err);
    res.status(500).json({ error: 'Failed to send' });
  }
});
// Get all messages
app.get('/api/messages', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, from_number, to_number, body, direction, message_sid, created_at FROM messages ORDER BY created_at ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('DB select error (all messages):', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Get messages for specific phone (conversation)
app.get('/api/conversations/:phone/messages', async (req, res) => {
  const phone = req.params.phone; // e.g. "whatsapp:+91XXXXXXXXXX"

  try {
    const result = await pool.query(
      `SELECT id, from_number, to_number, body, direction, message_sid, created_at
       FROM messages
       WHERE from_number = $1 OR to_number = $1
       ORDER BY created_at ASC`,
      [phone]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('DB select error (by phone):', err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});