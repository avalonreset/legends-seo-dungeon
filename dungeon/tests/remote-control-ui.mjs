import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dungeonRoot = path.resolve(__dirname, '..');
const { bridgePort, vitePort } = await resolveRemoteUiPorts();
const origin = `http://127.0.0.1:${vitePort}`;
const bridgeWs = `ws://127.0.0.1:${bridgePort}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-remote-ui-'));
const projectPath = path.join(tmp, 'project');
const fakeCodexAppServer = path.join(tmp, 'fake-codex-app-server.cjs');
const sessionLogPath = path.join(tmp, 'session-events.jsonl');
const screenshotPath = process.env.SEO_DUNGEON_REMOTE_UI_SCREENSHOT || '';
const bridgeOutput = [];
const viteOutput = [];
let bridge;
let vite;
let browser;

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => {
        if (!freePort) reject(new Error('Unable to allocate a free remote UI test port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolveRemoteUiPorts() {
  const requestedBridge = process.env.SEO_DUNGEON_REMOTE_UI_BRIDGE_PORT
    ? Number(process.env.SEO_DUNGEON_REMOTE_UI_BRIDGE_PORT)
    : null;
  const requestedVite = process.env.SEO_DUNGEON_REMOTE_UI_VITE_PORT
    ? Number(process.env.SEO_DUNGEON_REMOTE_UI_VITE_PORT)
    : null;
  const bridge = requestedBridge || await reserveFreePort();
  let vitePortCandidate = requestedVite || await reserveFreePort();
  while (vitePortCandidate === bridge && !requestedVite) {
    vitePortCandidate = await reserveFreePort();
  }
  if (vitePortCandidate === bridge) {
    throw new Error('Remote UI bridge and Vite test ports must be different.');
  }
  return { bridgePort: bridge, vitePort: vitePortCandidate };
}

fs.mkdirSync(projectPath, { recursive: true });
fs.writeFileSync(path.join(projectPath, 'README.md'), '# Remote Control UI Test\n', 'utf8');

fs.writeFileSync(fakeCodexAppServer, `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let nextTurn = 1;
const turns = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const textFromInput = (input) => Array.isArray(input)
  ? input.map((item) => item && item.text ? item.text : '').join('\\n').trim()
  : '';

function complete(turnId, status = 'completed') {
  const turn = turns.get(turnId);
  if (!turn || turn.done) return;
  turn.done = true;
  for (const timer of turn.timers) clearTimeout(timer);
  send({ method: 'turn/completed', params: { turn: { id: turnId, status } } });
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread_remote_ui' } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread_remote_ui' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    const prompt = textFromInput(msg.params && msg.params.input);
    const turnId = 'turn_' + nextTurn++;
    const first = prompt.includes('First remote command');
    const second = prompt.includes('Second remote command');
    const turn = { done: false, timers: [] };
    turns.set(turnId, turn);
    turn.timers.push(setTimeout(() => {
      send({ method: 'turn/started', params: { turn: { id: turnId } } });
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'item/agentMessage/delta', params: { delta: first ? ' FIRST_REMOTE_STREAM.' : second ? ' SECOND_REMOTE_STREAM.' : ' REMOTE_STREAM.' } });
    }, 80));
    turn.timers.push(setTimeout(() => complete(turnId), first ? 2400 : 650));
    return;
  }
  if (msg.method === 'turn/interrupt') {
    for (const turnId of turns.keys()) complete(turnId, 'interrupted');
    send({ id: msg.id, result: {} });
  }
});
`, 'utf8');

function spawnNode(args, options) {
  return spawn(process.execPath, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runBridge() {
  bridge = spawnNode(['server/index.js'], {
    cwd: dungeonRoot,
    env: {
      ...process.env,
      SEO_DUNGEON_BRIDGE_PORT: String(bridgePort),
      SEO_DUNGEON_ALLOWED_ORIGINS: origin,
      SEO_DUNGEON_SESSION_LOG: sessionLogPath,
      SEO_DUNGEON_CODEX_CLI: process.execPath,
      SEO_DUNGEON_CODEX_ARGS: `"${fakeCodexAppServer}"`,
    },
  });
  bridge.stdout.on('data', (chunk) => bridgeOutput.push(chunk.toString()));
  bridge.stderr.on('data', (chunk) => bridgeOutput.push(chunk.toString()));
}

function runVite() {
  const viteBin = path.join(dungeonRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  vite = spawnNode([viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: dungeonRoot,
    env: { ...process.env },
  });
  vite.stdout.on('data', (chunk) => viteOutput.push(chunk.toString()));
  vite.stderr.on('data', (chunk) => viteOutput.push(chunk.toString()));
}

async function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }
  child.kill('SIGTERM');
}

async function waitForHttp(url, label, output, proc, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (proc && proc.exitCode !== null) throw new Error(`${label} exited early:\n${output.join('').slice(-5000)}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return res;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}:\n${output.join('').slice(-5000)}`);
}

function connectController() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeWs, { headers: { Origin: origin } });
    const messages = [];
    ws.on('message', (chunk) => messages.push(JSON.parse(String(chunk))));
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

async function waitForControllerMessage(controller, predicate, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = controller.messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${label}. Messages: ${JSON.stringify(controller.messages, null, 2)}`);
}

async function ledgerTexts(page) {
  await page.evaluate(() => window.__seoDungeonFlushLogQueue?.()).catch(() => {});
  return page.locator('.log-line .log-text').evaluateAll((nodes) => nodes.map((node) => node.textContent || ''));
}

async function waitForLedger(page, matcher, label, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const texts = await ledgerTexts(page);
    if (texts.some((text) => matcher.test(text))) return texts;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for ledger line: ${label}\n${(await ledgerTexts(page)).join('\n')}`);
}

async function sendRemote(controller, id, command) {
  controller.ws.send(JSON.stringify({
    id,
    type: 'remote-command',
    source: 'codex-app',
    command,
    projectPath,
    runtime: 'codex',
    profile: 'fast',
    dangerousBypass: true,
  }));
  const ack = await waitForControllerMessage(controller, (msg) => msg.id === id, `ack ${id}`);
  assert.equal(ack.type, 'result', `remote command ${id} should be accepted: ${JSON.stringify(ack)}`);
  return ack.data.commandId;
}

async function requestSessionState(controller, id) {
  controller.ws.send(JSON.stringify({ id, type: 'session-state' }));
  return waitForControllerMessage(controller, (msg) => msg.id === id, `session state ${id}`);
}

async function waitForSessionState(controller, predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  let id = 4100;
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    const state = await requestSessionState(controller, id++);
    lastState = state.data;
    if (predicate(state.data)) return state;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify(lastState, null, 2)}`);
}

runBridge();
runVite();

try {
  const healthResponse = await waitForHttp(`http://127.0.0.1:${bridgePort}/health`, 'bridge', bridgeOutput, bridge);
  const health = await healthResponse.json();
  assert.equal(health.supportsRemoteControl, true, 'bridge should advertise remote control');
  assert.equal(health.sessionEventPersistence, true, 'bridge should advertise session-event persistence for restart replay');
  await waitForHttp(origin, 'vite', viteOutput, vite);
  let controller = await connectController();
  const replayCommandId = await sendRemote(controller, 2999, 'Persist remote command before Guild Ledger connects');
  assert(fs.existsSync(sessionLogPath), 'remote command should be persisted before bridge restart');
  controller.ws.close();
  await killTree(bridge);

  runBridge();
  await waitForHttp(`http://127.0.0.1:${bridgePort}/health`, 'restarted bridge', bridgeOutput, bridge);
  controller = await connectController();
  const restartState = await requestSessionState(controller, 2998);
  assert(
    restartState.data.events.some((event) =>
      event.kind === 'remote-command' &&
      event.commandId === replayCommandId &&
      event.command === 'Persist remote command before Guild Ledger connects'
    ),
    'restarted bridge should reload pending remote command before browser connects'
  );

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.goto(`${origin}/?bridge=${encodeURIComponent(bridgeWs)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__seoDungeonDialogueReady === true, null, { timeout: 15000 });
  await page.waitForFunction(async () => {
    const { bridge } = await import('/src/utils/ws.js');
    return bridge.connected === true ||
      document.querySelector('#bridge-status')?.classList.contains('connected');
  }, null, { timeout: 15000 });

  await waitForLedger(page, /Remote codex-app: Persist remote command before Guild Ledger connects/i, 'post-restart remote command replayed');
  await waitForLedger(page, /> Persist remote command before Guild Ledger connects/i, 'post-restart remote command submitted');
  await waitForLedger(page, /REMOTE_STREAM/i, 'pre-connect remote stream');
  const replayComplete = await waitForControllerMessage(
    controller,
    (msg) => msg.type === 'session-event' &&
      msg.event?.kind === 'ledger-result' &&
      msg.event?.commandId === replayCommandId &&
      msg.event?.status === 'complete',
    'pre-connect ledger-result'
  );
  assert.equal(replayComplete.event.source, 'codex-app');
  await page.waitForFunction(() => {
    const state = window.__seoDungeonDialogueState?.();
    return state && state.queue.length === 0 && state.busy === false;
  }, null, { timeout: 12000 });
  await page.waitForFunction(() => document.querySelector('#ledger-remote-status')?.hidden === true);
  const firstCommandId = await sendRemote(controller, 3001, 'First remote command from Codex app');
  await page.locator('#ledger-remote-status').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForFunction(() => /Remote/i.test(document.querySelector('#ledger-remote-status')?.textContent || ''));
  const runningChip = await page.locator('#ledger-remote-status').evaluate((node) => ({
    className: node.className,
    ariaLabel: node.getAttribute('aria-label'),
  }));
  assert.match(runningChip.className, /remote-running/, 'remote chip should expose running state class');
  assert.match(runningChip.ariaLabel || '', /Remote command from codex-app/i, 'remote chip should name the remote source for assistive tech');
  await waitForLedger(page, /Remote codex-app: First remote command from Codex app/i, 'first remote command visible');
  await waitForLedger(page, /> First remote command from Codex app/i, 'first remote command submitted');
  await waitForSessionState(
    controller,
    (state) => state.activeOperations?.some((operation) =>
      operation.type === 'chat' &&
      operation.source === 'codex-app' &&
      operation.runtime === 'codex'
    ),
    'active codex-app chat operation'
  );

  await sendRemote(controller, 3002, 'Second remote command waits in queue');
  await page.waitForFunction(() => {
    const state = window.__seoDungeonDialogueState?.();
    return state?.queue?.some((item) => item.text.includes('Second remote command waits in queue') && item.source === 'codex-app');
  }, null, { timeout: 8000 });
  await page.waitForFunction(() => /Queued/i.test(document.querySelector('#ledger-remote-status')?.textContent || ''));
  const queuedChip = await page.locator('#ledger-remote-status').evaluate((node) => ({
    className: node.className,
    ariaLabel: node.getAttribute('aria-label'),
  }));
  assert.match(queuedChip.className, /remote-queued/, 'remote chip should expose queued state class');
  assert.match(queuedChip.ariaLabel || '', /Remote command queued from codex-app/i, 'queued remote chip should name the remote source');

  const firstComplete = await waitForControllerMessage(
    controller,
    (msg) => msg.type === 'session-event' &&
      msg.event?.kind === 'ledger-result' &&
      msg.event?.commandId === firstCommandId &&
      msg.event?.status === 'complete',
    'first ledger-result'
  );
  assert.equal(firstComplete.event.source, 'codex-app');

  await waitForLedger(page, /FIRST_REMOTE_STREAM/i, 'first remote stream');
  await waitForLedger(page, /> Second remote command waits in queue/i, 'second queued remote command submitted');
  await waitForLedger(page, /SECOND_REMOTE_STREAM/i, 'second remote stream');
  if (screenshotPath) {
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }
  await page.waitForFunction(() => {
    const state = window.__seoDungeonDialogueState?.();
    return state && state.queue.length === 0 && state.busy === false;
  }, null, { timeout: 12000 });
  await page.waitForFunction(() => document.querySelector('#ledger-remote-status')?.hidden === true, null, { timeout: 6000 });

  const stateRequestId = 3003;
  const state = await requestSessionState(controller, stateRequestId);
  assert(state.data.events.some((event) => event.kind === 'remote-command' && event.command.includes('First remote command')));
  assert(state.data.events.some((event) => event.kind === 'ledger-result' && event.status === 'complete'));
  assert.equal(state.data.activeOperations.length, 0, 'active operations should clear after remote commands settle');
  assert(state.data.connectedClients.some((client) => client.role === 'browser'), 'session state should expose browser client');
  assert(state.data.connectedClients.some((client) => client.role === 'controller'), 'session state should expose controller client');
  assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join('\n')}`);
  controller.ws.close();

  console.log('Remote control UI self-test passed');
} finally {
  if (browser) await browser.close().catch(() => {});
  await killTree(vite);
  await killTree(bridge);
  fs.rmSync(tmp, { recursive: true, force: true });
}
