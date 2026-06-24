require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

// --- State ---
let queueNumber = 1;
const clients = new Set(); // SSE clients

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- SSE: broadcast to all connected display clients ---
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// --- Routes ---

// Public: get current queue number
app.get('/api/queue', (req, res) => {
  res.json({ number: queueNumber });
});

// Admin: update queue number (password-protected)
app.post('/api/queue', (req, res) => {
  const { action, value, password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  if (action === 'increment') {
    queueNumber += 1;
  } else if (action === 'decrement') {
    queueNumber = Math.max(0, queueNumber - 1);
  } else if (action === 'set' && typeof value === 'number') {
    queueNumber = Math.max(0, Math.floor(value));
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }

  broadcast({ number: queueNumber });
  res.json({ number: queueNumber });
});

// Admin: verify password (used by admin page on load)
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// SSE: real-time updates for display page
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  // Send current number immediately on connect
  res.write(`data: ${JSON.stringify({ number: queueNumber })}\n\n`);

  clients.add(res);

  // Heartbeat every 25s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(`Queue server running at http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
