import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dungeonRoot = path.resolve(__dirname, '..');
const { port, appPort } = await resolveLiveBridgePorts();
const origin = `http://127.0.0.1:${appPort}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-live-bridge-'));
const fakeCodexAppServer = path.join(tmp, 'fake-codex-app-server.cjs');
const bridgeOutput = [];
let bridge;

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => {
        if (!freePort) reject(new Error('Unable to allocate a free live bridge test port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolveLiveBridgePorts() {
  const requestedBridge = process.env.SEO_DUNGEON_LIVE_BRIDGE_TEST_PORT
    ? Number(process.env.SEO_DUNGEON_LIVE_BRIDGE_TEST_PORT)
    : null;
  const requestedApp = process.env.SEO_DUNGEON_LIVE_BRIDGE_TEST_APP_PORT
    ? Number(process.env.SEO_DUNGEON_LIVE_BRIDGE_TEST_APP_PORT)
    : null;
  const bridge = requestedBridge || await reserveFreePort();
  let app = requestedApp || await reserveFreePort();
  while (app === bridge && !requestedApp) app = await reserveFreePort();
  if (app === bridge) throw new Error('Live bridge and app origin ports must be different.');
  return { port: bridge, appPort: app };
}

fs.writeFileSync(fakeCodexAppServer, `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let turnStarted = false;
let completed = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const textFromInput = (input) => {
  if (!Array.isArray(input)) return '';
  for (const item of input) {
    if (item?.type === 'text' && !Array.isArray(item.text_elements)) {
      throw new Error('Codex text input must include text_elements');
    }
  }
  return input.map((item) => item && item.text ? item.text : '').join('\\n').trim();
};
const tinyDeltas = ["I'll", " verify", " this", " against", " the", " live", " repo", "."];
const splitDeltas = [
  " The quick npm exec probe did not expose Playwright as a requireable package, so I am checking whether craw",
  "lers can see the FAQ text immediately."
];

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread_fake' } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread_fake' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    textFromInput(msg.params && msg.params.input);
    setTimeout(() => {
      turnStarted = true;
      send({ method: 'turn/started', params: { turn: { id: 'turn_fake' } } });
      send({ id: msg.id, result: { turn: { id: 'turn_fake' } } });
    }, 100);
    setTimeout(() => {
      if (completed) return;
      for (const delta of tinyDeltas) {
        send({ method: 'item/agentMessage/delta', params: { delta } });
      }
    }, 450);
    setTimeout(() => {
      if (completed) return;
      send({ method: 'context/compaction/started', params: { message: 'Auto-compacting context' } });
    }, 650);
    setTimeout(() => {
      if (completed) return;
      send({ method: 'context/compaction/completed', params: { message: 'Context compaction complete' } });
    }, 1100);
    setTimeout(() => {
      if (completed) return;
      send({ method: 'item/agentMessage/delta', params: { delta: splitDeltas[0] } });
    }, 850);
    setTimeout(() => {
      if (completed) return;
      send({ method: 'item/agentMessage/delta', params: { delta: splitDeltas[1] } });
    }, 2300);
    setTimeout(() => {
      if (completed) return;
      completed = true;
      send({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'completed' } } });
    }, 3000);
    return;
  }
  if (msg.method === 'turn/steer') {
    if (!turnStarted) {
      send({ id: msg.id, error: { code: -32000, message: 'no active turn to steer' } });
      return;
    }
    send({ id: msg.id, result: { turnId: 'turn_fake' } });
    send({ method: 'item/agentMessage/delta', params: { delta: ' STEERED_OK ' + textFromInput(msg.params.input) + '.' } });
    return;
  }
  if (msg.method === 'turn/interrupt') {
    completed = true;
    send({ id: msg.id, result: {} });
    send({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'interrupted' } } });
  }
});
`, 'utf8');

function runBridge() {
  bridge = spawn(process.execPath, ['server/index.js'], {
    cwd: dungeonRoot,
    env: {
      ...process.env,
      SEO_DUNGEON_BRIDGE_PORT: String(port),
      SEO_DUNGEON_ALLOWED_ORIGINS: origin,
      SEO_DUNGEON_CODEX_CLI: process.execPath,
      SEO_DUNGEON_CODEX_ARGS: `"${fakeCodexAppServer}"`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (chunk) => bridgeOutput.push(chunk.toString()));
  bridge.stderr.on('data', (chunk) => bridgeOutput.push(chunk.toString()));
}

async function stopBridge() {
  if (!bridge || bridge.killed) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(bridge.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
  } else {
    bridge.kill('SIGTERM');
  }
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (bridge.exitCode !== null) {
      throw new Error(`Bridge exited early:\\n${bridgeOutput.join('').slice(-4000)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return res.json();
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for bridge:\\n${bridgeOutput.join('').slice(-4000)}`);
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitForMessage(messages, predicate, label, timeoutMs = 8000) {
  const found = messages.find(predicate);
  if (found) return found;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const match = messages.find(predicate);
    if (match) return match;
  }
  throw new Error(`Timed out waiting for ${label}. Messages: ${JSON.stringify(messages, null, 2)}`);
}

runBridge();

try {
  const health = await waitForHealth();
  assert.equal(health.supportsSteer, true, 'bridge health should advertise steering');

  const clientA = await connectClient();
  const clientB = await connectClient();
  const messagesA = [];
  const messagesB = [];
  clientA.on('message', (chunk) => messagesA.push(JSON.parse(String(chunk))));
  clientB.on('message', (chunk) => messagesB.push(JSON.parse(String(chunk))));

  clientA.send(JSON.stringify({
    id: 1001,
    type: 'chat',
    runtime: 'codex',
    profile: 'fast',
    dangerousBypass: true,
    projectPath: tmp,
    command: 'Live bridge ownership and stream coalescing test.'
  }));

  await new Promise((resolve) => setTimeout(resolve, 350));
  clientB.close();
  await new Promise((resolve) => setTimeout(resolve, 250));

  clientA.send(JSON.stringify({
    id: 1002,
    type: 'steer',
    targetId: 1001,
    command: 'steered follow-up'
  }));

  const steerResult = await waitForMessage(
    messagesA,
    (msg) => msg.id === 1002,
    'steer result'
  );
  assert.equal(steerResult.type, 'result', `steer should succeed after another client disconnects: ${JSON.stringify(steerResult)}`);

  const finalResult = await waitForMessage(
    messagesA,
    (msg) => msg.id === 1001 && (msg.type === 'result' || msg.type === 'error'),
    'chat completion'
  );
  assert.equal(finalResult.type, 'result', `client B disconnect must not cancel client A: ${JSON.stringify(finalResult)}`);

  clientA.send(JSON.stringify({
    id: 1003,
    type: 'steer',
    targetId: 1001,
    command: 'late steer after completion'
  }));
  const lateSteerResult = await waitForMessage(
    messagesA,
    (msg) => msg.id === 1003,
    'late steer result'
  );
  assert.equal(lateSteerResult.type, 'error', `late steer should reject after completion: ${JSON.stringify(lateSteerResult)}`);
  assert.match(lateSteerResult.message || '', /No active operation to steer/i);

  const streamLines = messagesA
    .filter((msg) => msg.type === 'stream')
    .map((msg) => String(msg.content || ''));
  const compactionStatuses = messagesA
    .filter((msg) => msg.type === 'status' && msg.status?.kind === 'compaction')
    .map((msg) => msg.status.phase);
  assert.deepEqual(
    compactionStatuses,
    ['start', 'complete'],
    `bridge should forward compaction status without transcript hacks: ${JSON.stringify(messagesA, null, 2)}`
  );
  assert(
    streamLines.some((line) => line.includes("I'll verify this against the live repo.")),
    `tiny deltas should be coalesced into a readable line: ${JSON.stringify(streamLines)}`
  );
  assert(
    !streamLines.some((line) => /^(I'll|verify|this|against|the|live|repo)$/i.test(line.trim())),
    `stream should not render one-word ledger spam: ${JSON.stringify(streamLines)}`
  );
  assert(
    streamLines.some((line) => line.includes('The quick npm exec probe did not expose Playwright as a requireable package, so I am checking whether crawlers can see the FAQ text immediately.')),
    `paused partial words should remain one readable stream line: ${JSON.stringify(streamLines)}`
  );
  assert(
    !streamLines.some((line) => /\bcraw$/i.test(line.trim()) || /^lers\b/i.test(line.trim())),
    `stream should not split a paused partial word into separate ledger lines: ${JSON.stringify(streamLines)}`
  );
  assert(
    streamLines.some((line) => line.includes('STEERED_OK steered follow-up')),
    `steered delta should appear in coherent stream output: ${JSON.stringify(streamLines)}`
  );

  clientA.close();
  console.log('Live bridge self-test passed');
} finally {
  await stopBridge();
  fs.rmSync(tmp, { recursive: true, force: true });
}
