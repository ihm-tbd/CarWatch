// fix/002: guards against the exact bug just fixed. public/index.html's
// footer claimed "Read-only" for three build stages (V1 through 003) while
// six write endpoints (POST /quotes, /cars, /cars/archive, /trims/archive,
// /trims/add, /readings) were built underneath it — a false safety claim,
// not just stale copy. This test asserts the two facts can never silently
// diverge again: as long as any write endpoint is wired into server.js, no
// text served to the browser may claim the app is read-only.
//
// Same spawn-the-real-server pattern as test/write-endpoints.test.js and
// test/static-module-graph.test.js, against a scratch DATA_DIR so this
// never touches data/tracker.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PORT = 5763;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CLIENT_HEADER = 'x-car-tracker-client';
const HEADERS = { 'Content-Type': 'application/json', Origin: ORIGIN, [CLIENT_HEADER]: '1' };

// Every text-based file the browser can fetch from the server — the whole
// surface a "read-only" claim could hide in. Fonts are binary and excluded.
const SERVED_TEXT_PATHS = [
  '/',
  '/style.css',
  '/app.js',
  '/markdown.js',
  '/model.js',
  '/parse-tracker.js',
  '/trend-chart.js',
  '/watchlist.js',
];

// The write endpoints the false footer contradicted. A POST here should
// never 404 — a 404 would mean the route isn't actually wired, which would
// make the "write endpoints exist" half of this guard's premise false.
const WRITE_ENDPOINTS = ['/quotes', '/cars', '/cars/archive', '/trims/archive', '/trims/add', '/readings'];

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-read-only-claim-'));
  fs.writeFileSync(path.join(dir, 'tracker.md'), '## Cars\n## Configurations\n## Quotes\n');
  return dir;
}

function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
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

async function stopServer(child) {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

test('every write endpoint the false footer contradicted is actually wired', async () => {
  const dir = tempDataDir();
  const child = await startServer(dir);
  try {
    for (const endpoint of WRITE_ENDPOINTS) {
      const res = await fetch(`${ORIGIN}${endpoint}`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({}),
      });
      assert.notEqual(res.status, 404, `${endpoint} must be a real route, not a 404 — otherwise this guard's premise is false`);
    }
  } finally {
    await stopServer(child);
  }
});

test('no served UI copy claims the app is read-only', async () => {
  const dir = tempDataDir();
  const child = await startServer(dir);
  try {
    for (const p of SERVED_TEXT_PATHS) {
      const res = await fetch(`${ORIGIN}${p}`);
      assert.equal(res.status, 200, `expected ${p} to be served`);
      const body = await res.text();
      assert.doesNotMatch(
        body,
        /read[\s-]?only/i,
        `${p} must never claim the app is read-only while write endpoints exist`,
      );
    }
  } finally {
    await stopServer(child);
  }
});
