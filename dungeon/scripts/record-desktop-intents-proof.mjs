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
const defaultOutputRoot = path.join(dungeonRoot, '.logs', 'desktop-intents-proof');
const defaultWebsitePath = path.join(os.tmpdir(), 'seo-dungeon-demo-project');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');

function parseArgs(argv) {
  const options = {
    outputDir: process.env.SEO_DUNGEON_DESKTOP_INTENTS_OUTPUT_DIR || path.join(defaultOutputRoot, runStamp),
    domain: process.env.SEO_DUNGEON_DESKTOP_INTENTS_DOMAIN || 'example.com',
    projectPath: process.env.SEO_DUNGEON_DESKTOP_INTENTS_PROJECT || defaultWebsitePath,
    fps: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_FPS || 12),
    browserX: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_BROWSER_X || 960),
    browserY: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_BROWSER_Y || 0),
    browserWidth: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_BROWSER_WIDTH || 960),
    browserHeight: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_BROWSER_HEIGHT || 1040),
    keepOpenMs: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_KEEP_OPEN_MS || 1200),
    commandTimeoutMs: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_COMMAND_TIMEOUT_MS || 120000),
    fakeCodex: process.env.SEO_DUNGEON_DESKTOP_INTENTS_REAL_CODEX !== '1',
    minimizeKnownBlockers: process.env.SEO_DUNGEON_DESKTOP_INTENTS_MINIMIZE_BLOCKERS === '1',
    hideKnownBlockers: process.env.SEO_DUNGEON_DESKTOP_INTENTS_HIDE_BLOCKERS === '1',
    blockerProcesses: (process.env.SEO_DUNGEON_DESKTOP_INTENTS_BLOCKER_PROCESSES || 'CapCut')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    closeBlockerProcesses: (process.env.SEO_DUNGEON_DESKTOP_INTENTS_CLOSE_BLOCKER_PROCESSES || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    positionCodexWindow: process.env.SEO_DUNGEON_DESKTOP_INTENTS_POSITION_CODEX === '1',
    codexProcessName: process.env.SEO_DUNGEON_DESKTOP_INTENTS_CODEX_PROCESS || 'Codex',
    codexX: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_CODEX_X || 0),
    codexY: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_CODEX_Y || 0),
    codexWidth: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_CODEX_WIDTH || 900),
    codexHeight: Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_CODEX_HEIGHT || 900),
    allowFallbackProject: process.env.SEO_DUNGEON_DESKTOP_INTENTS_ALLOW_FALLBACK_PROJECT === '1',
    allowForegroundMismatch: process.env.SEO_DUNGEON_DESKTOP_INTENTS_ALLOW_FOREGROUND_MISMATCH === '1',
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
    else if (token === '--fps') options.fps = Number(readValue());
    else if (token === '--browser-x') options.browserX = Number(readValue());
    else if (token === '--browser-y') options.browserY = Number(readValue());
    else if (token === '--browser-width') options.browserWidth = Number(readValue());
    else if (token === '--browser-height') options.browserHeight = Number(readValue());
    else if (token === '--keep-open-ms') options.keepOpenMs = Number(readValue());
    else if (token === '--command-timeout-ms') options.commandTimeoutMs = Number(readValue());
    else if (token === '--real-codex') options.fakeCodex = false;
    else if (token === '--fake-codex') options.fakeCodex = true;
    else if (token === '--minimize-known-blockers') options.minimizeKnownBlockers = true;
    else if (token === '--hide-known-blockers') {
      options.hideKnownBlockers = true;
      options.minimizeKnownBlockers = true;
    }
    else if (token === '--blocker-process') {
      const processName = readValue().trim();
      if (!processName) throw new Error('--blocker-process cannot be empty.');
      options.blockerProcesses.push(processName);
    }
    else if (token === '--close-blocker-process') {
      const processName = readValue().trim();
      if (!processName) throw new Error('--close-blocker-process cannot be empty.');
      options.closeBlockerProcesses.push(processName);
      options.blockerProcesses.push(processName);
    }
    else if (token === '--position-codex-window') options.positionCodexWindow = true;
    else if (token === '--codex-process') options.codexProcessName = readValue();
    else if (token === '--codex-x') options.codexX = Number(readValue());
    else if (token === '--codex-y') options.codexY = Number(readValue());
    else if (token === '--codex-width') options.codexWidth = Number(readValue());
    else if (token === '--codex-height') options.codexHeight = Number(readValue());
    else if (token === '--allow-fallback-project') options.allowFallbackProject = true;
    else if (token === '--allow-foreground-mismatch') options.allowForegroundMismatch = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }

  for (const [name, value] of Object.entries({
    fps: options.fps,
    browserX: options.browserX,
    browserY: options.browserY,
    browserWidth: options.browserWidth,
    browserHeight: options.browserHeight,
    keepOpenMs: options.keepOpenMs,
    commandTimeoutMs: options.commandTimeoutMs,
    codexX: options.codexX,
    codexY: options.codexY,
    codexWidth: options.codexWidth,
    codexHeight: options.codexHeight,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`--${name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} must be a non-negative number.`);
    }
  }
  if (options.fps < 1) throw new Error('--fps must be at least 1.');
  if (options.browserWidth < 400 || options.browserHeight < 400) {
    throw new Error('--browser-width and --browser-height must be at least 400.');
  }
  if (!options.codexProcessName.trim()) throw new Error('--codex-process cannot be empty.');
  if (options.codexWidth < 400 || options.codexHeight < 400) {
    throw new Error('--codex-width and --codex-height must be at least 400.');
  }
  return options;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/record-desktop-intents-proof.mjs [--output-dir path] [--domain example.com] [--project /path/to/your/project]',
    '    [--browser-x 960] [--browser-y 0] [--browser-width 960] [--browser-height 1040] [--fake-codex|--real-codex]',
    '    [--position-codex-window] [--codex-process Codex] [--codex-x 0] [--codex-y 0] [--codex-width 900] [--codex-height 900]',
    '    [--minimize-known-blockers] [--hide-known-blockers] [--blocker-process CapCut] [--close-blocker-process Taskmgr]',
    '    [--allow-fallback-project] [--allow-foreground-mismatch]',
    '',
    'Records a full-desktop structured remote-intent proof with SEO Dungeon in a headed browser window.',
    'The default fake Codex path is for recursive smoke tests. Use --real-codex for release/demo proof.',
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
        if (!freePort) reject(new Error('Unable to allocate a free desktop-intents proof port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolvePorts() {
  const appPort = process.env.SEO_DUNGEON_DESKTOP_INTENTS_APP_PORT
    ? Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_APP_PORT)
    : await reserveFreePort();
  let bridgePort = process.env.SEO_DUNGEON_DESKTOP_INTENTS_BRIDGE_PORT
    ? Number(process.env.SEO_DUNGEON_DESKTOP_INTENTS_BRIDGE_PORT)
    : await reserveFreePort();
  while (bridgePort === appPort && !process.env.SEO_DUNGEON_DESKTOP_INTENTS_BRIDGE_PORT) {
    bridgePort = await reserveFreePort();
  }
  if (bridgePort === appPort) throw new Error('Desktop-intents app and bridge ports must differ.');
  return { appPort, bridgePort };
}

function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

function spawnNode(args, options) {
  return spawnProcess(process.execPath, args, options);
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
    send({ id: msg.id, result: { userAgent: 'fake-codex-desktop-intents-proof', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread_desktop_intents_proof' } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread_desktop_intents_proof' } } });
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
        ? ' DESKTOP_INTENTS_PROOF_ACTIVE_BATTLE_STREAM.'
        : ' DESKTOP_INTENTS_PROOF_QUEUE_STREAM.' } });
    }, 120));
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
    send({ method: 'item/agentMessage/delta', params: { delta: ' STEERED_DESKTOP_INTENTS_PROOF ' + textFromInput(msg.params.input) + '.' } });
    return;
  }
  if (msg.method === 'turn/interrupt') {
    for (const turnId of turns.keys()) complete(turnId, 'interrupted');
    send({ id: msg.id, result: {} });
  }
});
`, 'utf8');
}

function cliEnv(bridgeWs, origin) {
  return {
    ...process.env,
    SEO_DUNGEON_BRIDGE_URL: bridgeWs,
    SEO_DUNGEON_CONTROLLER_ORIGIN: origin,
  };
}

function runCli(args, { bridgeWs, origin, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnNode(['scripts/remote-control.mjs', ...args], {
      cwd: dungeonRoot,
      env: cliEnv(bridgeWs, origin),
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
    'demo=desktop-intents-proof',
    ...extraArgs,
  ];
  if (projectPath) args.push('--project', projectPath);
  for (const entry of meta) args.push('--meta', entry);
  if (command) args.push('--', command);
  const result = await runCli(args, { timeoutMs: timeoutMs + 5000, bridgeWs, origin });
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true, result.stdout);
  assert.equal(json.waitEvent?.kind, 'ui-result', result.stdout);
  assert.equal(json.waitEvent?.targetId, json.data?.event?.eventId, result.stdout);
  assert.equal(json.waitEvent?.status, 'complete', result.stdout);
  assert.equal(json.waitEvent?.action, action, result.stdout);
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

async function waitForSteerableOperation({ bridgeWs, origin, timeoutMs = 30000 }) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    const result = await runCli(['state', '--json'], { bridgeWs, origin, timeoutMs: 10000 });
    if (result.code !== 0) {
      throw new Error(`Could not read remote session state while waiting for steer readiness:\n${result.stdout}${result.stderr}`);
    }
    const json = JSON.parse(result.stdout);
    lastState = json.data;
    const operation = (lastState?.activeOperations || []).find((item) => item?.canSteer === true);
    if (operation) return { operation, state: lastState };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for a steerable active operation:\n${JSON.stringify(lastState, null, 2)}`);
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function buildProofEvidence({
  sessionState,
  finalLedger,
  cliResults,
  bridgeOutput,
  steerReady,
  options,
  codexWindow,
  foregroundBeforeCapture,
  probe,
}) {
  const requiredActions = [
    'launch',
    'gate-resume',
    'hall-select-issue',
    'battle-open-attack-prompt',
    'battle-attack',
    'queue-add',
    'queue-steer',
    'agent-stop',
    'queue-clear',
    'battle-vanquish',
  ];
  const events = Array.isArray(sessionState?.events) ? sessionState.events : [];
  const uiResults = events.filter((event) => event.kind === 'ui-result');
  const actionsCompleted = countBy(uiResults.filter((event) => event.status === 'complete'), (event) => event.action);
  const ledgerText = finalLedger.join('\n');
  const bridgeText = bridgeOutput.join('');
  const cliActionSet = new Set(cliResults.map((item) => item.action));
  const videoStream = Array.isArray(probe?.streams) ? probe.streams.find((stream) => stream.codec_type === 'video') : null;
  const allRequiredActionsComplete = requiredActions.every((action) => cliActionSet.has(action) && actionsCompleted[action] > 0);
  const steerFailurePattern = /could not steer active turn|prompt kept in queue|timed out waiting for a steerable active operation/i;
  const assertions = [
    {
      name: 'all-required-actions-complete',
      passed: allRequiredActionsComplete,
      detail: 'Every scripted remote UI intent received a matching complete ui-result.',
    },
    {
      name: 'steer-ready-observed',
      passed: Boolean(steerReady?.operation?.canSteer),
      detail: 'The recorder observed an active operation with canSteer=true before queue-steer.',
    },
    {
      name: 'steered-prompt-echoed',
      passed: /Demo queued prompt steered into the active battle turn\. Keep this proof read-only\./.test(ledgerText),
      detail: 'The Guild Ledger displayed the steered queued prompt.',
    },
    {
      name: 'no-steer-failure-observed',
      passed: !steerFailurePattern.test(`${ledgerText}\n${bridgeText}`),
      detail: 'Ledger and bridge output do not contain the known failed-steer messages.',
    },
    {
      name: 'operations-drained',
      passed: (sessionState?.activeOperations?.length || 0) === 0,
      detail: 'The final bridge state has no active operations left running.',
    },
    {
      name: 'proof-browser-foreground',
      passed: foregroundBeforeCapture?.processName?.toLowerCase() === 'chrome'
        && /SEO Dungeon Desktop Intents Proof/i.test(foregroundBeforeCapture?.title || ''),
      detail: 'The proof browser was the foreground window before recording started.',
    },
    {
      name: 'video-has-frames',
      passed: Number(videoStream?.width || 0) > 0 && Number(videoStream?.height || 0) > 0,
      detail: 'ffprobe found a non-empty desktop video stream.',
    },
  ];
  if (!options.fakeCodex) {
    assertions.push({
      name: 'codex-window-positioned',
      passed: Boolean(codexWindow?.moved),
      detail: 'The visible Codex desktop window was positioned for side-by-side capture.',
    });
  }
  return {
    eventCounts: countBy(events, (event) => event.kind),
    uiResultCountsByAction: actionsCompleted,
    requiredActions,
    cliActions: [...cliActionSet],
    ledgerLineCount: finalLedger.length,
    steerReadyObserved: Boolean(steerReady?.operation?.canSteer),
    steeredPromptEchoed: assertions.find((item) => item.name === 'steered-prompt-echoed')?.passed || false,
    noSteerFailureObserved: assertions.find((item) => item.name === 'no-steer-failure-observed')?.passed || false,
    finalActiveOperations: sessionState?.activeOperations?.length || 0,
    assertions,
  };
}

async function waitForChildExit(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null) return child?.exitCode ?? 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for child exit.')), timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function startDesktopRecorder({ capturePath, fps, ffmpegOutput }) {
  const args = [
    '-y',
    '-f', 'gdigrab',
    '-draw_mouse', '1',
    '-framerate', String(fps),
    '-rtbufsize', '256M',
    '-i', 'desktop',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    capturePath,
  ];
  ffmpegOutput.push(`[record] ffmpeg ${args.join(' ')}\n`);
  const proc = spawnProcess('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.on('data', (chunk) => ffmpegOutput.push(chunk.toString()));
  proc.stderr.on('data', (chunk) => ffmpegOutput.push(chunk.toString()));
  return proc;
}

async function stopDesktopRecorder(proc, ffmpegOutput) {
  if (!proc || proc.exitCode !== null) return;
  try { proc.stdin.write('q'); } catch (_) {}
  try {
    await waitForChildExit(proc, 8000);
  } catch (_) {
    ffmpegOutput.push('\n[recorder] ffmpeg did not stop after q; killing process tree.\n');
    await killTree(proc);
  }
}

function runTool(command, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out.`));
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

async function positionBrowserWindow(page, options) {
  await page.evaluate(() => { document.title = 'SEO Dungeon Desktop Intents Proof'; }).catch(() => {});
  const session = await page.context().newCDPSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: {
      left: Math.trunc(options.browserX),
      top: Math.trunc(options.browserY),
      width: Math.trunc(options.browserWidth),
      height: Math.trunc(options.browserHeight),
      windowState: 'normal',
    },
  });
  await session.send('Page.bringToFront').catch(() => {});
  await page.bringToFront();
}

async function focusBrowserWindowByTitle(title, logOutput = []) {
  const titlePattern = String(title || '').replace(/'/g, "''");
  const script = `
Add-Type -Namespace SeoDungeon -Name Win32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@
$deadline = (Get-Date).AddSeconds(5)
$p = $null
do {
  $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${titlePattern}*' } | Sort-Object StartTime -Descending | Select-Object -First 1
  if (-not $p) {
    $p = Get-Process chrome -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*ms-playwright*chrome.exe' } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
  }
  if (-not $p) { Start-Sleep -Milliseconds 200 }
} while (-not $p -and (Get-Date) -lt $deadline)
if (-not $p) { Write-Error 'No matching browser window found'; exit 2 }
[SeoDungeon.Win32]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 200
[SeoDungeon.Win32]::SetWindowPos($p.MainWindowHandle, [System.IntPtr](-1), 0, 0, 0, 0, 0x0043) | Out-Null
Start-Sleep -Milliseconds 150
[SeoDungeon.Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Write-Output "$($p.ProcessName):$($p.Id):$($p.MainWindowTitle)"
`;
  const result = await runTool('powershell', ['-NoProfile', '-Command', script], 8000);
  logOutput.push(`\n[focus] code=${result.code}\n${result.stdout}${result.stderr}\n`);
  if (result.code !== 0) throw new Error(`Could not focus browser window:\n${result.stderr || result.stdout}`);
}

async function getForegroundWindowInfo(logOutput = []) {
  const script = `
Add-Type -Namespace SeoDungeon -Name Foreground -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
'@
$handle = [SeoDungeon.Foreground]::GetForegroundWindow()
$windowProcessId = [uint32]0
[SeoDungeon.Foreground]::GetWindowThreadProcessId($handle, [ref]$windowProcessId) | Out-Null
$builder = New-Object System.Text.StringBuilder 1024
[SeoDungeon.Foreground]::GetWindowText($handle, $builder, $builder.Capacity) | Out-Null
$process = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
[pscustomobject]@{
  processName = $process.ProcessName
  pid = $windowProcessId
  title = $builder.ToString()
} | ConvertTo-Json -Compress
`;
  const result = await runTool('powershell', ['-NoProfile', '-Command', script], 8000);
  logOutput.push(`\n[foreground] code=${result.code}\n${result.stdout}${result.stderr}\n`);
  if (result.code !== 0) throw new Error(`Could not read foreground window:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

async function minimizeKnownBlockers(logOutput = [], hide = false, blockerProcesses = ['CapCut']) {
  const blockerProcessesJson = JSON.stringify([...new Set(blockerProcesses)]).replace(/'/g, "''");
  const script = `
Add-Type -Namespace SeoDungeon -Name WindowOps -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
'@
$names = '${blockerProcessesJson}' | ConvertFrom-Json
$showCommand = ${hide ? 0 : 6}
$targets = Get-Process | Where-Object { $names -contains $_.ProcessName }
foreach ($p in $targets) {
  if ($p.MainWindowHandle -ne 0) {
    [SeoDungeon.WindowOps]::ShowWindowAsync($p.MainWindowHandle, $showCommand) | Out-Null
    Write-Output ('{0}:{1}' -f $p.Id, $p.MainWindowTitle)
  }
}
`;
  const result = await runTool('powershell', ['-NoProfile', '-Command', script], 8000);
  logOutput.push(`\n[${hide ? 'hide' : 'minimize'}-known-blockers] code=${result.code}\n${result.stdout}${result.stderr}\n`);
  if (result.code !== 0) throw new Error(`Could not minimize known blockers:\n${result.stderr || result.stdout}`);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

async function positionCodexWindow(options, logOutput = []) {
  const safeProcessName = String(options.codexProcessName || '').replace(/'/g, "''");
  const x = Math.trunc(options.codexX);
  const y = Math.trunc(options.codexY);
  const width = Math.trunc(options.codexWidth);
  const height = Math.trunc(options.codexHeight);
  const script = `
Add-Type -Namespace SeoDungeon -Name CodexWindowOps -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool MoveWindow(System.IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr hWnd);
'@
$p = Get-Process -Name '${safeProcessName}' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1
if (-not $p) { Write-Error "No visible ${safeProcessName} window found"; exit 2 }
[SeoDungeon.CodexWindowOps]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null
Start-Sleep -Milliseconds 200
$moved = [SeoDungeon.CodexWindowOps]::MoveWindow($p.MainWindowHandle, ${x}, ${y}, ${width}, ${height}, $true)
[SeoDungeon.CodexWindowOps]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
[pscustomobject]@{
  processName = $p.ProcessName
  pid = $p.Id
  title = $p.MainWindowTitle
  moved = $moved
  x = ${x}
  y = ${y}
  width = ${width}
  height = ${height}
} | ConvertTo-Json -Compress
`;
  const result = await runTool('powershell', ['-NoProfile', '-Command', script], 8000);
  logOutput.push(`\n[position-codex-window] code=${result.code}\n${result.stdout}${result.stderr}\n`);
  if (result.code !== 0) throw new Error(`Could not position Codex window:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

async function closeBlockerProcess(processName, pid, logOutput = []) {
  const safeProcessName = String(processName || '').replace(/'/g, "''");
  const safePid = Number(pid);
  if (!safeProcessName || !Number.isInteger(safePid) || safePid <= 0) {
    throw new Error(`Invalid blocker process close request: ${processName}:${pid}`);
  }
  const script = `
Add-Type -Namespace SeoDungeon -Name CloseWindowOps -MemberDefinition @'
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder text, int count);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PostMessage(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam);
'@
$p = Get-Process -Id ${safePid} -ErrorAction Stop
if ($p.ProcessName -ne '${safeProcessName}') {
  Write-Error "PID ${safePid} is $($p.ProcessName), not ${safeProcessName}"
  exit 3
}
$posted = $false
if ($p.MainWindowHandle -ne 0) {
  [SeoDungeon.CloseWindowOps]::PostMessage($p.MainWindowHandle, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) | Out-Null
  $posted = $true
  Write-Output "$($p.ProcessName):$($p.Id):$($p.MainWindowTitle)"
}
$script:found = $false
$callback = [SeoDungeon.CloseWindowOps+EnumWindowsProc]{
  param([System.IntPtr]$hWnd, [System.IntPtr]$lParam)
  [uint32]$windowProcessId = 0
  [SeoDungeon.CloseWindowOps]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId) | Out-Null
  if ([int]$windowProcessId -eq ${safePid} -and [SeoDungeon.CloseWindowOps]::IsWindowVisible($hWnd)) {
    $builder = New-Object System.Text.StringBuilder 1024
    [SeoDungeon.CloseWindowOps]::GetWindowText($hWnd, $builder, $builder.Capacity) | Out-Null
    $title = $builder.ToString()
    if ($title) {
      $script:found = $true
      [SeoDungeon.CloseWindowOps]::PostMessage($hWnd, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) | Out-Null
      Write-Output "$($p.ProcessName):$($p.Id):$title"
    }
  }
  return $true
}
[SeoDungeon.CloseWindowOps]::EnumWindows($callback, [System.IntPtr]::Zero) | Out-Null
if (-not $script:found) {
  if (-not $posted) {
    Write-Error "No visible titled windows found for $($p.ProcessName):$($p.Id)"
    exit 4
  }
} else {
  $posted = $true
}
if (-not $posted) {
  exit 4
}
Start-Sleep -Milliseconds 300
$stillOpen = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue
if ($stillOpen -and $stillOpen.MainWindowTitle) {
  try {
    $null = $stillOpen.CloseMainWindow()
    Write-Output "closed-main-window:$($stillOpen.ProcessName):$($stillOpen.Id):$($stillOpen.MainWindowTitle)"
  } catch {
    Write-Output "close-error:$($stillOpen.ProcessName):$($stillOpen.Id):$($_.Exception.Message)"
  }
}
`;
  const result = await runTool('powershell', ['-NoProfile', '-Command', script], 8000);
  logOutput.push(`\n[close-blocker-process] code=${result.code}\n${result.stdout}${result.stderr}\n`);
  if (result.code !== 0) throw new Error(`Could not close blocker process:\n${result.stderr || result.stdout}`);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

async function assertBrowserForeground(options, logOutput = [], blockerActions = []) {
  if (options.minimizeKnownBlockers) {
    blockerActions.push(...(await minimizeKnownBlockers(logOutput, options.hideKnownBlockers, options.blockerProcesses))
      .map((target) => ({ action: options.hideKnownBlockers ? 'hide' : 'minimize', target })));
  }
  await focusBrowserWindowByTitle('SEO Dungeon Desktop Intents Proof', logOutput);
  await new Promise((resolve) => setTimeout(resolve, 350));
  let foregroundInfo = await getForegroundWindowInfo(logOutput);
  if (
    options.minimizeKnownBlockers &&
    foregroundInfo.processName &&
    options.blockerProcesses.some((name) => name.toLowerCase() === foregroundInfo.processName.toLowerCase())
  ) {
    blockerActions.push(...(await minimizeKnownBlockers(logOutput, options.hideKnownBlockers, options.blockerProcesses))
      .map((target) => ({ action: options.hideKnownBlockers ? 'hide' : 'minimize', target })));
    await focusBrowserWindowByTitle('SEO Dungeon Desktop Intents Proof', logOutput);
    await new Promise((resolve) => setTimeout(resolve, 350));
    foregroundInfo = await getForegroundWindowInfo(logOutput);
  }
  if (
    foregroundInfo.processName &&
    options.closeBlockerProcesses.some((name) => name.toLowerCase() === foregroundInfo.processName.toLowerCase())
  ) {
    blockerActions.push(...(await closeBlockerProcess(foregroundInfo.processName, foregroundInfo.pid, logOutput))
      .map((target) => ({ action: 'close', target })));
    await focusBrowserWindowByTitle('SEO Dungeon Desktop Intents Proof', logOutput);
    await new Promise((resolve) => setTimeout(resolve, 350));
    foregroundInfo = await getForegroundWindowInfo(logOutput);
  }
  if (!foregroundInfo.title?.includes('SEO Dungeon Desktop Intents Proof') && !options.allowForegroundMismatch) {
    throw new Error([
      `Foreground window is "${foregroundInfo.title || '(empty)'}" from ${foregroundInfo.processName || 'unknown'}:${foregroundInfo.pid}, not the SEO Dungeon proof browser.`,
      'Close/minimize the blocking window, pass --minimize-known-blockers, or pass --hide-known-blockers for stubborn known blockers.',
      'Use --allow-foreground-mismatch only for debugging, not final proof.',
    ].join('\n'));
  }
  return foregroundInfo;
}

async function ffprobeVideo(videoPath) {
  const result = await runTool('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size',
    '-show_streams',
    '-select_streams', 'v:0',
    '-of', 'json',
    videoPath,
  ]);
  if (result.code !== 0) throw new Error(`ffprobe failed:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

async function extractVideoFrame(videoPath, framePath, seek = '1') {
  const result = await runTool('ffmpeg', [
    '-y',
    '-ss', String(seek),
    '-i', videoPath,
    '-frames:v', '1',
    framePath,
  ], 15000);
  if (result.code !== 0) throw new Error(`ffmpeg frame extraction failed:\n${result.stderr || result.stdout}`);
}

async function remuxVideo(rawVideoPath, videoPath, ffmpegOutput) {
  const result = await runTool('ffmpeg', [
    '-y',
    '-i', rawVideoPath,
    '-c', 'copy',
    videoPath,
  ], 30000);
  ffmpegOutput.push(`\n[remux] code=${result.code}\n${result.stdout}${result.stderr}\n`);
  if (result.code !== 0) throw new Error(`ffmpeg remux failed:\n${result.stderr || result.stdout}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (process.platform !== 'win32') throw new Error('Desktop intent proof recording currently requires Windows gdigrab.');

  const { appPort, bridgePort } = await resolvePorts();
  const origin = `http://127.0.0.1:${appPort}`;
  const bridgeWs = `ws://127.0.0.1:${bridgePort}`;
  const appUrl = `${origin}/?bridge=${encodeURIComponent(bridgeWs)}`;
  const outputDir = path.resolve(options.outputDir);
  const rawVideoPath = path.join(outputDir, 'desktop-intents-proof.mkv');
  const videoPath = path.join(outputDir, 'desktop-intents-proof.mp4');
  const framePath = path.join(outputDir, 'desktop-intents-frame.png');
  const finalFramePath = path.join(outputDir, 'desktop-intents-final-frame.png');
  const screenshotPath = path.join(outputDir, 'desktop-intents-browser.png');
  const ledgerPath = path.join(outputDir, 'ledger.txt');
  const cliResultsPath = path.join(outputDir, 'remote-intent-results.json');
  const sessionStatePath = path.join(outputDir, 'session-state.json');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const bridgeOutputPath = path.join(outputDir, 'bridge-output.txt');
  const viteOutputPath = path.join(outputDir, 'vite-output.txt');
  const ffmpegOutputPath = path.join(outputDir, 'ffmpeg-output.txt');
  const sessionLogPath = path.join(outputDir, 'session-events.jsonl');
  const failureManifestPath = path.join(outputDir, 'failure-manifest.json');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-desktop-intents-proof-'));
  const fallbackProject = path.join(tmp, 'project');
  const fakeCodexAppServer = path.join(tmp, 'fake-codex-app-server.cjs');
  const bridgeOutput = [];
  const viteOutput = [];
  const ffmpegOutput = [];
  const cliResults = [];
  const blockerActions = [];
  let browser;
  let page;
  let bridge;
  let vite;
  let recorder;
  let bridgeHealth = null;
  let foregroundBeforeCapture = null;
  let codexWindow = null;
  let sessionState = null;
  let finalLedger = [];
  let seededCacheKeys = [];
  let steerReady = null;
  let failureError = null;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(fallbackProject, { recursive: true });
  fs.writeFileSync(path.join(fallbackProject, 'README.md'), '# SEO Dungeon Desktop Intents Proof Fallback Project\n', 'utf8');
  writeFakeCodexAppServer(fakeCodexAppServer);

  const requestedProjectPath = path.resolve(options.projectPath);
  const projectPathExists = fs.existsSync(options.projectPath);
  if (!projectPathExists && !options.fakeCodex && !options.allowFallbackProject) {
    throw new Error(`Project path does not exist for real-Codex proof: ${options.projectPath}`);
  }
  const projectPath = projectPathExists ? requestedProjectPath : fallbackProject;
  const cacheKeys = [
    `seo_dungeon_audit_${options.domain}_codex_fast`,
    `seo_dungeon_audit_${options.domain}_fast`,
    `seo_dungeon_audit_${options.domain}_haiku`,
    `seo_dungeon_audit_${options.domain}`,
  ];

  try {
    bridge = spawnNode(['server/index.js'], {
      cwd: dungeonRoot,
      env: {
        ...process.env,
        SEO_DUNGEON_BRIDGE_PORT: String(bridgePort),
        SEO_DUNGEON_BRIDGE_STRICT_PORT: '1',
        SEO_DUNGEON_ALLOWED_ORIGINS: origin,
        SEO_DUNGEON_SESSION_LOG: sessionLogPath,
        ...(options.fakeCodex
          ? {
              SEO_DUNGEON_CODEX_CLI: process.execPath,
              SEO_DUNGEON_CODEX_ARGS: `"${fakeCodexAppServer}"`,
            }
          : {}),
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

    const bridgeHealthResponse = await waitForHttp(`http://127.0.0.1:${bridgePort}/health`, 'bridge', bridgeOutput, bridge);
    bridgeHealth = await bridgeHealthResponse.json();
    assert.equal(bridgeHealth.ok, true);
    assert.equal(bridgeHealth.supportsRemoteControl, true);
    await waitForHttp(origin, 'vite', viteOutput, vite);

    browser = await chromium.launch({
      headless: false,
      args: [
        `--window-position=${Math.trunc(options.browserX)},${Math.trunc(options.browserY)}`,
        `--window-size=${Math.trunc(options.browserWidth)},${Math.trunc(options.browserHeight)}`,
      ],
    });
    page = await browser.newPage({
      viewport: {
        width: Math.trunc(options.browserWidth),
        height: Math.max(400, Math.trunc(options.browserHeight) - 90),
      },
    });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.addInitScript(({ keys, domain, projectPath }) => {
      localStorage.setItem('seo_dungeon_runtime', 'codex');
      localStorage.setItem('seo_dungeon_last_domain', domain);
      localStorage.setItem('seo_dungeon_last_path', projectPath);
      const cachePayload = JSON.stringify({
        domain,
        runtime: 'codex',
        profile: 'fast',
        model: 'fast',
        createdAt: Date.now(),
        auditData: {
          domain,
          score: 84,
          summary: 'Desktop remote intents proof cached audit',
          issues: [
            {
              id: 'desktop-proof-robots',
              title: 'Robots policy needs confirmation',
              description: 'Desktop proof fixture for Codex remote-control walkthrough.',
              severity: 'medium',
              category: 'technical',
              hp: 24,
            },
            {
              id: 'desktop-proof-canonical',
              title: 'Canonical URL needs verification',
              description: 'Desktop proof fixture selected by Codex remote intent.',
              severity: 'high',
              category: 'technical',
              hp: 36,
            },
          ],
        },
      });
      for (const key of keys) localStorage.setItem(key, cachePayload);
    }, { keys: cacheKeys, domain: options.domain, projectPath });

    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    seededCacheKeys = await page.evaluate((keys) => keys.filter((key) => localStorage.getItem(key)), cacheKeys);
    assert(seededCacheKeys.length > 0, `No proof cache keys were seeded. Expected one of: ${cacheKeys.join(', ')}`);
    await positionBrowserWindow(page, options);
    await page.waitForFunction(() => window.__seoDungeonDialogueReady === true, null, { timeout: 15000 });
    await page.waitForFunction(async () => {
      const { bridge } = await import('/src/utils/ws.js');
      return bridge.connected === true ||
        document.querySelector('#bridge-status')?.classList.contains('connected');
    }, null, { timeout: 15000 });
    if (options.positionCodexWindow) {
      codexWindow = await positionCodexWindow(options, ffmpegOutput);
    }
    await positionBrowserWindow(page, options);
    foregroundBeforeCapture = await assertBrowserForeground(options, ffmpegOutput, blockerActions);

    recorder = startDesktopRecorder({ capturePath: rawVideoPath, fps: options.fps, ffmpegOutput });
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (recorder.exitCode !== null) throw new Error(`ffmpeg exited early:\n${ffmpegOutput.join('').slice(-5000)}`);

    cliResults.push(await runIntent('launch', {
      bridgeWs,
      origin,
      projectPath,
      timeoutMs: options.commandTimeoutMs,
      extraArgs: [
        '--domain', options.domain,
        '--runtime', 'codex',
        '--profile', 'fast',
        '--character', 'knight',
        '--dangerous-bypass',
        '--message', 'Desktop structured remote intents proof launch',
      ],
    }));
    await page.waitForFunction(() => window.__seoDungeonGame?.scene?.isActive('Gate'), null, { timeout: 12000 });

    cliResults.push(await runIntent('gate-resume', {
      bridgeWs,
      origin,
      command: 'Resume cached quest for desktop remote intents proof.',
      timeoutMs: options.commandTimeoutMs,
    }));
    await page.waitForFunction(() => window.__seoDungeonGame?.scene?.isActive('DungeonHall'), null, { timeout: 12000 });

    cliResults.push(await runIntent('hall-select-issue', {
      bridgeWs,
      origin,
      meta: ['issueId=desktop-proof-canonical'],
      command: 'Select canonical issue for desktop proof battle.',
      timeoutMs: options.commandTimeoutMs,
    }));
    await page.waitForFunction(() => {
      const game = window.__seoDungeonGame;
      const battle = game?.scene?.getScene('Battle');
      return game?.scene?.isActive('Battle') && battle?.issue?.id === 'desktop-proof-canonical';
    }, null, { timeout: 12000 });

    cliResults.push(await runIntent('battle-open-attack-prompt', {
      bridgeWs,
      origin,
      timeoutMs: options.commandTimeoutMs,
    }));
    await page.waitForFunction(() => Boolean(document.getElementById('attack-prompt-overlay')), null, { timeout: 5000 });

    cliResults.push(await runIntent('battle-attack', {
      bridgeWs,
      origin,
      command: 'Demo remote battle attack: inspect the selected canonical issue, read relevant project metadata, keep the turn open briefly for steering, and do not edit files.',
      timeoutMs: Math.max(15000, options.commandTimeoutMs),
    }));
    await page.waitForFunction(() => !document.getElementById('attack-prompt-overlay'), null, { timeout: 5000 });
    await waitForLedger(page, /channels the agent/i, 'battle attack started');

    cliResults.push(await runIntent('queue-add', {
      bridgeWs,
      origin,
      command: 'Demo queued prompt steered into the active battle turn. Keep this proof read-only.',
      meta: ['hold=false'],
      timeoutMs: options.commandTimeoutMs,
    }));
    await waitForQueueText(page, 'Demo queued prompt steered into the active battle turn. Keep this proof read-only.', 'queued prompt before steer');
    steerReady = await waitForSteerableOperation({
      bridgeWs,
      origin,
      timeoutMs: Math.min(options.commandTimeoutMs, 120000),
    });

    cliResults.push(await runIntent('queue-steer', {
      bridgeWs,
      origin,
      meta: ['promptIndex=0'],
      timeoutMs: options.commandTimeoutMs,
    }));
    await waitForLedger(page, /> Demo queued prompt steered into the active battle turn\. Keep this proof read-only\./i, 'steered prompt ledger echo');

    cliResults.push(await runIntent('queue-add', {
      bridgeWs,
      origin,
      command: 'Demo held prompt cleared after remote stop. Keep this proof read-only.',
      timeoutMs: options.commandTimeoutMs,
    }));
    await waitForQueueText(page, 'Demo held prompt cleared after remote stop. Keep this proof read-only.', 'queued prompt before stop');

    cliResults.push(await runIntent('agent-stop', {
      bridgeWs,
      origin,
      timeoutMs: options.commandTimeoutMs,
    }));
    await page.waitForFunction(() => document.querySelector('#prompt-queue-title')?.textContent === 'Held', null, { timeout: 8000 });

    cliResults.push(await runIntent('queue-clear', {
      bridgeWs,
      origin,
      timeoutMs: options.commandTimeoutMs,
    }));
    await page.waitForFunction(() => {
      const state = window.__seoDungeonDialogueState?.();
      return state && state.queue.length === 0 && state.busy === false;
    }, null, { timeout: 15000 });

    cliResults.push(await runIntent('battle-vanquish', {
      bridgeWs,
      origin,
      command: 'Remote desktop proof marks the selected demon defeated.',
      timeoutMs: options.commandTimeoutMs,
    }));
    await page.waitForFunction(() => {
      const game = window.__seoDungeonGame;
      const defeated = game?.auditData?.issues?.some((issue) => issue.id === 'desktop-proof-canonical' && issue.defeated === true);
      return defeated && (game?.scene?.isVisible('DungeonHall') || game?.scene?.isActive('DungeonHall'));
    }, null, { timeout: 15000 });

    assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join('\n')}`);
    const stateResult = await runCli(['state', '--json'], { bridgeWs, origin, timeoutMs: 15000 });
    assert.equal(stateResult.code, 0, stateResult.stdout || stateResult.stderr);
    sessionState = JSON.parse(stateResult.stdout).data;
    finalLedger = await ledgerTexts(page);
    fs.writeFileSync(sessionStatePath, `${JSON.stringify(sessionState, null, 2)}\n`, 'utf8');
    fs.writeFileSync(ledgerPath, `${finalLedger.join('\n')}\n`, 'utf8');
    fs.writeFileSync(cliResultsPath, `${JSON.stringify(cliResults, null, 2)}\n`, 'utf8');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.waitForTimeout(options.keepOpenMs);
  } catch (err) {
    failureError = err;
    throw err;
  } finally {
    await stopDesktopRecorder(recorder, ffmpegOutput).catch((err) => ffmpegOutput.push(`\n[recorder] ${err.message}\n`));
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(bridgeOutputPath, bridgeOutput.join(''), 'utf8');
      fs.writeFileSync(viteOutputPath, viteOutput.join(''), 'utf8');
      fs.writeFileSync(ffmpegOutputPath, ffmpegOutput.join(''), 'utf8');
      if (failureError) {
        fs.writeFileSync(failureManifestPath, `${JSON.stringify({
          kind: 'desktop-structured-remote-intents-proof-failure',
          createdAt: new Date().toISOString(),
          repoRoot,
          appUrl,
          bridgeWs,
          domain: options.domain,
          projectPath,
          commandTimeoutMs: options.commandTimeoutMs,
          usedFallbackProject: projectPath === fallbackProject,
          allowFallbackProject: options.allowFallbackProject,
          fakeCodex: options.fakeCodex,
          codexTransport: bridgeHealth?.defaultCodexTransport || null,
          bridgeHealth,
          actions: cliResults.map((item) => item.action),
          seededCacheKeys,
          steerReadyOperation: steerReady?.operation || null,
          minimizedKnownBlockers: options.minimizeKnownBlockers,
          hiddenKnownBlockers: options.hideKnownBlockers,
          blockerProcesses: options.blockerProcesses,
          closeBlockerProcesses: options.closeBlockerProcesses,
          blockerActions,
          allowForegroundMismatch: options.allowForegroundMismatch,
          codexWindow,
          foregroundBeforeCapture,
          browserWindow: {
            x: options.browserX,
            y: options.browserY,
            width: options.browserWidth,
            height: options.browserHeight,
          },
          ports: {
            app: appPort,
            bridge: bridgePort,
          },
          error: {
            name: failureError.name,
            message: failureError.message,
            stack: failureError.stack,
          },
          bridgeOutput: bridgeOutputPath,
          viteOutput: viteOutputPath,
          ffmpegOutput: ffmpegOutputPath,
          sessionLog: sessionLogPath,
        }, null, 2)}\n`, 'utf8');
      }
    } catch (_) {}
    if (browser) await browser.close().catch(() => {});
    await killTree(vite);
    await killTree(bridge);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const rawVideoStats = fs.statSync(rawVideoPath);
  assert(rawVideoStats.size > 4096, `desktop intents raw video is unexpectedly small: ${rawVideoStats.size} bytes`);
  await remuxVideo(rawVideoPath, videoPath, ffmpegOutput);
  fs.writeFileSync(ffmpegOutputPath, ffmpegOutput.join(''), 'utf8');
  const videoStats = fs.statSync(videoPath);
  assert(videoStats.size > 4096, `desktop intents video is unexpectedly small: ${videoStats.size} bytes`);
  const probe = await ffprobeVideo(videoPath);
  const proofEvidence = buildProofEvidence({
    sessionState,
    finalLedger,
    cliResults,
    bridgeOutput,
    steerReady,
    options,
    codexWindow,
    foregroundBeforeCapture,
    probe,
  });
  for (const proofAssertion of proofEvidence.assertions) {
    assert.equal(proofAssertion.passed, true, `${proofAssertion.name}: ${proofAssertion.detail}`);
  }
  await extractVideoFrame(videoPath, framePath, '1');
  const durationSeconds = Number(probe?.format?.duration || 0);
  const finalFrameSeek = Number.isFinite(durationSeconds) && durationSeconds > 3
    ? Math.max(1, durationSeconds - 2).toFixed(3)
    : '1';
  await extractVideoFrame(videoPath, finalFramePath, finalFrameSeek);

  const manifest = {
    kind: 'desktop-structured-remote-intents-proof',
    createdAt: new Date().toISOString(),
    note: options.fakeCodex
      ? 'Full-desktop structured-intent proof using the fake Codex app-server for deterministic recursive testing. Use --real-codex for final handoff proof.'
      : 'Full-desktop structured-intent proof using the real Codex transport.',
    repoRoot,
    appUrl,
    bridgeWs,
    domain: options.domain,
    projectPath,
    commandTimeoutMs: options.commandTimeoutMs,
    usedFallbackProject: projectPath === fallbackProject,
    allowFallbackProject: options.allowFallbackProject,
    fakeCodex: options.fakeCodex,
    codexTransport: bridgeHealth?.defaultCodexTransport || null,
    codexCliOverride: options.fakeCodex ? process.execPath : (process.env.SEO_DUNGEON_CODEX_CLI || null),
    codexArgsOverride: options.fakeCodex ? `"${fakeCodexAppServer}"` : (process.env.SEO_DUNGEON_CODEX_ARGS || null),
    bridgeHealth,
    seededCacheKeys,
    steerReadyOperation: steerReady?.operation || null,
    proofEvidence,
    actions: cliResults.map((item) => ({
      action: item.action,
      eventId: item.result.data?.event?.eventId,
      waitTargetId: item.result.waitEvent?.targetId,
      waitStatus: item.result.waitEvent?.status,
      scene: item.result.waitEvent?.metadata?.scene,
    })),
    minimizedKnownBlockers: options.minimizeKnownBlockers,
    hiddenKnownBlockers: options.hideKnownBlockers,
    blockerProcesses: options.blockerProcesses,
    closeBlockerProcesses: options.closeBlockerProcesses,
    blockerActions,
    allowForegroundMismatch: options.allowForegroundMismatch,
    strictForegroundRequired: !options.allowForegroundMismatch,
    positionCodexWindow: options.positionCodexWindow,
    codexWindow,
    foregroundBeforeCapture,
    browserWindow: {
      x: options.browserX,
      y: options.browserY,
      width: options.browserWidth,
      height: options.browserHeight,
    },
    ports: {
      app: appPort,
      bridge: bridgePort,
    },
    rawVideo: rawVideoPath,
    video: videoPath,
    frame: framePath,
    finalFrame: finalFramePath,
    finalFrameSeekSeconds: finalFrameSeek,
    screenshot: screenshotPath,
    ledger: ledgerPath,
    cliResults: cliResultsPath,
    sessionState: sessionStatePath,
    sessionLog: sessionLogPath,
    bridgeOutput: bridgeOutputPath,
    viteOutput: viteOutputPath,
    ffmpegOutput: ffmpegOutputPath,
    ffprobe: probe,
    finalStateSummary: {
      events: sessionState?.events?.length || 0,
      connectedClients: sessionState?.connectedClients?.length || 0,
      activeOperations: sessionState?.activeOperations?.length || 0,
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, manifestPath, videoPath, screenshotPath }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message || err}\n`);
  process.exitCode = 1;
});
