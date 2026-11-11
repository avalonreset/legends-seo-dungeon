#!/usr/bin/env node

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
const repoRoot = path.resolve(dungeonRoot, '..');
const defaultOutputRoot = path.join(dungeonRoot, '.logs', 'remote-intents-demo');
const defaultWebsitePath = path.join(os.tmpdir(), 'seo-dungeon-demo-project');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');

function parseArgs(argv) {
  const options = {
    outputDir: process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_OUTPUT_DIR || path.join(defaultOutputRoot, runStamp),
    domain: process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_DOMAIN || 'example.com',
    projectPath: process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_PROJECT || defaultWebsitePath,
    keepOpenMs: Number(process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_KEEP_OPEN_MS || 1200),
    headless: process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_HEADLESS !== '0',
  };

  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    const readValue = () => {
      if (!tokens.length) throw new Error(`Missing value for ${token}`);
      return tokens.shift();
    };
    if (token === '--output-dir') options.outputDir = path.resolve(readValue());
    else if (token === '--domain') options.domain = readValue();
    else if (token === '--project') options.projectPath = readValue();
    else if (token === '--keep-open-ms') options.keepOpenMs = Number(readValue());
    else if (token === '--headed') options.headless = false;
    else if (token === '--headless') options.headless = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }

  if (!Number.isFinite(options.keepOpenMs) || options.keepOpenMs < 0) {
    throw new Error('--keep-open-ms must be a non-negative number.');
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/record-remote-intents-demo.mjs [--output-dir path] [--domain example.com] [--project /path/to/your/project] [--headed]',
    '',
    'Records a browser-side structured remote-intent walkthrough video under dungeon/.logs/remote-intents-demo.',
    'This is not the final desktop proof; it verifies the full helper-to-browser intent path with Playwright video.',
  ].join('\n');
}

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => {
        if (!freePort) reject(new Error('Unable to allocate a free remote-intents demo port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolvePorts() {
  const appPort = process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_APP_PORT
    ? Number(process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_APP_PORT)
    : await reserveFreePort();
  let bridgePort = process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_BRIDGE_PORT
    ? Number(process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_BRIDGE_PORT)
    : await reserveFreePort();
  while (bridgePort === appPort && !process.env.SEO_DUNGEON_REMOTE_INTENTS_DEMO_BRIDGE_PORT) {
    bridgePort = await reserveFreePort();
  }
  if (bridgePort === appPort) throw new Error('Remote-intents demo app and bridge ports must differ.');
  return { appPort, bridgePort };
}

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

function writeFakeCodexAppServer(file) {
  fs.writeFileSync(file, `
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
    send({ id: msg.id, result: { userAgent: 'fake-codex-remote-intents-demo', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread_remote_intents_demo' } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread_remote_intents_demo' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    const prompt = textFromInput(msg.params && msg.params.input);
    const turnId = 'turn_' + nextTurn++;
    const longBattleTurn = /Demo remote battle attack/i.test(prompt);
    const turn = { done: false, timers: [] };
    turns.set(turnId, turn);
    turn.timers.push(setTimeout(() => {
      send({ method: 'turn/started', params: { turn: { id: turnId } } });
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'item/agentMessage/delta', params: { delta: longBattleTurn
        ? ' Remote intent demo: Codex started the selected Battle fix and is holding the turn open for queue steering.'
        : ' Remote intent demo: Codex completed the queued follow-up through the Guild Ledger.' } });
    }, 100));
    turn.timers.push(setTimeout(() => complete(turnId), longBattleTurn ? 30000 : 2200));
    return;
  }
  if (msg.method === 'turn/steer') {
    const turnId = msg.params && msg.params.turnId ? msg.params.turnId : [...turns.keys()].at(-1);
    const turn = turns.get(turnId);
    if (!turn || turn.done) {
      send({ id: msg.id, error: { code: -32000, message: 'no active turn to steer' } });
      return;
    }
    send({ id: msg.id, result: { turnId } });
    send({ method: 'item/agentMessage/delta', params: { delta: ' STEERED_REMOTE_INTENT_DEMO ' + textFromInput(msg.params.input) + '.' } });
    return;
  }
  if (msg.method === 'turn/interrupt') {
    for (const turnId of turns.keys()) complete(turnId, 'interrupted');
    send({ id: msg.id, result: {} });
  }
});
`, 'utf8');
}

function runCli(args, { timeoutMs = 20000, bridgeWs, origin } = {}) {
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

async function runIntent(action, { bridgeWs, origin, command = '', projectPath = '', meta = [], timeoutMs = 30000, extraArgs = [] }) {
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
    'demo=remote-intents',
    ...extraArgs,
  ];
  if (projectPath) args.push('--project', projectPath);
  for (const entry of meta) args.push('--meta', entry);
  if (command) args.push('--', command);
  const result = await runCli(args, { timeoutMs: timeoutMs + 5000, bridgeWs, origin });
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true, result.stdout);
  assert.equal(json.waitEvent?.kind, 'ui-result');
  assert.equal(json.waitEvent?.targetId, json.data?.event?.eventId);
  assert.equal(json.waitEvent?.status, 'complete', result.stdout);
  assert.equal(json.waitEvent?.action, action);
  return { action, result: json };
}

async function ledgerTexts(page) {
  await page.evaluate(() => window.__seoDungeonFlushLogQueue?.()).catch(() => {});
  return page.locator('.log-line .log-text').evaluateAll((nodes) => nodes.map((node) => node.textContent || ''));
}

async function waitForLedger(page, matcher, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const texts = await ledgerTexts(page);
    if (texts.some((text) => matcher.test(text))) return texts;
    await page.waitForTimeout(120);
  }
  throw new Error(`Timed out waiting for ledger line: ${label}\n${(await ledgerTexts(page)).join('\n')}`);
}

async function waitForQueueText(page, text, label, timeoutMs = 8000) {
  await page.waitForFunction((expected) => {
    const state = window.__seoDungeonDialogueState?.();
    return state?.queue?.some((item) => item.text === expected);
  }, text, { timeout: timeoutMs }).catch(async (err) => {
    throw new Error(`${label}: ${err.message}\nledger=${(await ledgerTexts(page)).join('\n')}`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { appPort, bridgePort } = await resolvePorts();
  const origin = `http://127.0.0.1:${appPort}`;
  const bridgeWs = `ws://127.0.0.1:${bridgePort}`;
  const appUrl = `${origin}/?bridge=${encodeURIComponent(bridgeWs)}`;
  const outputDir = path.resolve(options.outputDir);
  const videoDir = path.join(outputDir, 'raw-video');
  const screenshotPath = path.join(outputDir, 'remote-intents-final.png');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const ledgerPath = path.join(outputDir, 'ledger.txt');
  const cliResultsPath = path.join(outputDir, 'remote-intent-results.json');
  const sessionStatePath = path.join(outputDir, 'session-state.json');
  const bridgeOutputPath = path.join(outputDir, 'bridge-output.txt');
  const viteOutputPath = path.join(outputDir, 'vite-output.txt');
  const sessionLogPath = path.join(outputDir, 'session-events.jsonl');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-remote-intents-demo-'));
  const fallbackProject = path.join(tmp, 'project');
  const fakeCodexAppServer = path.join(tmp, 'fake-codex-app-server.cjs');
  const bridgeOutput = [];
  const viteOutput = [];
  const cliResults = [];
  let browser;
  let context;
  let page;
  let bridge;
  let vite;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(fallbackProject, { recursive: true });
  fs.writeFileSync(path.join(fallbackProject, 'README.md'), '# SEO Dungeon Remote Intents Demo\\n', 'utf8');
  writeFakeCodexAppServer(fakeCodexAppServer);

  const projectPath = fs.existsSync(options.projectPath)
    ? path.resolve(options.projectPath)
    : fallbackProject;
  const cacheKey = `seo_dungeon_audit_${options.domain}_codex_fast`;

  try {
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

    const viteBin = path.join(dungeonRoot, 'node_modules', 'vite', 'bin', 'vite.js');
    vite = spawnNode([viteBin, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {
      cwd: dungeonRoot,
      env: { ...process.env },
    });
    vite.stdout.on('data', (chunk) => viteOutput.push(chunk.toString()));
    vite.stderr.on('data', (chunk) => viteOutput.push(chunk.toString()));

    await waitForHttp(`http://127.0.0.1:${bridgePort}/health`, 'bridge', bridgeOutput, bridge);
    await waitForHttp(origin, 'vite', viteOutput, vite);

    browser = await chromium.launch({ headless: options.headless });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
    });
    page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.addInitScript(({ key, domain }) => {
      localStorage.setItem(key, JSON.stringify({
        domain,
        runtime: 'codex',
        profile: 'fast',
        model: 'fast',
        createdAt: Date.now(),
        auditData: {
          domain,
          score: 84,
          summary: 'Remote intents demo cached audit',
          issues: [
            {
              id: 'demo-hall-1',
              title: 'Robots policy needs confirmation',
              description: 'Demo fixture for the remote-control walkthrough.',
              severity: 'medium',
              category: 'technical',
              hp: 24,
            },
            {
              id: 'demo-hall-2',
              title: 'Canonical URL needs verification',
              description: 'Demo fixture selected by Codex remote intent.',
              severity: 'high',
              category: 'technical',
              hp: 36,
            },
          ],
        },
      }));
    }, { key: cacheKey, domain: options.domain });

    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__seoDungeonDialogueReady === true, null, { timeout: 15000 });
    await page.waitForFunction(async () => {
      const { bridge } = await import('/src/utils/ws.js');
      return bridge.connected === true ||
        document.querySelector('#bridge-status')?.classList.contains('connected');
    }, null, { timeout: 15000 });

    cliResults.push(await runIntent('launch', {
      bridgeWs,
      origin,
      projectPath,
      extraArgs: [
        '--domain', options.domain,
        '--runtime', 'codex',
        '--profile', 'fast',
        '--character', 'knight',
        '--dangerous-bypass',
        '--message', 'Remote intents demo launch',
      ],
    }));
    await page.waitForFunction(() => window.__seoDungeonGame?.scene?.isActive('Gate'), null, { timeout: 12000 });

    cliResults.push(await runIntent('gate-resume', {
      bridgeWs,
      origin,
      command: 'Resume cached quest for remote intents demo.',
    }));
    await page.waitForFunction(() => window.__seoDungeonGame?.scene?.isActive('DungeonHall'), null, { timeout: 12000 });

    cliResults.push(await runIntent('hall-select-issue', {
      bridgeWs,
      origin,
      meta: ['issueId=demo-hall-2'],
      command: 'Select canonical issue for battle.',
    }));
    await page.waitForFunction(() => {
      const game = window.__seoDungeonGame;
      const battle = game?.scene?.getScene('Battle');
      return game?.scene?.isActive('Battle') && battle?.issue?.id === 'demo-hall-2';
    }, null, { timeout: 12000 });

    cliResults.push(await runIntent('battle-open-attack-prompt', { bridgeWs, origin }));
    await page.waitForFunction(() => Boolean(document.getElementById('attack-prompt-overlay')), null, { timeout: 5000 });

    cliResults.push(await runIntent('battle-attack', {
      bridgeWs,
      origin,
      command: 'Demo remote battle attack: inspect the selected canonical issue and keep the turn open for steering.',
      timeoutMs: 15000,
    }));
    await page.waitForFunction(() => !document.getElementById('attack-prompt-overlay'), null, { timeout: 5000 });
    await waitForLedger(page, /channels the agent/i, 'battle attack started');

    cliResults.push(await runIntent('queue-add', {
      bridgeWs,
      origin,
      command: 'Demo queued prompt steered into the active battle turn.',
      meta: ['hold=false'],
    }));
    await waitForQueueText(page, 'Demo queued prompt steered into the active battle turn.', 'queued prompt before steer');

    cliResults.push(await runIntent('queue-steer', {
      bridgeWs,
      origin,
      meta: ['promptIndex=0'],
    }));
    await waitForLedger(page, /> Demo queued prompt steered into the active battle turn\./i, 'steered prompt ledger echo');

    cliResults.push(await runIntent('queue-add', {
      bridgeWs,
      origin,
      command: 'Demo held prompt cleared after remote stop.',
    }));
    await waitForQueueText(page, 'Demo held prompt cleared after remote stop.', 'queued prompt before stop');

    cliResults.push(await runIntent('agent-stop', { bridgeWs, origin }));
    await page.waitForFunction(() => document.querySelector('#prompt-queue-title')?.textContent === 'Held', null, { timeout: 8000 });

    cliResults.push(await runIntent('queue-clear', { bridgeWs, origin }));
    await page.waitForFunction(() => {
      const state = window.__seoDungeonDialogueState?.();
      return state && state.queue.length === 0 && state.busy === false;
    }, null, { timeout: 15000 });

    cliResults.push(await runIntent('battle-vanquish', {
      bridgeWs,
      origin,
      command: 'Remote demo marks the selected demon defeated.',
    }));
    await page.waitForFunction(() => {
      const game = window.__seoDungeonGame;
      const defeated = game?.auditData?.issues?.some((issue) => issue.id === 'demo-hall-2' && issue.defeated === true);
      return defeated && (game?.scene?.isVisible('DungeonHall') || game?.scene?.isActive('DungeonHall'));
    }, null, { timeout: 15000 });

    await page.waitForTimeout(options.keepOpenMs);
    assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join('\n')}`);

    const stateResult = await runCli(['state', '--json'], { bridgeWs, origin, timeoutMs: 15000 });
    assert.equal(stateResult.code, 0, stateResult.stdout || stateResult.stderr);
    const sessionState = JSON.parse(stateResult.stdout).data;
    const finalLedger = await ledgerTexts(page);
    fs.writeFileSync(sessionStatePath, `${JSON.stringify(sessionState, null, 2)}\n`, 'utf8');
    fs.writeFileSync(ledgerPath, `${finalLedger.join('\n')}\n`, 'utf8');
    fs.writeFileSync(cliResultsPath, `${JSON.stringify(cliResults, null, 2)}\n`, 'utf8');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const video = page.video();
    await page.close();
    await context.close();
    context = null;
    const rawVideoPath = await video.path();
    const finalVideoPath = path.join(outputDir, 'remote-intents-demo.webm');
    fs.copyFileSync(rawVideoPath, finalVideoPath);

    const manifest = {
      kind: 'browser-structured-remote-intents-demo',
      createdAt: new Date().toISOString(),
      note: 'Browser-side structured-intent walkthrough. Final handoff video still needs desktop capture with real Codex app and SEO Dungeon browser side by side.',
      repoRoot,
      appUrl,
      bridgeWs,
      domain: options.domain,
      projectPath,
      usedFallbackProject: projectPath === fallbackProject,
      actions: cliResults.map((item) => ({
        action: item.action,
        eventId: item.result.data?.event?.eventId,
        waitTargetId: item.result.waitEvent?.targetId,
        waitStatus: item.result.waitEvent?.status,
        scene: item.result.waitEvent?.metadata?.scene,
      })),
      video: finalVideoPath,
      screenshot: screenshotPath,
      sessionState: sessionStatePath,
      sessionLog: sessionLogPath,
      ledger: ledgerPath,
      cliResults: cliResultsPath,
      bridgeOutput: bridgeOutputPath,
      viteOutput: viteOutputPath,
      finalStateSummary: {
        events: sessionState?.events?.length || 0,
        connectedClients: sessionState?.connectedClients?.length || 0,
        activeOperations: sessionState?.activeOperations?.length || 0,
      },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const stats = fs.statSync(finalVideoPath);
    assert(stats.size > 2048, `recorded video is unexpectedly small: ${stats.size} bytes`);

    process.stdout.write(`${JSON.stringify({ ok: true, manifestPath, videoPath: finalVideoPath, screenshotPath }, null, 2)}\n`);
  } finally {
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(bridgeOutputPath, bridgeOutput.join(''), 'utf8');
      fs.writeFileSync(viteOutputPath, viteOutput.join(''), 'utf8');
    } catch (_) {}
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await killTree(vite);
    await killTree(bridge);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message || err}\n`);
  process.exitCode = 1;
});
