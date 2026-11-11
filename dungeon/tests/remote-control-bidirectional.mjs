import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dungeonRoot = path.resolve(__dirname, '..');
const { bridgePort, vitePort } = await resolvePorts();
const origin = `http://127.0.0.1:${vitePort}`;
const bridgeWs = `ws://127.0.0.1:${bridgePort}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-bidirectional-'));
const projectPath = path.join(tmp, 'project');
const fakeCodexAppServer = path.join(tmp, 'fake-codex-app-server.cjs');
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
        if (!freePort) reject(new Error('Unable to allocate a free bidirectional test port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolvePorts() {
  const requestedBridge = process.env.SEO_DUNGEON_BIDIRECTIONAL_BRIDGE_PORT
    ? Number(process.env.SEO_DUNGEON_BIDIRECTIONAL_BRIDGE_PORT)
    : null;
  const requestedVite = process.env.SEO_DUNGEON_BIDIRECTIONAL_VITE_PORT
    ? Number(process.env.SEO_DUNGEON_BIDIRECTIONAL_VITE_PORT)
    : null;
  const bridge = requestedBridge || await reserveFreePort();
  let viteCandidate = requestedVite || await reserveFreePort();
  while (viteCandidate === bridge && !requestedVite) {
    viteCandidate = await reserveFreePort();
  }
  if (viteCandidate === bridge) throw new Error('Bidirectional bridge and Vite ports must be different.');
  return { bridgePort: bridge, vitePort: viteCandidate };
}

fs.mkdirSync(projectPath, { recursive: true });
fs.writeFileSync(path.join(projectPath, 'README.md'), '# Remote Control Bidirectional Test\n', 'utf8');
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
    send({ id: msg.id, result: { userAgent: 'fake-codex-bidirectional', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread_bidirectional' } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread_bidirectional' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    const prompt = textFromInput(msg.params && msg.params.input);
    const turnId = 'turn_' + nextTurn++;
    const browserOrigin = prompt.includes('Browser-origin command for Codex watcher');
    const codexOrigin = prompt.includes('Codex helper command into Guild Ledger');
    const turn = { done: false, timers: [] };
    turns.set(turnId, turn);
    turn.timers.push(setTimeout(() => {
      send({ method: 'turn/started', params: { turn: { id: turnId } } });
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'item/agentMessage/delta', params: { delta: browserOrigin
        ? ' BROWSER_ORIGIN_STREAM.'
        : codexOrigin
          ? ' CODEX_HELPER_STREAM.'
          : ' BIDIRECTIONAL_STREAM.' } });
    }, 100));
    turn.timers.push(setTimeout(() => complete(turnId), 700));
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

function runBridge() {
  bridge = spawnNode(['server/index.js'], {
    cwd: dungeonRoot,
    env: {
      ...process.env,
      SEO_DUNGEON_BRIDGE_PORT: String(bridgePort),
      SEO_DUNGEON_ALLOWED_ORIGINS: origin,
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

function cliEnv(extra = {}) {
  return {
    ...process.env,
    SEO_DUNGEON_BRIDGE_URL: bridgeWs,
    SEO_DUNGEON_CONTROLLER_ORIGIN: origin,
    ...extra,
  };
}

function runCli(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/remote-control.mjs', ...args], {
      cwd: dungeonRoot,
      env: cliEnv(),
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
      resolve({ code, stdout, stderr });
    });
  });
}

function parseJsonLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

async function sceneSnapshot(page) {
  return page.evaluate(() => {
    const game = window.__seoDungeonGame;
    const names = ['Boot', 'Gate', 'Summoning', 'DungeonHall', 'Battle', 'Victory'];
    const active = names.filter((name) => {
      try { return game?.scene?.isActive(name); } catch (_) { return false; }
    });
    let battleIssue = null;
    let hallState = null;
    try {
      const battle = game?.scene?.getScene('Battle');
      battleIssue = battle?.issue ? { id: battle.issue.id, title: battle.issue.title } : null;
    } catch (_) {}
    try {
      const hall = game?.scene?.getScene('DungeonHall');
      hallState = hall ? {
        inFlight: Boolean(hall._battleStartInFlight),
        issueIds: Array.isArray(hall.issues) ? hall.issues.map((issue) => issue.id) : [],
      } : null;
    } catch (_) {}
    return { active, battleIssue, hallState };
  });
}

runBridge();
runVite();

try {
  const healthResponse = await waitForHttp(`http://127.0.0.1:${bridgePort}/health`, 'bridge', bridgeOutput, bridge);
  const health = await healthResponse.json();
  assert.equal(health.supportsRemoteControl, true, 'bridge should advertise remote control');
  await waitForHttp(origin, 'vite', viteOutput, vite);

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

  const cachedAudit = {
    domain: 'example.com',
    score: 82,
    issues: [
      {
        id: 'remote-hall-1',
        title: 'Robots directive needs review',
        description: 'The robots policy should be checked before production indexing.',
        severity: 'medium',
        category: 'technical',
        hp: 24,
      },
      {
        id: 'remote-hall-2',
        title: 'Canonical tag points at the wrong URL',
        description: 'The canonical URL does not match the preferred SEO Dungeon page.',
        severity: 'high',
        category: 'technical',
        hp: 36,
      },
    ],
  };
  await page.evaluate((auditData) => {
    localStorage.setItem('seo_dungeon_audit_example.com_codex_fast', JSON.stringify({
      domain: 'example.com',
      runtime: 'codex',
      profile: 'fast',
      model: 'fast',
      auditData,
      createdAt: Date.now(),
    }));
  }, cachedAudit);

  const launchIntent = await runCli([
    'event',
    '--json',
    '--wait',
    '--timeout',
    '10000',
    '--kind',
    'ui-intent',
    '--action',
    'launch',
    '--domain',
    'example.com',
    '--project',
    projectPath,
    '--runtime',
    'codex',
    '--profile',
    'fast',
    '--character',
    'knight',
    '--dangerous-bypass',
    '--meta',
    'ticket=RC-018',
    '--message',
    'Launch SEO Dungeon from Codex helper',
  ], { timeoutMs: 12000 });
  assert.equal(launchIntent.code, 0, launchIntent.stdout);
  const launchIntentJson = JSON.parse(launchIntent.stdout);
  assert.equal(launchIntentJson.ok, true);
  assert.equal(launchIntentJson.waitEvent?.kind, 'ui-result');
  assert.equal(launchIntentJson.waitEvent?.targetId, launchIntentJson.data?.event?.eventId);
  assert.equal(launchIntentJson.waitEvent?.status, 'complete');
  assert.equal(launchIntentJson.waitEvent?.action, 'launch');
  assert.equal(launchIntentJson.waitEvent?.metadata?.ticket, 'RC-018');

  const launchResult = await runCli([
    'watch',
    '--json',
    '--kind',
    'ui-result',
    '--filter-source',
    'guild-ledger',
    '--count',
    '1',
    '--timeout',
    '10000',
  ]);
  assert.equal(launchResult.code, 0, launchResult.stdout);
  const launchResultLines = parseJsonLines(launchResult.stdout);
  const launchResultEvent = launchResultLines.find((line) => line.type === 'session-event')?.event;
  assert.equal(launchResultEvent?.status, 'complete');
  assert.equal(launchResultEvent?.action, 'launch');
  assert.equal(launchResultEvent?.domain, 'example.com');
  assert.equal(launchResultEvent?.projectPath, projectPath);
  assert.equal(launchResultEvent?.runtime, 'codex');
  assert.equal(launchResultEvent?.profile, 'fast');
  assert.equal(launchResultEvent?.character, 'knight');
  assert.equal(launchResultEvent?.dangerousBypass, true);
  assert.equal(launchResultEvent?.targetId, launchIntentJson.data?.event?.eventId);
  assert.equal(launchResultEvent?.metadata?.ticket, 'RC-018');
  assert.equal(launchResultEvent?.metadata?.scene, 'title');

  await page.waitForFunction(() =>
    window.__seoDungeonGame?.domain === 'example.com' &&
    window.__seoDungeonGame?.projectPath &&
    document.querySelector('#title-screen')?.style.display === 'none'
  , null, { timeout: 8000 });
  const launchedState = await page.evaluate(() => ({
    domain: window.__seoDungeonGame?.domain,
    projectPath: window.__seoDungeonGame?.projectPath,
    profile: window.__seoDungeonGame?.characterConfig?.profile,
    runtime: window.__seoDungeonGame?.characterConfig?.runtime,
    dangerousBypass: window.__seoDungeonGame?.characterConfig?.dangerousBypass,
  }));
  assert.deepEqual(launchedState, {
    domain: 'example.com',
    projectPath,
    profile: 'fast',
    runtime: 'codex',
    dangerousBypass: true,
  });

  const browserWatch = runCli([
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
    '10000',
  ]);
  await page.waitForTimeout(500);
  await page.locator('#log-input').fill('Browser-origin command for Codex watcher');
  await page.locator('#log-input').press('Enter');
  await waitForLedger(page, /> Browser-origin command for Codex watcher/i, 'browser-origin command submitted');
  await waitForLedger(page, /BROWSER_ORIGIN_STREAM/i, 'browser-origin fake stream visible');
  const browserWatchResult = await browserWatch;
  assert.equal(browserWatchResult.code, 0, browserWatchResult.stdout);
  const browserWatchLines = parseJsonLines(browserWatchResult.stdout);
  const browserEvent = browserWatchLines.find((line) => line.type === 'session-event');
  assert.equal(browserEvent?.replay, false, 'browser-origin watch event should be live, not replay');
  assert.equal(browserEvent?.event?.kind, 'ledger-command');
  assert.equal(browserEvent?.event?.source, 'guild-ledger');
  assert.equal(browserEvent?.event?.command, 'Browser-origin command for Codex watcher');
  assert.equal(browserEvent?.event?.projectPath, projectPath);
  assert.equal(browserWatchLines.at(-1)?.type, 'watch-complete');
  assert.equal(browserWatchLines.at(-1)?.reason, 'count');

  await page.waitForFunction(() => {
    const state = window.__seoDungeonDialogueState?.();
    return state && state.queue.length === 0 && state.busy === false;
  }, null, { timeout: 12000 });

  const sendResult = await runCli([
    'send',
    '--json',
    '--wait',
    '--timeout',
    '12000',
    '--project',
    projectPath,
    '--profile',
    'fast',
    '--dangerous-bypass',
    '--',
    'Codex helper command into Guild Ledger',
  ], { timeoutMs: 16000 });
  assert.equal(sendResult.code, 0, sendResult.stdout);
  const sendJson = JSON.parse(sendResult.stdout);
  assert.equal(sendJson.ok, true);
  assert.equal(sendJson.waitEvent?.status, 'complete');
  await waitForLedger(page, /Remote codex-cli: Codex helper command into Guild Ledger/i, 'Codex helper command mirrored to ledger');
  await waitForLedger(page, /> Codex helper command into Guild Ledger/i, 'Codex helper command submitted through browser');
  await waitForLedger(page, /CODEX_HELPER_STREAM/i, 'Codex helper fake stream visible');

  const gateResume = await runCli([
    'event',
    '--json',
    '--wait',
    '--timeout',
    '10000',
    '--kind',
    'ui-intent',
    '--action',
    'gate-resume',
    '--meta',
    'ticket=RC-018',
    '--message',
    'Resume cached quest from Codex helper',
  ], { timeoutMs: 12000 });
  assert.equal(gateResume.code, 0, gateResume.stdout);
  const gateResumeJson = JSON.parse(gateResume.stdout);
  assert.equal(gateResumeJson.ok, true);
  assert.equal(gateResumeJson.waitEvent?.kind, 'ui-result');
  assert.equal(gateResumeJson.waitEvent?.targetId, gateResumeJson.data?.event?.eventId);
  assert.equal(gateResumeJson.waitEvent?.status, 'complete');
  assert.equal(gateResumeJson.waitEvent?.action, 'gate-resume');
  assert.equal(gateResumeJson.waitEvent?.metadata?.scene, 'Gate');
  await page.waitForFunction(() => window.__seoDungeonGame?.scene?.isActive('DungeonHall'), null, { timeout: 12000 });

  const hallSelect = await runCli([
    'event',
    '--json',
    '--wait',
    '--timeout',
    '10000',
    '--kind',
    'ui-intent',
    '--action',
    'hall-select-issue',
    '--meta',
    'ticket=RC-018',
    '--meta',
    'issueId=remote-hall-2',
    '--message',
    'Select canonical issue from Codex helper',
  ], { timeoutMs: 12000 });
  assert.equal(hallSelect.code, 0, hallSelect.stdout);
  const hallSelectJson = JSON.parse(hallSelect.stdout);
  assert.equal(hallSelectJson.ok, true);
  assert.equal(hallSelectJson.waitEvent?.kind, 'ui-result');
  assert.equal(hallSelectJson.waitEvent?.targetId, hallSelectJson.data?.event?.eventId);
  assert.equal(hallSelectJson.waitEvent?.status, 'complete');
  assert.equal(hallSelectJson.waitEvent?.action, 'hall-select-issue');
  assert.equal(hallSelectJson.waitEvent?.metadata?.scene, 'DungeonHall');
  assert.equal(hallSelectJson.waitEvent?.metadata?.issueId, 'remote-hall-2');
  try {
    await page.waitForFunction(() => {
      const game = window.__seoDungeonGame;
      const battle = game?.scene?.getScene('Battle');
      return game?.scene?.isActive('Battle') && battle?.issue?.id === 'remote-hall-2';
    }, null, { timeout: 12000 });
  } catch (err) {
    throw new Error(`${err.message}\nscene=${JSON.stringify(await sceneSnapshot(page))}\npageErrors=${pageErrors.join('\n')}`);
  }

  assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join('\n')}`);
  console.log('Remote control bidirectional UI/CLI self-test passed');
} finally {
  if (browser) await browser.close().catch(() => {});
  await killTree(vite);
  await killTree(bridge);
  fs.rmSync(tmp, { recursive: true, force: true });
}
