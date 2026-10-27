// Regression test for fix/001-static-module-graph.
//
// 322 tests were green while the running app was stuck on "Connecting…"
// forever, because nothing exercised what a browser actually does:
// resolve public/app.js's import graph — static imports and dynamic
// import() alike — against the server's fixed STATIC_FILES table over
// real HTTP. lib/model.js imports './parse-tracker.js', which was never
// added to that table, so it 404'd, which threw inside the dynamic
// import of trend-chart.js/watchlist.js, which the SSE handler's
// try/catch swallowed.
//
// This test walks the whole transitive closure the browser would load,
// starting at /app.js, following both `import ... from '...'` and
// `import('...')`, and asserts:
//   1. every module in that closure is reachable over HTTP (200, with a
//      JS content type) — so a missing route fails here, not silently in
//      a browser
//   2. the server-only lib modules that must never be network-reachable
//      still 404, so the fix can't accidentally flip to directory serving
//
// Spawns the real server.js (same pattern as test/quotes-endpoint.test.js)
// against a scratch DATA_DIR, so it never touches data/tracker.md and
// exercises the exact code path the browser hits.

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

// Modules that exist only for the server (reading/writing data/tracker.md,
// path safety, the write queue, section parsing) and must never be
// fetchable by a browser. If the static-serving design ever changes to
// serving a whole directory instead of a fixed table, these are exactly
// the files that change from "correctly unreachable" to "leaked".
const SERVER_ONLY_MODULES = [
  '/archive.js',
  '/cars.js',
  '/quotes.js',
  '/readings.js',
  '/safe-path.js',
  '/tracker-data.js',
  '/tracker-sections.js',
  '/trims.js',
  '/write-queue.js',
];

// Matches `import x from 'y'`, `import {a, b} from 'y'`, `import 'y'`,
// `export {a} from 'y'`, and `import('y')` / `import("y")` — the only
// import shapes this codebase's zero-dependency ES modules use.
const STATIC_IMPORT_RE = /\bimport\s*(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /\bexport\s*(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractSpecifiers(source) {
  const specifiers = new Set();
  for (const re of [STATIC_IMPORT_RE, EXPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      specifiers.add(match[1]);
    }
  }
  return specifiers;
}

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-module-graph-'));
  fs.writeFileSync(path.join(dir, 'tracker.md'), '## Cars\n## Configurations\n## Quotes\n');
  return dir;
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

// Resolves a module specifier the same way a browser does: relative to
// the URL of the module that imported it (not relative to a filesystem
// path), so a `./model.js` import from a script served at /trend-chart.js
// resolves to /model.js.
function resolveSpecifier(specifier, fromPath) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    // A bare specifier (bare package name) — this project has zero
    // dependencies, so none of its own modules should ever produce one.
    // Leave it unresolved so it fails loudly if it ever shows up.
    return specifier;
  }
  return new URL(specifier, `${ORIGIN}${fromPath}`).pathname;
}

test('every module public/app.js can reach (static or dynamic import) is served over HTTP', async () => {
  const dir = tempDataDir();
  const child = await startServer(dir);
  try {
    const visited = new Map(); // path -> { status, contentType }
    const queue = ['/app.js'];

    while (queue.length > 0) {
      const modPath = queue.shift();
      if (visited.has(modPath)) continue;

      const res = await fetch(`${ORIGIN}${modPath}`);
      const contentType = res.headers.get('content-type') ?? '';
      visited.set(modPath, { status: res.status, contentType });

      assert.equal(
        res.status,
        200,
        `${modPath} must be reachable over HTTP (imported transitively from public/app.js)`,
      );
      assert.match(
        contentType,
        /javascript/,
        `${modPath} should be served with a JavaScript content type, got "${contentType}"`,
      );

      const source = await res.text();
      for (const specifier of extractSpecifiers(source)) {
        queue.push(resolveSpecifier(specifier, modPath));
      }
    }

    // Sanity check: the walk actually found the modules this bug involved,
    // so this test would have caught the original 404 on parse-tracker.js.
    for (const expected of ['/app.js', '/markdown.js', '/trend-chart.js', '/watchlist.js', '/model.js', '/parse-tracker.js']) {
      assert.ok(visited.has(expected), `expected the import walk to reach ${expected}`);
    }
  } finally {
    await stopServer(child);
  }
});

test('server-only modules stay unreachable over HTTP even though the browser never imports them', async () => {
  const dir = tempDataDir();
  const child = await startServer(dir);
  try {
    for (const modPath of SERVER_ONLY_MODULES) {
      const res = await fetch(`${ORIGIN}${modPath}`);
      assert.equal(res.status, 404, `${modPath} must not be served — it is a server-only module`);
    }
  } finally {
    await stopServer(child);
  }
});
