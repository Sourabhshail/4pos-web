#!/usr/bin/env node
/**
 * Static file server with Razorpay order + verify API for local development.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, 'razorpay.env');
const PORT = Number(process.env.PORT || 8080);
const RAZORPAY_API = 'https://api.razorpay.com/v1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
};

const PLACEHOLDER_VALUES = new Set([
  '',
  'your_key_secret',
  'your_secret_here',
  'PASTE_YOUR_KEY_SECRET_HERE',
]);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(ENV_FILE);

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

function keysConfigured() {
  if (!KEY_ID || !KEY_SECRET) return false;
  if (PLACEHOLDER_VALUES.has(KEY_ID) || PLACEHOLDER_VALUES.has(KEY_SECRET)) return false;
  if (KEY_ID.includes('REPLACE') || KEY_SECRET.includes('PASTE_')) return false;
  return true;
}

function missingKeysMessage() {
  return (
    'Razorpay Key Secret is missing. Open razorpay.env in the project folder ' +
    'and paste your Key Secret from https://dashboard.razorpay.com/app/keys ' +
    '(same page as your Key ID), then restart the server.'
  );
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  setCorsHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function razorpayRequest(method, endpoint, payload) {
  if (!keysConfigured()) {
    throw Object.assign(new Error(missingKeysMessage()), { statusCode: 500 });
  }

  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'),
    Accept: 'application/json',
  };

  const options = { method, headers };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }

  let response;
  try {
    response = await fetch(`${RAZORPAY_API}${endpoint}`, options);
  } catch (err) {
    throw Object.assign(
      new Error(`Network error contacting Razorpay: ${err.message}`),
      { statusCode: 500 },
    );
  }

  const text = await response.text();
  let detail;
  try {
    detail = text ? JSON.parse(text) : {};
  } catch {
    detail = { error: text || response.statusText };
  }

  if (!response.ok) {
    let message = detail.error;
    if (message && typeof message === 'object') {
      message = message.description || message.reason || JSON.stringify(message);
    }
    throw Object.assign(new Error(message || 'Razorpay API request failed'), {
      statusCode: 500,
    });
  }

  return detail;
}

async function handleCreateOrder(req, res) {
  try {
    const body = await readJsonBody(req);
    const amount = Number.parseInt(body.amount, 10) || 0;
    const currency = String(body.currency || 'USD').toUpperCase();
    const receipt = String(body.receipt || `rcpt_${crypto.randomBytes(6).toString('hex')}`).slice(0, 40);
    const planId = String(body.planId || 'plan');

    if (amount < 100) {
      sendJson(res, 400, {
        error: 'Amount must be at least 100 in the smallest currency unit.',
      });
      return;
    }

    const order = await razorpayRequest('POST', '/orders', {
      amount,
      currency,
      receipt,
      notes: {
        plan_id: planId,
        source: '4pos-website-pricing',
        reference: String(body.reference || '').slice(0, 120),
      },
    });

    sendJson(res, 200, {
      id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    sendJson(res, err.statusCode || 500, { error: err.message });
  }
}

async function handleVerifyPayment(req, res) {
  try {
    const body = await readJsonBody(req);
    const orderId = body.razorpay_order_id || '';
    const paymentId = body.razorpay_payment_id || '';
    const signature = body.razorpay_signature || '';

    if (!orderId || !paymentId || !signature) {
      sendJson(res, 400, {
        error: 'Missing payment verification fields.',
        success: false,
      });
      return;
    }

    if (!keysConfigured()) {
      sendJson(res, 500, { error: missingKeysMessage(), success: false });
      return;
    }

    const expected = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(String(signature));
    const valid =
      expectedBuf.length === signatureBuf.length &&
      crypto.timingSafeEqual(expectedBuf, signatureBuf);

    if (!valid) {
      sendJson(res, 400, { error: 'Invalid payment signature.', success: false });
      return;
    }

    sendJson(res, 200, { success: true, payment_id: paymentId });
  } catch (err) {
    if (err instanceof SyntaxError) {
      sendJson(res, 400, { error: err.message, success: false });
      return;
    }
    sendJson(res, 500, { error: err.message, success: false });
  }
}

function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }

  if (decoded === '/') decoded = '/index.html';

  const filePath = path.normalize(path.join(ROOT, decoded));
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

function serveStatic(req, res) {
  const filePath = resolveStaticPath(req.url || '/');
  if (!filePath) {
    setCorsHeaders(res);
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      setCorsHeaders(res);
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME_TYPES[ext] || 'application/octet-stream';
    setCorsHeaders(res);
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(res);
  });
}

function logRequest(req, statusCode) {
  const now = new Date().toUTCString();
  console.log(`[${now}] "${req.method} ${req.url}" ${statusCode}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    logRequest(req, 204);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/razorpay/create-order') {
    await handleCreateOrder(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/razorpay/verify-payment') {
    await handleVerifyPayment(req, res);
    return;
  }

  if (req.method === 'POST') {
    setCorsHeaders(res);
    res.writeHead(404);
    res.end('Not Found');
    logRequest(req, 404);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serving ${ROOT} on http://localhost:${PORT}`);
  console.log(`Pricing page: http://localhost:${PORT}/#pricing`);
  if (!keysConfigured()) {
    console.log('Warning: add your Razorpay Key Secret to razorpay.env, then restart.');
  } else {
    console.log('Razorpay keys loaded.');
  }
});
