require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const RESET_TOKEN    = process.env.RESET_TOKEN || '';

// Trust Railway's proxy so req.ip is the real client IP
app.set('trust proxy', 1);

// --- State ---
let queueNumber = 1;
let queueClosed = false;
const clients       = new Set();  // SSE clients
const changeHistory = [];         // { number, timestamp }

// --- Lockout tracking ---
// Map of IP -> { attempts, lockedUntil }
const loginAttempts = new Map();

const TIER1_LIMIT    = 10;
const TIER2_LIMIT    = 20;
const TIER1_DURATION = 15 * 60 * 1000;        // 15 minutes
const TIER2_DURATION = 12 * 60 * 60 * 1000;   // 12 hours

function getAttemptData(ip) {
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { attempts: 0, lockedUntil: null });
  }
  return loginAttempts.get(ip);
}

function getLockoutStatus(ip) {
  const data = getAttemptData(ip);
  const now = Date.now();
  if (data.lockedUntil && now < data.lockedUntil) {
    return { locked: true, until: data.lockedUntil, attempts: data.attempts };
  }
  return { locked: false, attempts: data.attempts };
}

function recordFailure(ip) {
  const data = getAttemptData(ip);
  data.attempts += 1;

  if (data.attempts >= TIER2_LIMIT) {
    data.lockedUntil = Date.now() + TIER2_DURATION;
  } else if (data.attempts >= TIER1_LIMIT) {
    data.lockedUntil = Date.now() + TIER1_DURATION;
  }

  return data;
}

function recordSuccess(ip) {
  loginAttempts.delete(ip);
}

// Middleware to check lockout before any admin endpoint
function checkLockout(req, res, next) {
  const status = getLockoutStatus(req.ip);
  if (status.locked) {
    return res.status(429).json({
      error: 'Too many failed attempts',
      locked: true,
      until: status.until,
      attempts: status.attempts,
    });
  }
  next();
}

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
function scheduleMidnightReset() {
  const now = Date.now();
  const hstMs = now - (10 * 60 * 60 * 1000);
  const msIntoDay = hstMs % (24 * 60 * 60 * 1000);
  const msUntilMidnight = (24 * 60 * 60 * 1000) - msIntoDay;

  console.log(`Queue auto-reset scheduled in ${Math.round(msUntilMidnight / 60000)} minutes (midnight HST)`);

  setTimeout(() => {
    queueNumber = 1;
    queueClosed = false;
    changeHistory.length = 0;
    broadcast({ number: queueNumber, closed: queueClosed });
    console.log('Queue auto-reset to 1 at midnight HST');
    scheduleMidnightReset();
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

// Admin: verify password
app.post('/api/auth', checkLockout, (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    recordSuccess(req.ip);
    res.json({ ok: true });
  } else {
    const data = recordFailure(req.ip);
    const status = getLockoutStatus(req.ip);
    res.status(401).json({
      error: 'Incorrect password',
      locked: status.locked,
      until: status.until,
      attempts: data.attempts,
    });
  }
});

// Admin: update queue number (password-protected)
app.post('/api/queue', checkLockout, (req, res) => {
  const { action, value, password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    const data = recordFailure(req.ip);
    const status = getLockoutStatus(req.ip);
    return res.status(401).json({
      error: 'Incorrect password',
      locked: status.locked,
      until: status.until,
      attempts: data.attempts,
    });
  }

  recordSuccess(req.ip);

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
app.post('/api/closed', checkLockout, (req, res) => {
  const { closed, password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    const data = recordFailure(req.ip);
    const status = getLockoutStatus(req.ip);
    return res.status(401).json({
      error: 'Incorrect password',
      locked: status.locked,
      until: status.until,
      attempts: data.attempts,
    });
  }

  recordSuccess(req.ip);
  queueClosed = Boolean(closed);
  broadcast({ number: queueNumber, closed: queueClosed });
  res.json({ closed: queueClosed });
});

// Reset lockout — visit /api/unlock?token=YOUR_RESET_TOKEN in a browser
app.get('/api/unlock', (req, res) => {
  if (!RESET_TOKEN || req.query.token !== RESET_TOKEN) {
    return res.status(401).send('Invalid or missing token.');
  }
  const count = loginAttempts.size;
  loginAttempts.clear();
  console.log(`Lockouts cleared via reset token (${count} IP(s) cleared)`);
  res.send(`Done — all lockouts cleared (${count} IP(s) unlocked).`);
});

// SSE: real-time updates for display page
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ number: queueNumber, closed: queueClosed })}\n\n`);
  clients.add(res);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(`Queue server running at http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
  if (RESET_TOKEN) {
    console.log(`Unlock URL: http://localhost:${PORT}/api/unlock?token=${RESET_TOKEN}`);
  }
});
