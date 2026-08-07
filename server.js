require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

// --- State ---
let queueNumber = 1;
let queueClosed = false;
const clients = new Set(); // SSE clients
const changeHistory = []; // { number, timestamp }

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

// --- Midnight HST auto-reset ---
// HST is always UTC-10 (no daylight saving)
function scheduleMidnightReset() {
  const now = Date.now();
  const hstMs = now - (10 * 60 * 60 * 1000);          // current time in HST as ms
  const msIntoDay = hstMs % (24 * 60 * 60 * 1000);    // how far into the HST day we are
  const msUntilMidnight = (24 * 60 * 60 * 1000) - msIntoDay;

  console.log(`Queue auto-reset scheduled in ${Math.round(msUntilMidnight / 60000)} minutes (midnight HST)`);

  setTimeout(() => {
    queueNumber = 1;
    queueClosed = false;
    changeHistory.length = 0;
    broadcast({ number: queueNumber, closed: queueClosed });
    console.log('Queue auto-reset to 1 at midnight HST');
    scheduleMidnightReset(); // schedule the next night
  }, msUntilMidnight);
}

scheduleMidnightReset();

// --- Routes ---

// Public: get current queue state
app.get('/api/queue', (req, res) => {
  res.json({ number: queueNumber, closed: queueClosed });
});

// Public: get change history
app.get('/api/history', (req, res) => {
  res.json(changeHistory);
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

  changeHistory.push({ number: queueNumber, timestamp: Date.now() });
  broadcast({ number: queueNumber, closed: queueClosed });
  res.json({ number: queueNumber, closed: queueClosed });
});

// Admin: toggle queue open/closed (password-protected)
app.post('/api/closed', (req, res) => {
  const { closed, password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  queueClosed = Boolean(closed);
  broadcast({ number: queueNumber, closed: queueClosed });
  res.json({ closed: queueClosed });
});

// Admin: verify password
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

  // Send current state immediately on connect
  res.write(`data: ${JSON.stringify({ number: queueNumber, closed: queueClosed })}\n\n`);

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
