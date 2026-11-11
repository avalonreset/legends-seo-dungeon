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
const { bridgePort, appPort } = await resolveRemoteCliPorts();
const bridgeWs = `ws://127.0.0.1:${bridgePort}`;
const origin = `http://127.0.0.1:${appPort}`;
const runtimeConfigPath = path.join(dungeonRoot, 'dist', 'seo-dungeon-runtime-config.js');
const runtimeConfigDir = path.dirname(runtimeConfigPath);
const runtimeConfigHadDir = fs.existsSync(runtimeConfigDir);
const runtimeConfigHadFile = fs.existsSync(runtimeConfigPath);
const runtimeConfigOriginal = runtimeConfigHadFile ? fs.readFileSync(runtimeConfigPath, 'utf8') : '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-remote-cli-'));
const projectPath = path.join(tmp, 'project');
const missingProject = path.join(tmp, 'missing-project');
const bridgeOutput = [];
let bridge;
let runtimeConfigTouched = false;

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => {
        if (!freePort) reject(new Error('Unable to allocate a free remote CLI test port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolveRemoteCliPorts() {
  const requestedBridge = process.env.SEO_DUNGEON_REMOTE_CLI_TEST_PORT
    ? Number(process.env.SEO_DUNGEON_REMOTE_CLI_TEST_PORT)
    : null;
  const requestedApp = process.env.SEO_DUNGEON_REMOTE_CLI_TEST_APP_PORT
    ? Number(process.env.SEO_DUNGEON_REMOTE_CLI_TEST_APP_PORT)
    : null;
  const bridge = requestedBridge || await reserveFreePort();
  let app = requestedApp || (bridge > 1 ? bridge - 1 : await reserveFreePort());
  if (app === bridge) throw new Error('Remote CLI bridge and app test ports must be different.');
  return { bridgePort: bridge, appPort: app };
}

fs.mkdirSync(projectPath, { recursive: true });
fs.writeFileSync(path.join(projectPath, 'README.md'), '# Remote Control CLI Test\n', 'utf8');

function runBridge() {
  bridge = spawn(process.execPath, ['server/index.js'], {
    cwd: dungeonRoot,
    env: {
      ...process.env,
      SEO_DUNGEON_BRIDGE_PORT: String(bridgePort),
      SEO_DUNGEON_ALLOWED_ORIGINS: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout.on('data', (chunk) => bridgeOutput.push(chunk.toString()));
  bridge.stderr.on('data', (chunk) => bridgeOutput.push(chunk.toString()));
}

async function stopBridge() {
  if (!bridge || bridge.killed || bridge.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(bridge.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }
  bridge.kill('SIGTERM');
}

async function waitForHealth(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (bridge.exitCode !== null) throw new Error(`Bridge exited early:\n${bridgeOutput.join('').slice(-4000)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return res.json();
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for bridge:\n${bridgeOutput.join('').slice(-4000)}`);
}

function cliEnv(extra = {}) {
  return {
    ...process.env,
    SEO_DUNGEON_BRIDGE_URL: bridgeWs,
    SEO_DUNGEON_CONTROLLER_ORIGIN: origin,
    ...extra,
  };
}

function runtimeConfigCliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.SEO_DUNGEON_BRIDGE_URL;
  delete env.SEO_DUNGEON_BRIDGE_PORT;
  delete env.SEO_DUNGEON_CONTROLLER_ORIGIN;
  delete env.SEO_DUNGEON_APP_PORT;
  return env;
}

function writeRuntimeConfigBridge(url) {
  fs.mkdirSync(runtimeConfigDir, { recursive: true });
  fs.writeFileSync(runtimeConfigPath, `window.SEO_DUNGEON_BRIDGE_URL = ${JSON.stringify(url)};\n`, 'utf8');
  runtimeConfigTouched = true;
}

function restoreRuntimeConfig() {
  if (!runtimeConfigTouched) return;
  if (runtimeConfigHadFile) {
    fs.writeFileSync(runtimeConfigPath, runtimeConfigOriginal, 'utf8');
  } else {
    fs.rmSync(runtimeConfigPath, { force: true });
    if (!runtimeConfigHadDir) {
      try { fs.rmdirSync(runtimeConfigDir); } catch (_) {}
    }
  }
}

function runCli(args, { env = cliEnv(), timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/remote-control.mjs', ...args], {
      cwd: dungeonRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch (_) {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

function startCli(args, { env = cliEnv(), timeoutMs = 15000 } = {}) {
  const child = spawn(process.execPath, ['scripts/remote-control.mjs', ...args], {
    cwd: dungeonRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: ${args.join(' ')}\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch (_) {}
      resolve({ code, stdout, stderr, json });
    });
  });
  return { child, result };
}

async function waitForFile(filePath, label, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

function parseJsonLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function connectClient(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeWs, { headers: { Origin: origin } });
    const messages = [];
    ws.on('message', (chunk) => messages.push(JSON.parse(String(chunk))));
    ws.once('open', () => resolve({ label, ws, messages }));
    ws.once('error', reject);
  });
}

async function waitForMessage(client, predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = client.messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out waiting for ${label}. Messages: ${JSON.stringify(client.messages, null, 2)}`);
}

runBridge();

try {
  await waitForHealth();
  const browser = await connectClient('browser');

  writeRuntimeConfigBridge(bridgeWs);
  const runtimeConfigStatus = await runCli(['status', '--json'], { env: runtimeConfigCliEnv() });
  assert.equal(runtimeConfigStatus.code, 0, runtimeConfigStatus.stdout);
  assert.equal(runtimeConfigStatus.json?.ok, true);
  assert.equal(runtimeConfigStatus.json?.bridgeUrl, new URL(bridgeWs).href);
  assert.equal(runtimeConfigStatus.json?.origin, origin);

  const status = await runCli(['status', '--json']);
  assert.equal(status.code, 0, status.stdout);
  assert.equal(status.json?.ok, true);
  assert.equal(status.json?.data?.supportsRemoteControl, true);
  assert(status.json?.data?.allowedTypes?.includes('remote-command'));

  const send = await runCli([
    'send',
    '--json',
    '--project',
    projectPath,
    '--profile',
    'fast',
    '--dangerous-bypass',
    '--',
    'Remote CLI command from Codex',
  ]);
  assert.equal(send.code, 0, send.stdout);
  assert.equal(send.json?.ok, true);
  assert.equal(send.json?.data?.accepted, true);
  assert(send.json?.data?.commandId, 'send should return command id');

  const browserRemote = await waitForMessage(
    browser,
    (msg) => msg.type === 'session-event' && msg.event?.commandId === send.json.data.commandId,
    'CLI remote-command broadcast'
  );
  assert.equal(browserRemote.event.kind, 'remote-command');
  assert.equal(browserRemote.event.source, 'codex-cli');
  assert.equal(browserRemote.event.command, 'Remote CLI command from Codex');
  assert.equal(browserRemote.event.projectPath, projectPath);
  assert.equal(browserRemote.event.profile, 'fast');
  assert.equal(browserRemote.event.dangerousBypass, true);

  const event = await runCli([
    'event',
    '--json',
    '--kind',
    'codex-state',
    '--status',
    'running',
    '--message',
    'Codex is inspecting the repo',
  ]);
  assert.equal(event.code, 0, event.stdout);
  assert.equal(event.json?.ok, true);

  const browserEvent = await waitForMessage(
    browser,
    (msg) => msg.type === 'session-event' && msg.event?.kind === 'codex-state',
    'CLI codex-state event broadcast'
  );
  assert.equal(browserEvent.event.source, 'codex-cli');
  assert.equal(browserEvent.event.status, 'running');
  assert.equal(browserEvent.event.message, 'Codex is inspecting the repo');

  const waitableIntent = startCli([
    'event',
    '--json',
    '--wait',
    '--timeout',
    '10000',
    '--kind',
    'ui-intent',
    '--action',
    'setup',
    '--project',
    projectPath,
    '--runtime',
    'codex',
    '--profile',
    'fast',
    '--character',
    'knight',
    '--no-dangerous-bypass',
    '--meta',
    'ticket=RC-018',
    '--meta',
    'mode=contract',
    '--message',
    'Waitable UI setup intent',
  ], { timeoutMs: 12000 });
  const uiIntentEvent = await waitForMessage(
    browser,
    (msg) => msg.type === 'session-event' && msg.event?.kind === 'ui-intent' && msg.event?.action === 'setup',
    'CLI waitable ui-intent event'
  );
  assert.equal(uiIntentEvent.event.source, 'codex-cli');
  assert.equal(uiIntentEvent.event.projectPath, projectPath);
  assert.equal(uiIntentEvent.event.profile, 'fast');
  assert.equal(uiIntentEvent.event.character, 'knight');
  assert.equal(uiIntentEvent.event.dangerousBypass, false);
  assert.equal(uiIntentEvent.event.metadata?.ticket, 'RC-018');
  assert.equal(uiIntentEvent.event.metadata?.mode, 'contract');

  browser.ws.send(JSON.stringify({
    id: 9701,
    type: 'session-event',
    event: {
      kind: 'ui-result',
      source: 'guild-ledger',
      targetId: uiIntentEvent.event.eventId,
      status: 'complete',
      action: 'setup',
      message: 'Waitable setup applied.',
      metadata: {
        ticket: 'RC-018',
        scene: 'title',
      },
    },
  }));
  const uiResultAck = await waitForMessage(browser, (msg) => msg.id === 9701, 'waitable ui-result ack');
  assert.equal(uiResultAck.type, 'result');
  const waitableIntentResult = await waitableIntent.result;
  assert.equal(waitableIntentResult.code, 0, waitableIntentResult.stdout);
  assert.equal(waitableIntentResult.json?.ok, true);
  assert.equal(waitableIntentResult.json?.data?.event?.eventId, uiIntentEvent.event.eventId);
  assert.equal(waitableIntentResult.json?.waitEvent?.kind, 'ui-result');
  assert.equal(waitableIntentResult.json?.waitEvent?.targetId, uiIntentEvent.event.eventId);
  assert.equal(waitableIntentResult.json?.waitEvent?.status, 'complete');
  assert.equal(waitableIntentResult.json?.waitEvent?.metadata?.ticket, 'RC-018');

  const state = await runCli(['state', '--json']);
  assert.equal(state.code, 0, state.stdout);
  assert.equal(state.json?.ok, true);
  assert(state.json.data.events.some((item) => item.commandId === send.json.data.commandId));
  assert(state.json.data.events.some((item) => item.kind === 'codex-state'));
  assert.equal(state.json.data.capabilities.supportsRemoteControl, true);
  assert(Array.isArray(state.json.data.connectedClients), 'session state should include connected clients');
  assert(state.json.data.connectedClients.some((client) => client.role === 'controller' && client.lastSource === 'codex-cli'), 'CLI state request should identify a controller client');
  assert(state.json.data.connectedClients.some((client) => client.origin === origin), 'session clients should include the allowed local origin');
  assert(Array.isArray(state.json.data.activeOperations), 'session state should include active operation summaries');

  browser.ws.send(JSON.stringify({
    id: 9801,
    type: 'session-event',
    event: {
      kind: 'ledger-command',
      source: 'guild-ledger',
      command: 'Browser-origin command with api_key=supersecret123456',
      projectPath,
      runtime: 'codex',
      profile: 'fast',
    },
  }));
  const browserMirrorAck = await waitForMessage(browser, (msg) => msg.id === 9801, 'browser ledger-command ack');
  assert.equal(browserMirrorAck.type, 'result');
  assert.equal(browserMirrorAck.data?.accepted, true);

  const replayWatch = await runCli([
    'watch',
    '--json',
    '--kind',
    'ledger-command',
    '--filter-source',
    'guild-ledger',
    '--count',
    '1',
    '--timeout',
    '5000',
  ]);
  assert.equal(replayWatch.code, 0, replayWatch.stdout);
  assert(!replayWatch.stdout.includes('supersecret123456'), 'watch output should redact secret-shaped strings');
  const replayLines = parseJsonLines(replayWatch.stdout);
  const replayEvent = replayLines.find((line) => line.type === 'session-event');
  assert.equal(replayEvent?.replay, true, 'watch should replay matching session-state events by default');
  assert.equal(replayEvent?.event?.kind, 'ledger-command');
  assert.equal(replayEvent?.event?.source, 'guild-ledger');
  assert.match(replayEvent?.event?.command || '', /api_key=\*\*\*\*/);
  const replaySummary = replayLines.at(-1);
  assert.equal(replaySummary?.type, 'watch-complete');
  assert.equal(replaySummary?.reason, 'count');
  assert.equal(replaySummary?.events, 1);

  const afterSequenceWatch = await runCli([
    'watch',
    '--json',
    '--kind',
    'ledger-command',
    '--filter-source',
    'guild-ledger',
    '--after-sequence',
    String(replayEvent.event.sequence),
    '--count',
    '1',
    '--timeout',
    '300',
  ], { timeoutMs: 2000 });
  assert.equal(afterSequenceWatch.code, 0, afterSequenceWatch.stdout);
  const afterSequenceLines = parseJsonLines(afterSequenceWatch.stdout);
  assert.equal(afterSequenceLines.length, 1, 'after-sequence watch should only emit completion when old events are excluded');
  assert.equal(afterSequenceLines[0]?.reason, 'timeout');
  assert.equal(afterSequenceLines[0]?.events, 0);

  const noReplayTimeout = await runCli([
    'watch',
    '--json',
    '--no-replay',
    '--kind',
    'ledger-command',
    '--filter-source',
    'guild-ledger',
    '--count',
    '1',
    '--timeout',
    '300',
  ], { timeoutMs: 2000 });
  assert.equal(noReplayTimeout.code, 0, noReplayTimeout.stdout);
  const noReplayLines = parseJsonLines(noReplayTimeout.stdout);
  assert.equal(noReplayLines.length, 1, 'watch --no-replay should ignore preexisting session history');
  assert.equal(noReplayLines[0]?.reason, 'timeout');
  assert.equal(noReplayLines[0]?.events, 0);

  const futureReadyFile = path.join(tmp, 'future-watch-ready.json');
  const futureWatchPromise = runCli([
    'watch',
    '--json',
    '--no-replay',
    '--kind',
    'ledger-command',
    '--filter-source',
    'guild-ledger',
    '--count',
    '1',
    '--timeout',
    '8000',
    '--ready-file',
    futureReadyFile,
  ], { timeoutMs: 10000 });
  await waitForFile(futureReadyFile, 'future watch readiness');
  browser.ws.send(JSON.stringify({
    id: 9802,
    type: 'session-event',
    event: {
      kind: 'ledger-command',
      source: 'guild-ledger',
      command: 'Future Guild Ledger command for Codex watcher',
      projectPath,
      runtime: 'codex',
      profile: 'fast',
    },
  }));
  const futureWatch = await futureWatchPromise;
  assert.equal(futureWatch.code, 0, futureWatch.stdout);
  const futureLines = parseJsonLines(futureWatch.stdout);
  const futureEvent = futureLines.find((line) => line.type === 'session-event');
  assert.equal(futureEvent?.replay, false, 'watch --no-replay should stream future events only');
  assert.equal(futureEvent?.event?.command, 'Future Guild Ledger command for Codex watcher');
  assert.equal(futureLines.at(-1)?.reason, 'count');

  const waitCli = runCli([
    'send',
    '--json',
    '--wait',
    '--timeout',
    '10000',
    '--project',
    projectPath,
    '--dangerous-bypass',
    '--',
    'Wait for Guild Ledger completion',
  ], { timeoutMs: 15000 });

  const waitRemote = await waitForMessage(
    browser,
    (msg) => msg.type === 'session-event' &&
      msg.event?.kind === 'remote-command' &&
      msg.event?.command === 'Wait for Guild Ledger completion',
    'wait-mode remote-command'
  );
  browser.ws.send(JSON.stringify({
    id: 9901,
    type: 'session-event',
    event: {
      kind: 'ledger-result',
      source: 'guild-ledger',
      commandId: waitRemote.event.commandId,
      status: 'complete',
      message: 'Helper wait completed',
      projectPath,
      runtime: 'codex',
      profile: 'fast',
    },
  }));
  const waitResult = await waitCli;
  assert.equal(waitResult.code, 0, waitResult.stdout);
  assert.equal(waitResult.json?.ok, true);
  assert.equal(waitResult.json?.waitEvent?.status, 'complete');
  assert.equal(waitResult.json?.waitEvent?.commandId, waitRemote.event.commandId);

  const invalidProject = await runCli([
    'send',
    '--json',
    '--project',
    missingProject,
    '--',
    'Should fail locally',
  ]);
  assert.notEqual(invalidProject.code, 0);
  assert.equal(invalidProject.json?.ok, false);
  assert.match(invalidProject.json?.error || '', /Invalid project path/i);

  const nonLoopback = await runCli([
    'status',
    '--json',
    '--bridge',
    'ws://192.0.2.12:3003',
  ], { env: { ...process.env }, timeoutMs: 5000 });
  assert.notEqual(nonLoopback.code, 0);
  assert.match(nonLoopback.json?.error || '', /non-loopback/i);

  const reservedEvent = await runCli([
    'event',
    '--json',
    '--kind',
    'remote-command',
    '--message',
    'Should fail locally',
  ]);
  assert.notEqual(reservedEvent.code, 0);
  assert.match(reservedEvent.json?.error || '', /reserved/i);

  browser.ws.close();
  console.log('Remote control CLI self-test passed');
} finally {
  await stopBridge();
  restoreRuntimeConfig();
  fs.rmSync(tmp, { recursive: true, force: true });
}
