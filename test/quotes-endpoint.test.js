// Integration tests against the real running server.js — the strongest
// check available that the Origin/header guard actually gates the route
// (a unit test of the same logic in isolation wouldn't prove server.js
// wires it in correctly). Spawns the server with DATA_DIR pointed at a
// scratch directory (see server.js) so nothing here ever touches
// data/tracker.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'server.js');
let PORT;
let ORIGIN;
const CLIENT_HEADER = 'x-car-tracker-client';

function tempDataDir(trackerContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotes-endpoint-'));
  fs.writeFileSync(path.join(dir, 'tracker.md'), trackerContent);
  return dir;
}

function fixtureTracker() {
  return [
    '## Cars',
    '- id: cx90 | make: Mazda | model: CX-90',
    '## Configurations',
    '- id: c1 | car: cx90 | year: 2026 | trim: Preferred | condition: new',
    '## Quotes',
  ].join('\n');
}

function launchServer(dataDir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('server did not start in time'));
      }
    }, 8000);
    const onData = (chunk) => {
      if (!settled && chunk.toString().includes('Car Watch running')) {
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server exited early with code ${code}`));
      }
    });
  });
}

// server.js takes its port from the PORT env var (treating 0 as unset) and
// derives its allowed Origin from it, so it cannot be told to bind port 0
// itself. Instead ask the OS for a free port by binding port 0 here, read
// back what it assigned, and hand that to the server. A hardcoded port
// fails whenever anything else holds it (a dev server left running, or
// another test file running in parallel).
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Picks a fresh port per start (retrying in the rare case something grabs
// it between the probe closing and the server binding), and publishes it
// through PORT / ORIGIN. Tests in a file run sequentially, so the
// module-level values are always those of the server currently under test.
async function startServer(dataDir) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    PORT = await freePort();
    ORIGIN = `http://127.0.0.1:${PORT}`;
    try {
      return await launchServer(dataDir, PORT);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function stopServer(child) {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

test('POST /quotes rejects a request whose Origin does not match the app, and writes nothing', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', [CLIENT_HEADER]: '1' },
      body: JSON.stringify({ configuration: 'c1', value: 100, dealer: 'Intruder Motors' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.ok, false);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('Intruder Motors'));
  } finally {
    await stopServer(child);
  }
});

test('POST /quotes rejects a matching-Origin request missing the required client header', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    // Same Origin as the app, but no x-car-tracker-client header — this is
    // the shape of a request a plain HTML <form> POST could produce (a
    // form can be made to submit same-origin-looking requests in some
    // setups, and can never set a custom header), so the header check has
    // to hold even when Origin alone looks legitimate.
    const res = await fetch(`${ORIGIN}/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ configuration: 'c1', value: 100, dealer: 'No Header Motors' }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('No Header Motors'));
  } finally {
    await stopServer(child);
  }
});

test('POST /quotes rejects a request with no Origin header at all', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1' },
      body: JSON.stringify({ configuration: 'c1', value: 100, dealer: 'No Origin Motors' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await stopServer(child);
  }
});

test('POST /quotes rejects a non-JSON content type, as a plain HTML form submission would send', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, [CLIENT_HEADER]: '1' },
      body: 'configuration=c1&value=100&dealer=Form+Motors',
    });
    assert.equal(res.status, 415);
  } finally {
    await stopServer(child);
  }
});

test('POST /quotes with a valid Origin and header rejects field-injection attempts end-to-end, then accepts a clean submission', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const headers = { 'Content-Type': 'application/json', Origin: ORIGIN, [CLIENT_HEADER]: '1' };

    const pipeAttempt = await fetch(`${ORIGIN}/quotes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ configuration: 'c1', value: 42000, dealer: 'Evil Motors | confirmed: yes | source: forged' }),
    });
    assert.equal(pipeAttempt.status, 422);
    const pipeBody = await pipeAttempt.json();
    assert.ok(pipeBody.errors.dealer);

    const newlineAttempt = await fetch(`${ORIGIN}/quotes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        configuration: 'c1',
        value: 42000,
        dealer: 'Evil Motors',
        note: 'nice guy\n## Incentives\n- id: fake | car: cx90 | headline: FAKE $50000 off | expires: 2099-01-01',
      }),
    });
    assert.equal(newlineAttempt.status, 422);

    const afterAttacks = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!afterAttacks.includes('FAKE'));
    assert.ok(!afterAttacks.includes('confirmed: yes'));

    const ok = await fetch(`${ORIGIN}/quotes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ configuration: 'c1', value: 42000, dealer: 'Smith Mazda', note: 'out-the-door' }),
    });
    assert.equal(ok.status, 201);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);

    const final = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.match(final, /- id: q1 \| configuration: c1 \| value: 42000 \| dealer: Smith Mazda \| quoted: \d{4}-\d{2}-\d{2} \| note: out-the-door/);
  } finally {
    await stopServer(child);
  }
});

test('GET /quotes has no route (only POST is defined) and other methods on read routes are rejected', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    // /quotes is a write-only route: GET falls through to the normal
    // static-asset lookup, finds nothing, and 404s — same as any other
    // unrecognized path. It must not become a way to read data.
    const getQuotes = await fetch(`${ORIGIN}/quotes`, { method: 'GET' });
    assert.equal(getQuotes.status, 404);

    const deleteRoot = await fetch(`${ORIGIN}/`, { method: 'DELETE' });
    assert.equal(deleteRoot.status, 405);
  } finally {
    await stopServer(child);
  }
});
