#!/usr/bin/env node

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
const repoRoot = path.resolve(dungeonRoot, '..');
const defaultOutputRoot = path.join(dungeonRoot, '.logs', 'demo');
const defaultWebsitePath = path.join(os.tmpdir(), 'seo-dungeon-demo-project');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');

function parseArgs(argv) {
  const options = {
    outputDir: process.env.SEO_DUNGEON_DEMO_OUTPUT_DIR || path.join(defaultOutputRoot, runStamp),
    domain: process.env.SEO_DUNGEON_DEMO_DOMAIN || 'example.com',
    projectPath: process.env.SEO_DUNGEON_DEMO_PROJECT || defaultWebsitePath,
    keepOpenMs: Number(process.env.SEO_DUNGEON_DEMO_KEEP_OPEN_MS || 1200),
    headless: process.env.SEO_DUNGEON_DEMO_HEADLESS !== '0',
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
    else if (token === '--help' || token === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }

  if (!Number.isFinite(options.keepOpenMs) || options.keepOpenMs < 0) {
    throw new Error('--keep-open-ms must be a non-negative number.');
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/record-remote-demo.mjs [--output-dir path] [--domain example.com] [--project /path/to/your/project] [--headed]',
    '',
    'Records a browser-side remote-control rehearsal video under dungeon/.logs/demo.',
    'This is not the final desktop proof; it verifies the browser/Guild Ledger capture path.',
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
        if (!freePort) reject(new Error('Unable to allocate a free demo port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolvePorts() {
  const appPort = process.env.SEO_DUNGEON_DEMO_APP_PORT
    ? Number(process.env.SEO_DUNGEON_DEMO_APP_PORT)
    : await reserveFreePort();
  let bridgePort = process.env.SEO_DUNGEON_DEMO_BRIDGE_PORT
    ? Number(process.env.SEO_DUNGEON_DEMO_BRIDGE_PORT)
    : await reserveFreePort();
  while (bridgePort === appPort && !process.env.SEO_DUNGEON_DEMO_BRIDGE_PORT) {
    bridgePort = await reserveFreePort();
  }
  if (bridgePort === appPort) throw new Error('Demo app and bridge ports must differ.');
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
    send({ id: msg.id, result: { userAgent: 'fake-codex-demo', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread_remote_demo' } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread_remote_demo' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    const prompt = textFromInput(msg.params && msg.params.input);
    const turnId = 'turn_' + nextTurn++;
    const first = !/Second remote demo command|queued remote work|drains/i.test(prompt);
    const turn = { done: false, timers: [] };
    turns.set(turnId, turn);
    turn.timers.push(setTimeout(() => {
      send({ method: 'turn/started', params: { turn: { id: turnId } } });
      send({ id: msg.id, result: { turn: { id: turnId } } });
      send({ method: 'item/agentMessage/delta', params: { delta: first
        ? ' Remote rehearsal: Codex inspected the SEO Dungeon session bus for example.com.'
        : ' Remote rehearsal: queued command drained through the Guild Ledger without manual input.' } });
    }, 120));
    turn.timers.push(setTimeout(() => complete(turnId), first ? 4200 : 900));
    return;
  }
  if (msg.method === 'turn/interrupt') {
    for (const turnId of turns.keys()) complete(turnId, 'interrupted');
    send({ id: msg.id, result: {} });
  }
});
`, 'utf8');
}

function connectController(bridgeWs, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(bridgeWs, { headers: { Origin: origin } });
    const messages = [];
    ws.on('message', (chunk) => messages.push(JSON.parse(String(chunk))));
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

async function waitForControllerMessage(controller, predicate, label, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = controller.messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${label}. Messages: ${JSON.stringify(controller.messages, null, 2)}`);
}

async function sendRemote(controller, id, { command, projectPath }) {
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
  const ack = await waitForControllerMessage(controller, (msg) => msg.id === id, `remote ack ${id}`);
  assert.equal(ack.type, 'result', `remote command should be accepted: ${JSON.stringify(ack)}`);
  return ack.data.commandId;
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
  const screenshotPath = path.join(outputDir, 'remote-control-rehearsal.png');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const sessionStatePath = path.join(outputDir, 'session-state.json');
  const ledgerPath = path.join(outputDir, 'ledger.txt');
  const bridgeOutputPath = path.join(outputDir, 'bridge-output.txt');
  const viteOutputPath = path.join(outputDir, 'vite-output.txt');
  const controllerMessagesPath = path.join(outputDir, 'controller-messages.json');
  const sessionLogPath = path.join(outputDir, 'session-events.jsonl');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-demo-'));
  const fallbackProject = path.join(tmp, 'project');
  const fakeCodexAppServer = path.join(tmp, 'fake-codex-app-server.cjs');
  const bridgeOutput = [];
  const viteOutput = [];
  let browser;
  let context;
  let page;
  let bridge;
  let vite;
  let controller;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(fallbackProject, { recursive: true });
  fs.writeFileSync(path.join(fallbackProject, 'README.md'), '# SEO Dungeon Remote Demo Rehearsal\\n', 'utf8');
  writeFakeCodexAppServer(fakeCodexAppServer);

  const projectPath = fs.existsSync(options.projectPath)
    ? path.resolve(options.projectPath)
    : fallbackProject;

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

    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__seoDungeonDialogueReady === true, null, { timeout: 15000 });
    await page.waitForFunction(async () => {
      const { bridge } = await import('/src/utils/ws.js');
      return bridge.connected === true ||
        document.querySelector('#bridge-status')?.classList.contains('connected');
    }, null, { timeout: 15000 });

    await page.locator('#domain-input').fill(options.domain);
    await page.locator('#path-input').fill(projectPath);
    if (await page.locator('#danger-mode-toggle').getAttribute('aria-pressed') !== 'true') {
      await page.locator('#danger-mode-toggle').click();
    }
    await page.waitForTimeout(650);

    controller = await connectController(bridgeWs, origin);
    const firstCommandId = await sendRemote(controller, 7001, {
      projectPath,
      command: `First remote demo command for ${options.domain}: inspect the session bus and confirm Guild Ledger mirroring.`,
    });
    await page.locator('#ledger-remote-status').waitFor({ state: 'visible', timeout: 5000 });
    await waitForLedger(page, /Remote codex-app: First remote demo command/i, 'first remote command visible');
    await waitForLedger(page, /Remote rehearsal: Codex inspected/i, 'first fake Codex stream visible');

    const secondCommandId = await sendRemote(controller, 7002, {
      projectPath,
      command: 'Second remote demo command: prove queued remote work drains without touching the browser composer.',
    });
    await page.waitForFunction(() => {
      const state = window.__seoDungeonDialogueState?.();
      return state?.queue?.some((item) =>
        item.source === 'codex-app' &&
        item.text.includes('Second remote demo command')
      );
    }, null, { timeout: 5000 });
    await page.waitForFunction(() => (
      /Queued/i.test(document.querySelector('#ledger-remote-status')?.textContent || '')
    ), null, { timeout: 5000 });
    await waitForLedger(page, /Remote codex-app: Second remote demo command/i, 'second remote command visible');
    await waitForLedger(page, /queued command drained/i, 'second fake Codex stream visible');
    await page.waitForFunction(() => {
      const state = window.__seoDungeonDialogueState?.();
      return state && state.queue.length === 0 && state.busy === false;
    }, null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#ledger-remote-status')?.hidden === true, null, { timeout: 7000 });

    const stateId = 7003;
    controller.ws.send(JSON.stringify({ id: stateId, type: 'session-state' }));
    const finalState = await waitForControllerMessage(controller, (msg) => msg.id === stateId, 'final session state');
    assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join('\n')}`);
    assert(finalState.data?.events?.some((event) => event.commandId === firstCommandId), 'final state should include first command');
    assert(finalState.data?.events?.some((event) => event.commandId === secondCommandId), 'final state should include second command');

    const finalLedger = await ledgerTexts(page);
    fs.writeFileSync(sessionStatePath, `${JSON.stringify(finalState.data, null, 2)}\n`, 'utf8');
    fs.writeFileSync(ledgerPath, `${finalLedger.join('\n')}\n`, 'utf8');
    fs.writeFileSync(controllerMessagesPath, `${JSON.stringify(controller.messages, null, 2)}\n`, 'utf8');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.waitForTimeout(options.keepOpenMs);

    const video = page.video();
    await page.close();
    await context.close();
    context = null;
    const rawVideoPath = await video.path();
    const finalVideoPath = path.join(outputDir, 'remote-control-rehearsal.webm');
    fs.copyFileSync(rawVideoPath, finalVideoPath);

    const manifest = {
      kind: 'browser-remote-control-rehearsal',
      createdAt: new Date().toISOString(),
      note: 'Browser-side rehearsal only. Final proof still requires desktop capture with real Codex app and SEO Dungeon browser side by side.',
      repoRoot,
      appUrl,
      bridgeWs,
      domain: options.domain,
      projectPath,
      usedFallbackProject: projectPath === fallbackProject,
      commands: [
        { commandId: firstCommandId, summary: 'first remote command executed from controller' },
        { commandId: secondCommandId, summary: 'second remote command executed after queue/drain' },
      ],
      video: finalVideoPath,
      screenshot: screenshotPath,
      sessionState: sessionStatePath,
      sessionLog: sessionLogPath,
      ledger: ledgerPath,
      controllerMessages: controllerMessagesPath,
      bridgeOutput: bridgeOutputPath,
      viteOutput: viteOutputPath,
      finalStateSummary: {
        events: finalState.data?.events?.length || 0,
        connectedClients: finalState.data?.connectedClients?.length || 0,
        activeOperations: finalState.data?.activeOperations?.length || 0,
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
    try { controller?.ws?.close(); } catch (_) {}
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
