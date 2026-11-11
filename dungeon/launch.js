#!/usr/bin/env node

/**
 * Legends SEO Dungeon - One-click launcher.
 *
 * Builds the optimized production bundle (if needed), starts the bridge
 * server, and serves the game. The user just runs: npm start
 */

const { spawn, execFileSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const express = require('express');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const LOG_DIR = path.join(ROOT, '.logs');

// Ensure log directory exists. Bridge stdout/stderr get piped here so we
// can diagnose audit parse failures, disconnects, and agent CLI errors
// after the fact. Previously the bridge ran with stdio:'ignore' and
// every console.log inside server/index.js went to /dev/null.
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Rotate the active bridge log by timestamping old runs. Keep the most
// recent 10 so the directory doesn't grow without bound.
const bridgeLogPath = path.join(LOG_DIR, 'bridge.log');
if (fs.existsSync(bridgeLogPath)) {
  const rotated = path.join(LOG_DIR, `bridge-${Date.now()}.log`);
  try { fs.renameSync(bridgeLogPath, rotated); } catch (_) {}
  const archived = fs.readdirSync(LOG_DIR)
    .filter(f => /^bridge-\d+\.log$/.test(f))
    .sort();
  while (archived.length > 10) {
    try { fs.unlinkSync(path.join(LOG_DIR, archived.shift())); } catch (_) {}
  }
}

console.log('');
console.log('  ⚔  Legends SEO Dungeon  ⚔');
console.log('  ─────────────────────────');
console.log('');

// Build production bundle if dist/ doesn't exist or is empty
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('  Building optimized production bundle...');
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      cwd: ROOT, stdio: 'inherit'
    });
    console.log('  ✓ Build complete');
    console.log('');
  } catch (e) {
    console.error('  ✗ Build failed. Try running: npm run build');
    process.exit(1);
  }
}

function canUsePort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, '127.0.0.1');
  });
}

async function findOpenPort(preferred, attempts = 24, excluded = []) {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error('Ports must be integers between 1 and 65535.');
  }
  for (let i = 0; i < attempts; i += 1) {
    const port = preferred + i;
    if (port > 65535 || excluded.includes(port)) continue;
    if (await canUsePort(port)) return port;
  }
  throw new Error(`No open local port found from ${preferred} through ${preferred + attempts - 1}`);
}

let bridge = null;
let appServer = null;

function cleanup() {
  try { bridge?.kill(); } catch (_) {}
  try { appServer?.close(); } catch (_) {}
}

async function waitForBridge(port) {
  let ipcReady = false;
  let notifyReady = null;
  const onMessage = (msg) => {
    if (msg && msg.type === 'bridge-ready') {
      ipcReady = true;
      if (notifyReady) notifyReady();
    }
  };
  bridge.on('message', onMessage);
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (bridge.exitCode !== null || bridge.signalCode !== null) {
        throw new Error(`Bridge exited before startup. See ${bridgeLogPath}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        const health = await response.json();
        if (response.ok && health.ok === true && Number.isInteger(health.protocol)
          && Array.isArray(health.supportedRuntimes) && health.supportedRuntimes.includes('codex')) return;
      } catch (_) {}
      if (!ipcReady) {
        await new Promise((resolve) => {
          notifyReady = resolve;
          setTimeout(resolve, 300);
        });
        notifyReady = null;
      }
    }
    throw new Error(`Bridge did not start. See ${bridgeLogPath}`);
  } finally {
    bridge.off('message', onMessage);
  }
}

(async () => {
  const appPort = await findOpenPort(Number(process.env.SEO_DUNGEON_APP_PORT || 3002));
  const bridgePort = await findOpenPort(Number(process.env.SEO_DUNGEON_BRIDGE_PORT || 3003), 24, [appPort]);
  const bridgeUrl = `ws://127.0.0.1:${bridgePort}`;
  const sessionLogPath = process.env.SEO_DUNGEON_SESSION_LOG || path.join(LOG_DIR, 'session-events.jsonl');
  const runtimeConfig = `window.SEO_DUNGEON_BRIDGE_URL = ${JSON.stringify(bridgeUrl)};\n`;
  try {
    fs.writeFileSync(path.join(DIST, 'seo-dungeon-runtime-config.js'), runtimeConfig);
  } catch (error) {
    throw new Error(`Cannot write runtime configuration: ${error.message}`);
  }

  // Start bridge server and tee its stdout/stderr into bridge.log. We pipe
  // instead of inherit because inherit would mix bridge output into the
  // serve process's terminal stream and make both unreadable. Writing to
  // a file keeps both readable and gives us a post-mortem for bugs that
  // only happen during long audits.
  const bridgeLog = fs.openSync(bridgeLogPath, 'a');
  fs.writeSync(bridgeLog, `\n=== Bridge started ${new Date().toISOString()} on ${bridgeUrl} ===\n`);
  bridge = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      SEO_DUNGEON_BRIDGE_PORT: String(bridgePort),
      SEO_DUNGEON_BRIDGE_STRICT_PORT: '1',
      SEO_DUNGEON_ALLOWED_ORIGINS: [
        process.env.SEO_DUNGEON_ALLOWED_ORIGINS || '',
        `http://localhost:${appPort}`,
        `http://127.0.0.1:${appPort}`
      ].filter(Boolean).join(','),
      SEO_DUNGEON_SESSION_LOG: sessionLogPath
    },
    stdio: ['ignore', bridgeLog, bridgeLog, 'ipc']
  });
  fs.closeSync(bridgeLog);
  bridge.once('error', error => {
    console.error(`  ✗ Bridge launch failed: ${error.message}`);
    process.exit(1);
  });
  await waitForBridge(bridgePort);
  bridge.once('exit', () => {
    console.error('  ✗ Bridge stopped; shutting down the game server.');
    process.exit(1);
  });
  console.log(`  ✓ Bridge server started (port ${bridgePort}), logging to ${path.relative(ROOT, bridgeLogPath)}`);
  console.log(`  ✓ Remote session ledger: ${path.relative(ROOT, sessionLogPath)}`);

  // Serve optimized production build
  // Use the installed dependency; startup must not download a second server
  // through npx, and the UI should only listen on the local interface.
  const app = express();
  app.use(express.static(DIST));
  app.use((req, res) => res.sendFile(path.join(DIST, 'index.html')));
  await new Promise((resolve, reject) => {
    appServer = app.listen(appPort, '127.0.0.1', resolve);
    appServer.once('error', reject);
  });

  console.log(`  ✓ Game server starting (port ${appPort})`);
  if (appPort !== 3002) console.log(`  Note: port 3002 is busy, so this launch is using ${appPort}.`);
  if (bridgePort !== 3003) console.log(`  Note: port 3003 is busy, so this bridge is using ${bridgePort}.`);
  console.log('');
  console.log(`  Open http://localhost:${appPort} in your browser.`);
  console.log('  Codex is the default agent runtime. Open the game and play!');
  console.log('');
})().catch((err) => {
  console.error(`  ✗ Launch failed: ${err.message}`);
  process.exit(1);
});

// Clean up bridge on exit
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
