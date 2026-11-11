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
const { bridgePort, vitePort } = await resolveUxPorts();
const origin = `http://127.0.0.1:${vitePort}`;
const bridgeWs = `ws://127.0.0.1:${bridgePort}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-ux-'));
const fakeCodexAppServer = path.join(tmp, 'fake-codex-app-server.cjs');
const projectPath = path.join(tmp, 'project');
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
        if (!freePort) reject(new Error('Unable to allocate a free UX test port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolveUxPorts() {
  const requestedBridge = process.env.SEO_DUNGEON_UX_BRIDGE_PORT
    ? Number(process.env.SEO_DUNGEON_UX_BRIDGE_PORT)
    : null;
  const requestedVite = process.env.SEO_DUNGEON_UX_VITE_PORT
    ? Number(process.env.SEO_DUNGEON_UX_VITE_PORT)
    : null;
  const bridge = requestedBridge || await reserveFreePort();
  let vitePortCandidate = requestedVite || await reserveFreePort();
  while (vitePortCandidate === bridge && !requestedVite) {
    vitePortCandidate = await reserveFreePort();
  }
  if (vitePortCandidate === bridge) {
    throw new Error('SEO_DUNGEON_UX_BRIDGE_PORT and SEO_DUNGEON_UX_VITE_PORT must be different.');
  }
  return { bridgePort: bridge, vitePort: vitePortCandidate };
}

fs.mkdirSync(projectPath, { recursive: true });
fs.writeFileSync(path.join(projectPath, 'README.md'), '# SEO Dungeon UX Test\n', 'utf8');

fs.writeFileSync(fakeCodexAppServer, `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let threadId = 'thread_fake';
let nextTurn = 1;
let currentTurn = null;
const turns = new Map();
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

function completeTurn(turnId, status = 'completed') {
  const turn = turns.get(turnId);
  if (!turn || turn.completed) return;
  turn.completed = true;
  for (const timer of turn.timers) clearTimeout(timer);
  send({ method: 'turn/completed', params: { turn: { id: turnId, status } } });
}

function scheduleTurnDeltas(turnId, completeDelay = 6200) {
  const turn = turns.get(turnId);
  if (!turn) return;
  tinyDeltas.forEach((delta, index) => {
    turn.timers.push(setTimeout(() => {
      if (turn.completed) return;
      send({ method: 'item/agentMessage/delta', params: { delta } });
    }, 320 + (index * 95)));
  });
  turn.timers.push(setTimeout(() => completeTurn(turnId), completeDelay));
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: threadId } } });
    send({ method: 'thread/started', params: { thread: { id: threadId } } });
    return;
  }
  if (msg.method === 'turn/start') {
    const turnId = 'turn_' + nextTurn++;
    const promptText = textFromInput(msg.params && msg.params.input);
    const completeDelay = promptText.includes('Initial battle harness prompt.') ||
      promptText.includes('Second prompt that will be stopped.')
      ? 30000
      : 6200;
    const turn = { id: turnId, completed: false, timers: [] };
    turns.set(turnId, turn);
    currentTurn = turnId;
    setTimeout(() => {
      send({ method: 'turn/started', params: { turn: { id: turnId } } });
      send({ id: msg.id, result: { turn: { id: turnId } } });
      scheduleTurnDeltas(turnId, completeDelay);
    }, 80);
    return;
  }
  if (msg.method === 'turn/steer') {
    const turnId = msg.params && msg.params.turnId ? msg.params.turnId : currentTurn;
    const turn = turns.get(turnId);
    if (!turn || turn.completed) {
      send({ id: msg.id, error: { code: -32000, message: 'no active turn to steer' } });
      return;
    }
    send({ id: msg.id, result: { turnId } });
    send({ method: 'item/agentMessage/delta', params: { delta: ' STEERED_OK ' + textFromInput(msg.params.input) + '.' } });
    return;
  }
  if (msg.method === 'turn/interrupt') {
    for (const turnId of turns.keys()) completeTurn(turnId, 'interrupted');
    send({ id: msg.id, result: {} });
  }
});
`, 'utf8');

function spawnNode(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function runBridge() {
  bridge = spawnNode(process.execPath, ['server/index.js'], {
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
  vite = spawnNode(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: dungeonRoot,
    env: { ...process.env },
  });
  vite.stdout.on('data', (chunk) => viteOutput.push(chunk.toString()));
  vite.stderr.on('data', (chunk) => viteOutput.push(chunk.toString()));
}

function runCli(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/remote-control.mjs', ...args], {
      cwd: dungeonRoot,
      env: {
        ...process.env,
        SEO_DUNGEON_BRIDGE_URL: bridgeWs,
        SEO_DUNGEON_CONTROLLER_ORIGIN: origin,
      },
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

async function runRemoteUiIntent(action, { command = '', meta = [], timeoutMs = 15000 } = {}) {
  const args = [
    'event',
    '--json',
    '--wait',
    '--timeout',
    String(timeoutMs),
    '--kind',
    'ui-intent',
    '--action',
    action,
    '--meta',
    'ticket=RC-018',
  ];
  for (const entry of meta) args.push('--meta', entry);
  if (command) args.push('--', command);
  const result = await runCli(args, { timeoutMs: timeoutMs + 3000 });
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true, result.stdout);
  assert.equal(json.waitEvent?.kind, 'ui-result');
  assert.equal(json.waitEvent?.targetId, json.data?.event?.eventId);
  assert.equal(json.waitEvent?.status, 'complete', result.stdout);
  assert.equal(json.waitEvent?.action, action);
  return json;
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
    if (proc && proc.exitCode !== null) {
      throw new Error(`${label} exited early:\\n${output.join('').slice(-5000)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return res;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}:\\n${output.join('').slice(-5000)}`);
}

async function waitForLog(page, matcher, label, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const texts = await ledgerTexts(page);
    if (texts.some((text) => matcher.test(text))) return texts;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for ledger line: ${label}\\n${(await ledgerTexts(page)).join('\\n')}`);
}

async function ledgerTexts(page) {
  await page.evaluate(() => window.__seoDungeonFlushLogQueue?.()).catch(() => {});
  return page.locator('.log-line .log-text').evaluateAll((nodes) => nodes.map((node) => node.textContent || ''));
}

async function queueTexts(page) {
  return page.locator('.prompt-queue-item .prompt-queue-text').evaluateAll((nodes) => nodes.map((node) => node.textContent || ''));
}

async function waitForQueueText(page, text, label, timeoutMs = 8000) {
  await page.waitForFunction((expected) => {
    const state = window.__seoDungeonDialogueState?.();
    return state?.queue?.some((item) => item.text === expected);
  }, text, { timeout: timeoutMs }).catch(async (err) => {
    const state = await page.evaluate(() => window.__seoDungeonDialogueState?.()).catch(() => null);
    const ledger = await ledgerTexts(page).catch(() => []);
    throw new Error(`${label}: ${err.message}\nstate=${JSON.stringify(state)}\nledger=${ledger.join('\n')}`);
  });
}

async function expectNoStreamWordSpam(page) {
  const texts = await ledgerTexts(page);
  const spamWords = new Set(["I'll", 'verify', 'this', 'against', 'the', 'live', 'repo', 'but', 'there', 'are', 'un', 'comm', 'itted']);
  const spam = texts
    .map((text) => text.trim())
    .filter((text) => spamWords.has(text));
  assert.deepEqual(spam, [], `ledger rendered one-word stream spam:\\n${texts.join('\\n')}`);
}

async function waitForIdle(page) {
  await page.waitForFunction(() => {
    const stop = document.querySelector('#log-stop');
    const state = window.__seoDungeonDialogueState?.();
    const battle = window.__seoDungeonGame?.scene?.getScene('Battle');
    const battleReady = !battle ||
      !battle.scene?.isActive?.() ||
      battle.battleOver ||
      battle.isPlayerTurn === true;
    return stop &&
      stop.disabled &&
      state &&
      state.busy === false &&
      state.ledgerRunning === false &&
      state.hasQueueDrainTimer === false &&
      battleReady;
  }, null, { timeout: 12000 });
}

async function battleSnapshot(page) {
  return page.evaluate(() => {
    const game = window.__seoDungeonGame;
    const names = ['Boot', 'Gate', 'Summoning', 'DungeonHall', 'Battle', 'Victory'];
    const active = names.filter((name) => {
      try { return game?.scene?.isActive(name); } catch (_) { return false; }
    });
    let battle = null;
    try {
      const scene = game?.scene?.getScene('Battle');
      battle = scene ? {
        active: game?.scene?.isActive('Battle') === true,
        issueId: scene.issue?.id,
        issueDefeated: scene.issue?.defeated === true,
        isPlayerTurn: scene.isPlayerTurn === true,
        battleOver: scene.battleOver === true,
      } : null;
    } catch (_) {}
    return {
      active,
      scenes: names.map((name) => {
        try {
          const scene = game?.scene?.getScene(name);
          return scene ? {
            name,
            status: scene.scene?.settings?.status,
            active: game?.scene?.isActive(name) === true,
            visible: game?.scene?.isVisible(name) === true,
          } : { name, missing: true };
        } catch (err) {
          return { name, error: err.message };
        }
      }),
      battle,
      auditIssues: game?.auditData?.issues?.map((issue) => ({
        id: issue.id,
        defeated: issue.defeated === true,
        fixed: issue.fixed === true,
      })) || [],
      dialogue: window.__seoDungeonDialogueState?.() || null,
    };
  });
}

async function fillAndSubmit(page, text) {
  const input = page.locator('#log-input');
  await input.fill(text);
  await input.press('Enter');
}

async function runTitleLaunchSmoke(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/?bridge=${encodeURIComponent(bridgeWs)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#bridge-status')?.classList.contains('connected'), null, { timeout: 15000 });
  await expectNoStreamWordSpam(page);

  assert.equal(await page.locator('#danger-mode-toggle').getAttribute('aria-pressed'), 'false', 'YOLO must start disarmed on first boot');
  assert.equal(await page.locator('#descend-btn').isDisabled(), true, 'launch must be blocked until YOLO is armed');
  assert.equal(await page.locator('text=/deep audit|balanced|quick pass/i').count(), 0, 'old profile detail labels must not be visible');

  await page.locator('#domain-input').fill('example.com');
  await page.locator('#path-input').fill(projectPath);
  await page.locator('#danger-mode-toggle').click();
  await page.locator('#descend-btn').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#descend-btn').isDisabled(), false, 'launch should be enabled after domain, path, bridge, and YOLO are ready');
  await page.locator('#descend-btn').click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#title-screen')).display === 'none', null, { timeout: 6000 });
  assert.deepEqual(errors, [], `title launch page errors:\\n${errors.join('\\n')}`);
  await page.close();
}

async function runBattleLedgerHarness(context) {
  const page = await context.newPage();
  const errors = [];
  const consoleMessages = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  await page.addInitScript(({ projectPath: injectedProjectPath }) => {
    window.seoDungeonDangerousBypass = true;
    localStorage.setItem('seo_dungeon_last_domain', 'example.com');
    localStorage.setItem('seo_dungeon_last_path', injectedProjectPath);
    localStorage.setItem('seo_dungeon_audit_example.com_codex_balanced', JSON.stringify({
      domain: 'example.com',
      runtime: 'codex',
      profile: 'balanced',
      model: 'balanced',
      auditData: {
        score: 72,
        summary: 'Cached UX harness audit',
        issues: [{
          id: 'ux-harness-demon',
          title: 'Mobile UX issue',
          description: 'Regression fixture for battle ledger controls.',
          severity: 'medium',
          category: 'ux',
          hp: 60,
        }],
      },
      timestamp: Date.now(),
    }));
  }, { projectPath });

  await page.goto(`${origin}/?battle=1&bridge=${encodeURIComponent(bridgeWs)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#bridge-status')?.classList.contains('connected'), null, { timeout: 15000 });
  await page.locator('#game-container canvas').first().waitFor({ timeout: 15000 });
  await waitForLog(page, /DEV: jumping to battle/i, 'dev battle jump');
  await page.waitForFunction(() => window.__seoDungeonGame?.scene?.isActive('Battle'), null, { timeout: 15000 });

  const openAttack = await runRemoteUiIntent('battle-open-attack-prompt');
  assert.equal(openAttack.waitEvent?.metadata?.scene, 'Battle');
  await page.waitForFunction(() => Boolean(document.getElementById('attack-prompt-overlay')), null, { timeout: 5000 });

  const remoteAttack = await runRemoteUiIntent('battle-attack', {
    command: 'Initial battle harness prompt.',
    timeoutMs: 15000,
  });
  assert.equal(remoteAttack.waitEvent?.metadata?.scene, 'Battle');
  await page.waitForFunction(() => !document.getElementById('attack-prompt-overlay'), null, { timeout: 5000 });
  await waitForLog(page, /channels the agent/i, 'remote battle attack started');

  const remoteQueue = await runRemoteUiIntent('queue-add', {
    command: 'Remote queued prompt for steer.',
    meta: ['hold=false'],
  });
  assert.equal(remoteQueue.waitEvent?.metadata?.queueLength, '1');
  await waitForQueueText(page, 'Remote queued prompt for steer.', 'remote queue-add should add prompt');

  const remoteSteer = await runRemoteUiIntent('queue-steer', {
    meta: ['promptIndex=0'],
  });
  assert.equal(remoteSteer.waitEvent?.metadata?.queueLength, '0');
  await page.waitForFunction(() => document.querySelectorAll('.prompt-queue-item').length === 0);
  await waitForLog(page, /> Remote queued prompt for steer\./i, 'remote queue-steer should log steered prompt');

  await runRemoteUiIntent('queue-add', {
    command: 'Remote queued prompt for stop.',
  });
  await waitForQueueText(page, 'Remote queued prompt for stop.', 'remote queue-add should add prompt before stop');

  const remoteStop = await runRemoteUiIntent('agent-stop');
  assert.equal(remoteStop.waitEvent?.metadata?.scene, 'Battle');
  await page.waitForFunction(() => document.querySelector('#prompt-queue-title')?.textContent === 'Held');
  assert.deepEqual(await queueTexts(page), ['Remote queued prompt for stop.'], 'remote agent-stop should hold queued prompt');

  const remoteClear = await runRemoteUiIntent('queue-clear');
  assert.equal(remoteClear.waitEvent?.metadata?.queueLength, '0');
  await page.waitForFunction(() => document.querySelectorAll('.prompt-queue-item').length === 0);
  await waitForIdle(page);

  await fillAndSubmit(page, 'Initial battle harness prompt.');
  await waitForLog(page, /channels the agent/i, 'battle fix started');
  await fillAndSubmit(page, 'Please steer this into the active turn.');
  await page.locator('#prompt-queue-panel.open').waitFor({ timeout: 5000 });
  assert.deepEqual(await queueTexts(page), ['Please steer this into the active turn.']);

  await page.locator('#prompt-queue-steer').click();
  await page.waitForFunction(() => document.querySelectorAll('.prompt-queue-item').length === 0);
  assert.deepEqual(await queueTexts(page), [], 'steered prompt should leave the queue immediately');

  await fillAndSubmit(page, 'Queued after a successful steer.');
  await waitForQueueText(page, 'Queued after a successful steer.', 'post-steer prompt should queue before stop');
  await page.locator('#log-stop').click();
  await page.waitForFunction(() => document.querySelector('#prompt-queue-title')?.textContent === 'Held');
  assert.deepEqual(await queueTexts(page), ['Queued after a successful steer.'], 'stop after steer should hold the later queued prompt only');

  await page.locator('#prompt-queue-steer').click();
  assert.deepEqual(await queueTexts(page), [], 'post-steer held prompt should leave queue when submitted');
  await waitForLog(page, /> Queued after a successful steer\./i, 'post-steer held prompt becomes active user line');
  await waitForLog(page, /I'll verify this against the live repo\./i, 'post-steer held coalesced stream');
  await expectNoStreamWordSpam(page);
  await waitForIdle(page);

  await fillAndSubmit(page, 'Second prompt that will be stopped.');
  await waitForLog(page, /channels the agent/i, 'second battle fix started');
  await fillAndSubmit(page, 'Hold this prompt after stop.');
  await page.locator('#prompt-queue-panel.open').waitFor({ timeout: 5000 });
  await waitForQueueText(page, 'Hold this prompt after stop.', 'second prompt should queue before stop');
  await page.locator('#log-stop').click();
  await page.waitForFunction(() => document.querySelector('#prompt-queue-title')?.textContent === 'Held');
  assert.deepEqual(await queueTexts(page), ['Hold this prompt after stop.'], 'stop should hold queued prompt instead of orphaning it');

  await page.locator('#prompt-queue-steer').click();
  assert.deepEqual(await queueTexts(page), [], 'submitted held prompt should leave queue');
  await waitForLog(page, /> Hold this prompt after stop\./i, 'held prompt becomes active user line');
  await waitForLog(page, /I'll verify this against the live repo\./i, 'second coalesced agent stream');
  await expectNoStreamWordSpam(page);
  await waitForIdle(page);

  const remoteVanquish = await runRemoteUiIntent('battle-vanquish');
  assert.equal(remoteVanquish.waitEvent?.metadata?.scene, 'Battle');
  try {
    await page.waitForFunction(() => {
      const game = window.__seoDungeonGame;
      const defeated = game?.auditData?.issues?.some((issue) => issue.id === 'ux-harness-demon' && issue.defeated === true);
      return defeated && (
        game?.scene?.isActive('DungeonHall') ||
        game?.scene?.isVisible('DungeonHall')
      );
    }, null, { timeout: 15000 });
  } catch (err) {
    throw new Error(`${err.message}\nsnapshot=${JSON.stringify(await battleSnapshot(page))}\nconsole=${consoleMessages.join('\n')}\nledger=${(await ledgerTexts(page)).join('\n')}`);
  }

  assert.deepEqual(errors, [], `battle ledger page errors:\\n${errors.join('\\n')}`);
  await page.close();
}

runBridge();
runVite();

try {
  const healthResponse = await waitForHttp(`http://127.0.0.1:${bridgePort}/health`, 'bridge', bridgeOutput, bridge);
  const health = await healthResponse.json();
  assert.equal(health.supportsSteer, true, 'bridge health should advertise live steering');
  await waitForHttp(origin, 'vite', viteOutput, vite);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await runTitleLaunchSmoke(context);
  await runBattleLedgerHarness(context);
  await context.close();

  console.log('UX harness self-test passed');
} finally {
  if (browser) await browser.close().catch(() => {});
  await killTree(vite);
  await killTree(bridge);
  fs.rmSync(tmp, { recursive: true, force: true });
}
