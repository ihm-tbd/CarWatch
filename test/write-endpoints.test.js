// Integration tests against the real running server.js for the write
// endpoints requirement 004 added (POST /cars, POST /trims/add, POST
// /trims/archive, POST /readings) — same reasoning as
// test/quotes-endpoint.test.js: a unit test of lib/cars.js, lib/trims.js or
// lib/readings.js in isolation wouldn't prove server.js's Origin/header
// gate is actually wired in front of them. Spawns the server with DATA_DIR
// pointed at a scratch directory so nothing here ever touches
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
// Origin is filled in by startServer once the port is known.
const HEADERS = { 'Content-Type': 'application/json', Origin: '', [CLIENT_HEADER]: '1' };

function tempDataDir(trackerContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-endpoints-'));
  fs.writeFileSync(path.join(dir, 'tracker.md'), trackerContent);
  return dir;
}

function fixtureTracker() {
  return [
    '## Cars',
    '- id: cx90 | make: Mazda | model: CX-90 | years: 2026 | trims: Preferred | conditions: new | zip: | created: | check_interval_days: 14 | last_checked:',
    '## Configurations',
    '- id: cx90-2026-preferred | car: cx90 | year: 2026 | trim: Preferred | condition: new',
    '## Price points',
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
    HEADERS.Origin = ORIGIN;
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

// --- POST /cars -----------------------------------------------------------

test('POST /cars rejects a request whose Origin does not match the app, and writes nothing', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/cars`, {
      method: 'POST',
      headers: { ...HEADERS, Origin: 'http://evil.example' },
      body: JSON.stringify({ make: 'Intruder', model: 'Motors', conditions: ['new'] }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('Intruder'));
  } finally {
    await stopServer(child);
  }
});

test('POST /cars rejects a matching-Origin request missing the required client header', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/cars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ make: 'No Header', model: 'Motors', conditions: ['new'] }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('No Header'));
  } finally {
    await stopServer(child);
  }
});

test('POST /cars rejects a request with no Origin header at all', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/cars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: '1' },
      body: JSON.stringify({ make: 'No Origin', model: 'Motors', conditions: ['new'] }),
    });
    assert.equal(res.status, 403);
  } finally {
    await stopServer(child);
  }
});

test('POST /cars rejects a non-JSON content type, as a plain HTML form submission would send', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/cars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, [CLIENT_HEADER]: '1' },
      body: 'make=Form&model=Motors',
    });
    assert.equal(res.status, 415);
  } finally {
    await stopServer(child);
  }
});

test('POST /cars with a valid Origin and header rejects field-injection attempts end-to-end, then accepts a clean submission', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const pipeAttempt = await fetch(`${ORIGIN}/cars`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ make: 'Evil Motors | created: 2000-01-01', model: 'Forgery', conditions: ['new'] }),
    });
    assert.equal(pipeAttempt.status, 422);
    const pipeBody = await pipeAttempt.json();
    assert.ok(pipeBody.errors.make);

    const newlineAttempt = await fetch(`${ORIGIN}/cars`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        make: 'Evil Motors',
        model: 'Forgery\n## Incentives\n- id: fake | car: cx90 | headline: FAKE $50000 off | expires: 2099-01-01',
        conditions: ['new'],
      }),
    });
    assert.equal(newlineAttempt.status, 422);

    const afterAttacks = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!afterAttacks.includes('FAKE'));

    const ok = await fetch(`${ORIGIN}/cars`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ make: 'Kia', model: 'Telluride', years: '2026', trims: ['EX'], conditions: ['new'] }),
    });
    assert.equal(ok.status, 201);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.carId, 'kia-telluride');

    const final = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.match(final, /- id: kia-telluride \| make: Kia \| model: Telluride/);
  } finally {
    await stopServer(child);
  }
});

// --- POST /cars/archive -----------------------------------------------------
//
// No test moved the count while this endpoint was built (see requirement
// 004, "Security notes": "a forged archive request that hid a car would
// be a real loss of access to data") — same treatment every other write
// endpoint above already gets.

test('POST /cars/archive rejects a request whose Origin does not match the app, and archives nothing', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/cars/archive`, {
      method: 'POST',
      headers: { ...HEADERS, Origin: 'http://evil.example' },
      body: JSON.stringify({ carId: 'cx90' }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('archived: yes'));
  } finally {
    await stopServer(child);
  }
});

test('POST /cars/archive rejects a request missing the required client header', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/cars/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ carId: 'cx90' }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('archived: yes'));
  } finally {
    await stopServer(child);
  }
});

test('POST /cars/archive rejects a non-JSON content type, as a plain HTML form submission would send', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/cars/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, [CLIENT_HEADER]: '1' },
      body: 'carId=cx90',
    });
    assert.equal(res.status, 415);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('archived: yes'));
  } finally {
    await stopServer(child);
  }
});

test('POST /cars/archive with a forged carId is rejected server-side even with valid Origin and header', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/cars/archive`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ carId: 'does-not-exist' }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.errors.carId);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('archived: yes'));
  } finally {
    await stopServer(child);
  }
});

test('POST /cars/archive rejects delimiter injection in carId, and archives nothing', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const before = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    const res = await fetch(`${ORIGIN}/cars/archive`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ carId: 'cx90 | archived: yes\n## Incentives\n- id: fake | headline: FAKE $50000 off | expires: 2099-01-01' }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.errors.carId);
    const after = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.equal(after, before);
    assert.ok(!after.includes('FAKE'));
  } finally {
    await stopServer(child);
  }
});

test('POST /cars/archive archives a real car end-to-end, and refuses to archive it a second time', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const archive = await fetch(`${ORIGIN}/cars/archive`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ carId: 'cx90' }),
    });
    assert.equal(archive.status, 201);
    const afterArchive = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.match(afterArchive, /- id: cx90 \|.*\| archived: yes$/m);

    const again = await fetch(`${ORIGIN}/cars/archive`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ carId: 'cx90' }),
    });
    assert.equal(again.status, 422);
    const againBody = await again.json();
    assert.ok(againBody.errors.carId);
  } finally {
    await stopServer(child);
  }
});

// --- POST /trims/archive and /trims/add ------------------------------------

test('POST /trims/archive rejects a request whose Origin does not match the app, and archives nothing', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/trims/archive`, {
      method: 'POST',
      headers: { ...HEADERS, Origin: 'http://evil.example' },
      body: JSON.stringify({ carId: 'cx90', trim: 'Preferred' }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('archived: yes'));
  } finally {
    await stopServer(child);
  }
});

test('POST /trims/archive rejects a request missing the required client header', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/trims/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ carId: 'cx90', trim: 'Preferred' }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('archived: yes'));
  } finally {
    await stopServer(child);
  }
});

test('POST /trims/archive with a forged carId is rejected server-side even with valid Origin and header', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/trims/archive`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ carId: 'does-not-exist', trim: 'Preferred' }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.errors.carId);
  } finally {
    await stopServer(child);
  }
});

test('POST /trims/archive archives a real trim end-to-end, and POST /trims/add restores it intact', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const archive = await fetch(`${ORIGIN}/trims/archive`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ carId: 'cx90', trim: 'Preferred' }),
    });
    assert.equal(archive.status, 201);
    const afterArchive = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.match(afterArchive, /- id: cx90-2026-preferred \| car: cx90 \| year: 2026 \| trim: Preferred \| condition: new \| archived: yes/);

    const restore = await fetch(`${ORIGIN}/trims/add`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ carId: 'cx90', trim: 'Preferred' }),
    });
    assert.equal(restore.status, 201);
    const restoreBody = await restore.json();
    assert.equal(restoreBody.restored, true);
    const afterRestore = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.match(afterRestore, /- id: cx90-2026-preferred \| car: cx90 \| year: 2026 \| trim: Preferred \| condition: new$/m);
  } finally {
    await stopServer(child);
  }
});

test('POST /trims/add rejects a field-injection attempt end-to-end and writes nothing', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const before = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    const res = await fetch(`${ORIGIN}/trims/add`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ carId: 'cx90', trim: 'Signature\n## Incentives\n- id: fake | headline: FAKE' }),
    });
    assert.equal(res.status, 422);
    const after = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.equal(after, before);
    assert.ok(!after.includes('FAKE'));
  } finally {
    await stopServer(child);
  }
});

// --- POST /readings ---------------------------------------------------------

test('POST /readings rejects a request whose Origin does not match the app, and writes nothing', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/readings`, {
      method: 'POST',
      headers: { ...HEADERS, Origin: 'http://evil.example' },
      body: JSON.stringify({
        carId: 'cx90',
        readings: [{ configuration: 'cx90-2026-preferred', value: 99999, basis: 'msrp', source: 'Intruder', confirmed: true }],
      }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('Intruder'));
  } finally {
    await stopServer(child);
  }
});

test('POST /readings rejects a request missing the required client header', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({
        carId: 'cx90',
        readings: [{ configuration: 'cx90-2026-preferred', value: 99999, basis: 'msrp', source: 'No Header', confirmed: true }],
      }),
    });
    assert.equal(res.status, 403);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('No Header'));
  } finally {
    await stopServer(child);
  }
});

test('POST /readings rejects a non-JSON content type, as a plain HTML form submission would send', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, [CLIENT_HEADER]: '1' },
      body: 'carId=cx90',
    });
    assert.equal(res.status, 415);
  } finally {
    await stopServer(child);
  }
});

test('POST /readings with a forged configuration id is rejected server-side even with valid Origin and header', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/readings`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        carId: 'cx90',
        readings: [{ configuration: 'does-not-exist', value: 100, basis: 'msrp', source: 'X', confirmed: true }],
      }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.errors.readings['does-not-exist']);
    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.ok(!content.includes('configuration: does-not-exist'));
  } finally {
    await stopServer(child);
  }
});

test('POST /readings rejects a field-injection attempt in the source text end-to-end, and writes nothing for the whole cycle', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const before = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    const res = await fetch(`${ORIGIN}/readings`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        carId: 'cx90',
        readings: [
          {
            configuration: 'cx90-2026-preferred',
            value: 43450,
            basis: 'msrp',
            source: 'Mazda USA\n## Incentives\n- id: fake | headline: FAKE $50000 off | expires: 2099-01-01',
            confirmed: true,
          },
        ],
      }),
    });
    assert.equal(res.status, 422);
    const after = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.equal(after, before);
    assert.ok(!after.includes('FAKE'));
  } finally {
    await stopServer(child);
  }
});

test('POST /readings with a valid submission writes a price point and updates last_checked end-to-end', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    const res = await fetch(`${ORIGIN}/readings`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        carId: 'cx90',
        readings: [
          { configuration: 'cx90-2026-preferred', value: 43450, basis: 'msrp', source: 'Mazda USA', confirmed: true },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.count, 1);

    const content = fs.readFileSync(path.join(dir, 'tracker.md'), 'utf8');
    assert.match(content, /- id: pp1 \| configuration: cx90-2026-preferred \| value: 43450 \| basis: msrp/);
    assert.match(content, /- id: cx90 \|.*last_checked: \d{4}-\d{2}-\d{2}/);
  } finally {
    await stopServer(child);
  }
});

// --- routing sanity ---------------------------------------------------------

test('GET on write-only routes has no route and falls through to a 404, not a data read', async () => {
  const dir = tempDataDir(fixtureTracker());
  const child = await startServer(dir);
  try {
    for (const route of ['/cars', '/cars/archive', '/trims/archive', '/trims/add', '/readings']) {
      const res = await fetch(`${ORIGIN}${route}`, { method: 'GET' });
      assert.equal(res.status, 404, `${route} should 404 on GET`);
    }
  } finally {
    await stopServer(child);
  }
});
