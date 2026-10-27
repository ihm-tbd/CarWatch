// Local car tracker server.
//
// Security properties (see docs/requirements/002-car-tracker.md and
// docs/requirements/003-car-tracker-v2-detail.md, "Security notes"):
//   - Binds to 127.0.0.1 only, never 0.0.0.0.
//   - No outbound network calls of any kind — no HTTP client, no API keys.
//     The only I/O this process does is reading/writing local files under
//     data/ and serving assets to localhost.
//   - The only file this server reads or writes is car-tracker/data/tracker.md,
//     via a fixed, known-safe relative path that still goes through
//     lib/safe-path.js as defense in depth.
//   - Six write endpoints, all POST, all read-only otherwise: /quotes (log
//     a quote), /cars (add a watch), /cars/archive (archive a whole watch),
//     /trims/add (add or restore a trim), /trims/archive (archive a trim),
//     /readings (record one check cycle's price readings). Requirement 004
//     grew the write surface from one endpoint to six; every one goes
//     through the same handleWritePost gate below (Origin, client header,
//     content type, body size) before its lib/*.js submit* function
//     validates the actual fields and writes atomically. See lib/quotes.js,
//     lib/cars.js, lib/trims.js and lib/readings.js for validation and
//     field-injection defenses.
//   - Zero third-party dependencies — only Node's standard library.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAppData } from './lib/tracker-data.js';
import { submitQuote } from './lib/quotes.js';
import { submitNewCar, submitArchiveCar } from './lib/cars.js';
import { submitArchiveTrim, submitAddTrim } from './lib/trims.js';
import { submitReadings } from './lib/readings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname);
// DATA_DIR lets tests (and only tests — it's a startup-time env var, not
// anything a request can influence) point the server at a scratch
// directory instead of the real data/tracker.md, so the write-path tests
// in test/quotes-endpoint.test.js never touch Ian's actual data file.
// Defaults to the real data/ directory, same as always.
const DATA_ROOT = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(APP_ROOT, 'data');
const PUBLIC_ROOT = path.resolve(__dirname, 'public');
const LIB_ROOT = path.resolve(__dirname, 'lib');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 5758;

// The only origin a legitimate request can come from: this app's own page,
// loaded from this exact host and port. Any website Ian has open in another
// tab can otherwise fire a background POST at 127.0.0.1:5758 — being local
// is not a barrier, so this check is required, not optional.
const ALLOWED_ORIGIN = `http://${HOST}:${PORT}`;

// A header name a plain HTML <form> submission cannot set (forms only send
// Content-Type, Accept and a few other browser-controlled headers) and a
// cross-origin `fetch`/XHR can't set either unless the target already opts
// in via CORS — which this server never does. Checked in addition to
// Origin, not instead of it: Origin can be legitimately absent from some
// non-browser clients, but a same-site page never has a reason to omit a
// header it controls itself.
const CLIENT_HEADER = 'x-car-tracker-client';
const CLIENT_HEADER_VALUE = '1';

const MAX_QUOTE_BODY_BYTES = 8 * 1024;
const MAX_WRITE_BODY_BYTES = 8 * 1024;
// A readings submission carries up to MAX_READINGS rows (lib/readings.js),
// each with a free-text source and note — a larger cap than every other
// write endpoint, still fixed and still enforced before any JSON parsing.
const MAX_READINGS_BODY_BYTES = 64 * 1024;

// Fixed, server-controlled static assets — matched exactly against the
// request path, so there is no user-supplied path to sanitize here either.
const STATIC_FILES = {
  '/': { file: path.join(PUBLIC_ROOT, 'index.html'), type: 'text/html; charset=utf-8' },
  '/style.css': { file: path.join(PUBLIC_ROOT, 'style.css'), type: 'text/css; charset=utf-8' },
  '/app.js': { file: path.join(PUBLIC_ROOT, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/markdown.js': { file: path.join(LIB_ROOT, 'markdown.js'), type: 'text/javascript; charset=utf-8' },
  // lib/trend-chart.js and lib/watchlist.js both `import ... from
  // './model.js'` — a browser resolves that relative to the importing
  // script's own URL (i.e. /model.js), so this route has to exist for
  // either of those dynamic imports to load at all. Missing until stage
  // 4a; adding it now since lib/watchlist.js below would otherwise fail
  // to import in the browser the same way (flagged to Lisa in the
  // handoff — no automated way to have caught this without browser
  // automation, which this project doesn't use).
  '/model.js': { file: path.join(LIB_ROOT, 'model.js'), type: 'text/javascript; charset=utf-8' },
  // lib/model.js does `import { DEFAULT_CHECK_INTERVAL_DAYS } from
  // './parse-tracker.js'` — resolved by the browser as /parse-tracker.js,
  // same as the model.js route above. Missing this route 404s the import,
  // which throws inside the dynamic import of trend-chart.js/watchlist.js
  // and leaves the app stuck on "Connecting…" (fix/001-static-module-graph).
  // test/static-module-graph.test.js walks the whole import closure so a
  // future missing route like this one fails a test instead of only
  // failing silently in the browser.
  '/parse-tracker.js': { file: path.join(LIB_ROOT, 'parse-tracker.js'), type: 'text/javascript; charset=utf-8' },
  // Requirement 004, stage 3: the trend chart's hover geometry
  // (formatLongDate, tooltipPosition) is browser-only and depends on
  // which point the user is hovering, so public/app.js imports the pure
  // lib/trend-chart.js module directly at runtime — same pattern as
  // markdown.js above.
  '/trend-chart.js': { file: path.join(LIB_ROOT, 'trend-chart.js'), type: 'text/javascript; charset=utf-8' },
  // Requirement 004, stage 4a: the watchlist's sort comparator (sortRows)
  // is pure and reused unchanged client-side so switching the sort
  // control never needs another round trip — same dynamic-import pattern
  // as trend-chart.js and markdown.js above.
  '/watchlist.js': { file: path.join(LIB_ROOT, 'watchlist.js'), type: 'text/javascript; charset=utf-8' },
  '/fonts/archivo-400.woff2': { file: path.join(PUBLIC_ROOT, 'fonts/archivo-400.woff2'), type: 'font/woff2' },
  '/fonts/archivo-500.woff2': { file: path.join(PUBLIC_ROOT, 'fonts/archivo-500.woff2'), type: 'font/woff2' },
  '/fonts/archivo-600.woff2': { file: path.join(PUBLIC_ROOT, 'fonts/archivo-600.woff2'), type: 'font/woff2' },
  '/fonts/archivo-700.woff2': { file: path.join(PUBLIC_ROOT, 'fonts/archivo-700.woff2'), type: 'font/woff2' },
  '/fonts/archivo-800.woff2': { file: path.join(PUBLIC_ROOT, 'fonts/archivo-800.woff2'), type: 'font/woff2' },
  '/fonts/ibm-plex-mono-400.woff2': { file: path.join(PUBLIC_ROOT, 'fonts/ibm-plex-mono-400.woff2'), type: 'font/woff2' },
  '/fonts/ibm-plex-mono-500.woff2': { file: path.join(PUBLIC_ROOT, 'fonts/ibm-plex-mono-500.woff2'), type: 'font/woff2' },
  '/fonts/ibm-plex-mono-600.woff2': { file: path.join(PUBLIC_ROOT, 'fonts/ibm-plex-mono-600.woff2'), type: 'font/woff2' },
};

const sseClients = new Set();
let broadcastTimer = null;

// Debounce so a burst of saves results in one push, not several. 300ms
// keeps us well inside the 3-second refresh budget.
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    await broadcastTracker();
  }, 300);
}

async function broadcastTracker() {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify(await buildAppData(DATA_ROOT));
  for (const client of sseClients) {
    client.write(`event: tracker\ndata: ${payload}\n\n`);
  }
}

function watchData() {
  try {
    fs.watch(DATA_ROOT, { recursive: true }, () => scheduleBroadcast());
  } catch (err) {
    console.error(`File watcher failed to start (${err.message}); live refresh is disabled.`);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// Reads the request body up to a fixed cap, refusing (rather than silently
// truncating) anything larger — a small local form never needs more than a
// few hundred bytes, so this also blocks a trivial request-flooding abuse
// of any write endpoint in the app.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Shared gate for every write endpoint (requirement 004: the write surface
// grows from one endpoint to four — every one gets the identical treatment
// established for POST /quotes in requirement 003, so the checks live here
// once rather than being re-typed, and possibly re-typed *wrong*, per
// route). Every check below runs before any lib/*.js submit* function ever
// touches the filesystem:
//   1. Origin must match this app's own origin exactly.
//   2. A custom header a cross-origin form/simple request cannot set must
//      be present with the expected value.
//   3. Content-Type must be application/json (also not settable by a plain
//      HTML form submission, and not a CORS-safelisted type, so a
//      cross-origin fetch attempting it would be preflighted and blocked
//      since this server never answers CORS preflight requests).
//   4. Body size is capped before it's ever parsed as JSON.
// Only after all four does `submit` — one of the lib/*.js submit* functions,
// pure read-validate-write, already serialized through
// lib/write-queue.js — validate the actual fields (field-injection defense,
// range checks, stale/forged-id checks) and write atomically.
async function handleWritePost(req, res, submit, maxBodyBytes = MAX_WRITE_BODY_BYTES) {
  const origin = req.headers.origin;
  if (origin !== ALLOWED_ORIGIN) {
    sendJson(res, 403, { ok: false, errors: { form: 'Request blocked: origin did not match this app.' } });
    return;
  }

  if (req.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
    sendJson(res, 403, { ok: false, errors: { form: 'Request blocked: missing required header.' } });
    return;
  }

  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, { ok: false, errors: { form: 'Expected a JSON request body.' } });
    return;
  }

  let raw;
  try {
    raw = await readBody(req, maxBodyBytes);
  } catch {
    sendJson(res, 413, { ok: false, errors: { form: 'Submission was too large.' } });
    return;
  }

  let input;
  try {
    input = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    sendJson(res, 400, { ok: false, errors: { form: 'Could not read the submitted form.' } });
    return;
  }

  const result = await submit(DATA_ROOT, input);
  if (!result.ok) {
    sendJson(res, 422, result);
    return;
  }

  sendJson(res, 201, result);
  scheduleBroadcast();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);

  if (req.method === 'POST' && url.pathname === '/quotes') {
    await handleWritePost(req, res, submitQuote, MAX_QUOTE_BODY_BYTES);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/cars') {
    await handleWritePost(req, res, submitNewCar);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/cars/archive') {
    await handleWritePost(req, res, submitArchiveCar);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/trims/archive') {
    await handleWritePost(req, res, submitArchiveTrim);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/trims/add') {
    await handleWritePost(req, res, submitAddTrim);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/readings') {
    await handleWritePost(req, res, submitReadings, MAX_READINGS_BODY_BYTES);
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    sseClients.add(res);

    const payload = JSON.stringify(await buildAppData(DATA_ROOT));
    res.write(`event: tracker\ndata: ${payload}\n\n`);

    req.on('close', () => sseClients.delete(res));
    return;
  }

  const asset = STATIC_FILES[url.pathname];
  if (asset) {
    try {
      const body = await fsp.readFile(asset.file);
      // No caching: this is a local, live-reloading tool, and a browser's
      // heuristic caching of JS/CSS with no explicit headers can make an
      // edit look like it "didn't take" (fix/001-static-module-graph).
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load asset');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Keep SSE connections alive through any idle-connection timeouts.
setInterval(() => {
  for (const client of sseClients) client.write(': ping\n\n');
}, 25000);

server.listen(PORT, HOST, () => {
  console.log(`Car Watch running at http://${HOST}:${PORT}`);
  watchData();
});
