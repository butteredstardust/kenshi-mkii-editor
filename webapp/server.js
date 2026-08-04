'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');

const apiRoutes = require('./routes/api');

const app = express();
const PORT = Number(process.env.KENSHI_MKII_PORT) || 3080;
const csrfToken = crypto.randomBytes(32).toString('base64url');

app.disable('x-powered-by');

// This app can overwrite a live save. It binds to loopback and refuses any
// request that did not arrive addressed to loopback.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).json({ error: 'Invalid Host' });
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'",
  });
  next();
});

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/session', (req, res) => res.json({ csrfToken }));

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return res.status(403).json({ error: 'Cross-origin mutation rejected' });
  }
  if (req.headers['x-csrf-token'] !== csrfToken) {
    return res.status(403).json({ error: 'Missing or invalid CSRF token' });
  }
  next();
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && Object.hasOwn(err, 'body')) {
    return res.status(400).json({ error: 'Malformed JSON request body' });
  }
  next(err);
});

app.use('/api', apiRoutes);

app.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console -- boot confirmation; no logger in this app
  console.log(`Kenshi MKII Editor on http://127.0.0.1:${PORT} (loopback only)`);
});
