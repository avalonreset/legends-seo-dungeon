import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dungeonRoot = path.resolve(__dirname, '..');
const port = await resolveDialoguePort();
const baseUrl = `http://127.0.0.1:${port}/`;

let server;
const serverOutput = [];

async function resolveDialoguePort() {
  if (process.env.SEO_DUNGEON_DIALOGUE_TEST_PORT) {
    return Number(process.env.SEO_DUNGEON_DIALOGUE_TEST_PORT);
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => {
        if (!freePort) reject(new Error('Unable to allocate a free dialogue test port.'));
        else resolve(freePort);
      });
    });
  });
}

function runServer() {
  const viteBin = path.join(dungeonRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: dungeonRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));
}

async function stopServer() {
  if (!server || server.killed) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
  } else {
    server.kill('SIGTERM');
  }
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited early:\n${serverOutput.join('').slice(-4000)}`);
    }
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(800) });
      if (res.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${baseUrl}\n${serverOutput.join('').slice(-4000)}`);
}

async function installBridgeHarness(page) {
  await page.evaluate(async () => {
    const { bridge } = await import('/src/utils/ws.js');
    try { bridge.disconnect(); } catch (_) {}
    bridge.ws = null;
    bridge.handlers.clear();
    bridge._clearReconnect?.();

    const pending = new Map();
    let nextId = 9000;
    const harness = {
      calls: [],
      steered: [],
      cancelled: [],
      openFolderCalls: [],
      folderResult: null,
      folderFailure: null,
      failedSteers: 0,
      failNextSteer: false,
      pendingIds() {
        return Array.from(pending.keys());
      },
      resolveOldest(summary = 'done') {
        const id = Array.from(pending.keys())[0];
        if (!id) return null;
        pending.get(id).resolve(summary);
        return id;
      },
      rejectOldest(message = 'failed') {
        const id = Array.from(pending.keys())[0];
        if (!id) return null;
        pending.get(id).reject(message);
        return id;
      },
      setConnected(value) {
        bridge._setConnected(Boolean(value));
      },
      setBusy(value) {
        bridge.activeAuditId = value ? 777001 : null;
        window.dispatchEvent(new CustomEvent('seo-dungeon-agent-settled', { detail: { id: 777001 } }));
      },
      setNarrationBusy(value) {
        bridge.activeNarrationId = value ? 777002 : null;
        window.dispatchEvent(new CustomEvent('seo-dungeon-agent-settled', { detail: { id: 777002 } }));
      },
      setFailNextSteer() {
        this.failNextSteer = true;
      },
      setFolderResult(result) {
        this.folderResult = result;
        this.folderFailure = null;
      },
      setFolderFailure(message) {
        this.folderFailure = message || 'Injected folder failure';
      },
      setSteerSupport(value) {
        bridge.supportsSteer = value;
        window.dispatchEvent(new CustomEvent('seo-dungeon-bridge-capabilities', {
          detail: { supportsSteer: value }
        }));
      },
    };

    bridge.chat = (text, projectPath, profile, runtime, onStream) => {
      const id = ++nextId;
      bridge.activeLedgerId = id;
      harness.calls.push({ id, text, projectPath, profile, runtime });
      if (typeof onStream === 'function') {
        setTimeout(() => onStream(`streaming response for ${text}`), 0);
      }
      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve(summary) {
            pending.delete(id);
            bridge._clearActiveId(id);
            resolve({ data: { summary } });
          },
          reject(message) {
            pending.delete(id);
            bridge._clearActiveId(id);
            reject(new Error(message));
          },
        });
      });
    };

    bridge.steer = (text, targetId) => {
      const activeId = targetId ||
        bridge.activeLedgerId ||
        bridge.activeAuditId ||
        bridge.activeFixId ||
        bridge.activeCommitId ||
        null;
      if (!activeId) return Promise.reject(new Error('No active turn to steer.'));
      if (harness.failNextSteer) {
        harness.failNextSteer = false;
        harness.failedSteers += 1;
        return Promise.reject(new Error('Injected steer failure'));
      }
      harness.steered.push({ id: activeId, text });
      return Promise.resolve({ data: { targetId: activeId, mode: 'test' } });
    };

    bridge.cancel = (id) => {
      harness.cancelled.push(id);
      const entry = pending.get(id);
      if (entry) entry.reject('Cancelled by user');
      else bridge._clearActiveId(id);
    };

    bridge.openFolder = (projectPath) => {
      harness.openFolderCalls.push(projectPath);
      if (harness.folderFailure) return Promise.reject(new Error(harness.folderFailure));
      return Promise.resolve({
        data: harness.folderResult || { action: 'opened', path: projectPath }
      });
    };

    window.__dialogueHarness = harness;
    bridge._setConnected(true);
    setTimeout(() => bridge._setConnected(true), 0);
  });
}

async function submitPrompt(page, text) {
  const input = page.locator('#log-input');
  await input.fill(text);
  await input.press('Enter');
}

async function callTexts(page) {
  await waitForHarness(page);
  return page.evaluate(() => window.__dialogueHarness.calls.map((call) => call.text));
}

async function cancelledIds(page) {
  await waitForHarness(page);
  return page.evaluate(() => window.__dialogueHarness.cancelled.slice());
}

async function steeredTexts(page) {
  await waitForHarness(page);
  return page.evaluate(() => window.__dialogueHarness.steered.map((entry) => entry.text));
}

async function queueCount(page) {
  return page.locator('.prompt-queue-item').count();
}

async function separatorCount(page) {
  return page.locator('.log-separator').count();
}

async function waitForQueueCount(page, count) {
  await page.waitForFunction((expected) => document.querySelectorAll('.prompt-queue-item').length === expected, count);
}

async function waitForCalls(page, count) {
  await page.waitForFunction((expected) => window.__dialogueHarness?.calls.length === expected, count);
}

async function waitForSteers(page, count) {
  await page.waitForFunction((expected) => window.__dialogueHarness?.steered.length === expected, count);
}

async function waitForUiIdle(page) {
  await page.waitForFunction(() => {
    return !document.querySelector('#log-input-bar')?.classList.contains('running') &&
      !document.querySelector('#prompt-queue-panel')?.classList.contains('running');
  });
}

async function waitForUserLine(page, text) {
  await page.waitForFunction((needle) => {
    return Array.from(document.querySelectorAll('.log-line.user')).some((line) => line.textContent.includes(needle));
  }, text);
}

async function userLineCount(page, text) {
  return page.locator('.log-line.user').filter({ hasText: text }).count();
}

async function queueStatusLeakCount(page, text) {
  return page.locator('.log-line.queue').filter({ hasText: text }).count();
}

async function queueTexts(page) {
  return page.locator('.prompt-queue-text').evaluateAll((nodes) => nodes.map((node) => node.textContent));
}

async function logTexts(page) {
  await page.evaluate(() => window.__seoDungeonFlushLogQueue?.()).catch(() => {});
  return page.locator('.log-line .log-text').evaluateAll((nodes) => nodes.map((node) => node.textContent || ''));
}

async function genericQueueLogCount(page) {
  const texts = await logTexts(page);
  return texts.filter((text) => /^(Prompt queued|Prompt returned|Submitted held|Submitted queued|Steered active turn|Queue cleared|Removed queued|Updated queued)/i.test(text.trim())).length;
}

async function waitForLog(page, matcher, label, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const texts = await logTexts(page);
    if (texts.some((text) => matcher.test(text))) return texts;
    await page.waitForTimeout(80);
  }
  throw new Error(`Timed out waiting for log line: ${label}\n${(await logTexts(page)).join('\n')}`);
}

async function waitForDialogueReady(page) {
  await page.waitForFunction(() => window.__seoDungeonDialogueReady === true);
}

async function waitForHarness(page) {
  await page.waitForFunction(() => Boolean(window.__dialogueHarness), null, { timeout: 5000 });
}

async function resolveOldest(page, summary = 'done') {
  await waitForHarness(page);
  return page.evaluate((value) => window.__dialogueHarness.resolveOldest(value), summary);
}

async function setConnected(page, value) {
  await waitForHarness(page);
  await page.evaluate((next) => window.__dialogueHarness.setConnected(next), value);
}

async function setBusy(page, value) {
  await waitForHarness(page);
  await page.evaluate((next) => window.__dialogueHarness.setBusy(next), value);
}

async function setNarrationBusy(page, value) {
  await waitForHarness(page);
  await page.evaluate((next) => window.__dialogueHarness.setNarrationBusy(next), value);
}

async function failNextSteer(page) {
  await waitForHarness(page);
  await page.evaluate(() => window.__dialogueHarness.setFailNextSteer());
}

async function setSteerSupport(page, value) {
  await waitForHarness(page);
  await page.evaluate((next) => window.__dialogueHarness.setSteerSupport(next), value);
}

async function setFolderResult(page, result) {
  await waitForHarness(page);
  await page.evaluate((next) => window.__dialogueHarness.setFolderResult(next), result);
}

async function setFolderFailure(page, message) {
  await waitForHarness(page);
  await page.evaluate((next) => window.__dialogueHarness.setFolderFailure(next), message);
}

async function addSlowAgentLog(page) {
  await page.evaluate(async () => {
    const { addLog } = await import('/src/activity-log.js');
    addLog('old agent backlog '.repeat(80));
  });
}

runServer();

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__SEO_DUNGEON_WATCHDOG_MS = 120;
  });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/ws:\/\/127\.0\.0\.1:3003|favicon/i.test(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#log-input');
  await waitForDialogueReady(page);
  await installBridgeHarness(page);

  await page.evaluate(async () => {
    const { addLog, flushLogQueue } = await import('/src/activity-log.js');
    for (let i = 0; i < 15; i += 1) {
      addLog(`[command: fixture ${i}]`, { immediate: true });
    }
    flushLogQueue();
  });
  assert.equal(await separatorCount(page), 0, 'ordinary command volume should not create arbitrary ledger separators');
  await page.evaluate(async () => {
    const { addLog, flushLogQueue } = await import('/src/activity-log.js');
    addLog('[Complete]', { immediate: true });
    flushLogQueue();
  });
  await page.waitForFunction(() => document.querySelectorAll('.log-separator').length === 1);
  assert.equal(await separatorCount(page), 1, 'completion should create one logical ledger separator');

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('seo-dungeon-agent-status', {
      detail: {
        kind: 'compaction',
        phase: 'start',
        message: 'Compacting context. Preserving the trail before the hunt continues.'
      }
    }));
  });
  await page.locator('#compaction-overlay.open').waitFor({ timeout: 3000 });
  assert.match(await page.locator('#compaction-overlay .compaction-title').textContent(), /Compressing the Scroll/i, 'compaction overlay should name the context compression state');
  assert.equal(await page.locator('.log-line.compact').count(), 1, 'compaction should render as its own ledger category');
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('seo-dungeon-agent-status', {
      detail: {
        kind: 'compaction',
        phase: 'complete',
        message: 'Context compaction complete. The hunt continues.'
      }
    }));
  });
  await page.waitForFunction(() => !document.querySelector('#compaction-overlay')?.classList.contains('open'), null, { timeout: 3000 });
  assert.equal(await separatorCount(page), 1, 'compaction completion should not create a fake turn separator');

  assert.equal(await page.locator('#danger-mode-toggle').getAttribute('aria-pressed'), 'false', 'YOLO should start disarmed on every fresh app boot');
  await page.locator('#domain-input').fill('example.com');
  await page.locator('#path-input').fill('C:\\projects\\example-site');
  assert.equal(await page.locator('#descend-btn').isDisabled(), true, 'launch should stay disabled until YOLO is armed');
  await page.locator('#danger-mode-toggle').click();
  await page.evaluate(async () => {
    const { bridge } = await import('/src/utils/ws.js');
    bridge._setConnected(true);
  });
  await page.waitForFunction(() => !document.querySelector('#descend-btn')?.disabled, null, { timeout: 3000 });
  assert.equal(await page.locator('#descend-btn').isDisabled(), false, 'launch should enable when domain, path, bridge, and YOLO are ready');
  await page.locator('#danger-mode-toggle').click();
  assert.equal(await page.locator('#descend-btn').isDisabled(), true, 'launch should disable again if YOLO is disarmed');

  for (const runtime of ['claude', 'gemini', 'grok']) {
    await page.locator(`.runtime-option[data-runtime="${runtime}"]`).click();
    assert.equal(await page.locator(`.runtime-option[data-runtime="${runtime}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#danger-mode-toggle').isVisible(), false, 'Codex-only bypass must not gate other runtimes');
    assert.equal(await page.locator('#descend-btn').isDisabled(), false, 'selected runtime is ready without Codex bypass');
  }
  assert.equal(await page.locator('.char-option[data-char="warrior"] .char-model').textContent(), 'HIGH');
  await page.locator('.runtime-option[data-runtime="gemini"]').click();
  assert.equal(await page.locator('.char-option[data-char="warrior"] .char-model').textContent(), 'PRO');
  assert.equal(await page.locator('.char-option[data-char="knight"] .char-model').textContent(), 'FLASH-LITE');
  await page.locator('.runtime-option[data-runtime="codex"]').click();
  assert.equal(await page.locator('#danger-mode-toggle').isVisible(), true);
  assert.equal(await page.locator('#descend-btn').isDisabled(), true, 'Codex still requires explicit bypass');

  await page.locator('#domain-input').fill('example.com');
  await page.waitForFunction(() => document.querySelector('#open-domain-btn')?.href === 'https://example.com/');
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#open-domain-btn').click();
  const domainPopup = await popupPromise;
  assert.equal(domainPopup.url(), 'https://example.com/', 'domain action should open the normalized website URL');
  await domainPopup.close();
  await waitForLog(page, /Opening website: https:\/\/example\.com\//i, 'domain open log');

  await page.locator('#path-input').fill('D:\\missing-seo-folder');
  await setFolderResult(page, { action: 'selected', path: 'C:\\Picked\\Seo Site' });
  await page.locator('#open-folder-btn').click();
  await page.waitForFunction(() => document.querySelector('#path-input')?.value === 'C:\\Picked\\Seo Site');
  await waitForLog(page, /Saved folder was unavailable; chose a new project folder\./i, 'folder fallback log');
  await waitForLog(page, /Selected folder: C:\/Picked\/Seo Site/i, 'folder selected log');
  await setFolderFailure(page, 'Picker closed');
  await page.locator('#open-folder-btn').click();
  await waitForLog(page, /Could not open folder: Picker closed/i, 'folder failure log');

  const widthBeforeDrag = await page.locator('#log-panel').evaluate((node) => node.getBoundingClientRect().width);
  const resizerBox = await page.locator('#ledger-resizer').boundingBox();
  assert(resizerBox, 'ledger resizer should have a bounding box');
  await page.mouse.move(resizerBox.x + 2, resizerBox.y + resizerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizerBox.x - 120, resizerBox.y + resizerBox.height / 2, { steps: 6 });
  await page.mouse.up();
  const savedLedgerWidth = await page.evaluate(() => Number(localStorage.getItem('seo_dungeon_ledger_width') || 0));
  assert(savedLedgerWidth > widthBeforeDrag + 40, `ledger resize should persist a wider panel (${savedLedgerWidth} vs ${widthBeforeDrag})`);
  await page.locator('#ledger-toggle').click();
  await page.waitForFunction(() => document.body.classList.contains('ledger-hidden'));
  assert.equal(await page.evaluate(() => localStorage.getItem('seo_dungeon_ledger_hidden')), '1', 'ledger hidden state should persist to localStorage');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#log-input');
  await waitForDialogueReady(page);
  await page.waitForFunction(() => document.body.classList.contains('ledger-hidden'));
  await page.locator('#ledger-open-toggle').click();
  await page.waitForFunction(() => !document.body.classList.contains('ledger-hidden'));
  await page.waitForFunction((expected) => {
    const width = document.querySelector('#log-panel')?.getBoundingClientRect().width || 0;
    return Math.abs(width - expected) <= 3;
  }, savedLedgerWidth);
  const widthAfterReload = await page.locator('#log-panel').evaluate((node) => node.getBoundingClientRect().width);
  assert(Math.abs(widthAfterReload - savedLedgerWidth) <= 3, `ledger width should survive reload (${widthAfterReload} vs ${savedLedgerWidth})`);
  await installBridgeHarness(page);

  assert.equal(await page.locator('#log-input-bar #log-stop').count(), 1, 'input bar should expose the stop button');
  assert.equal(await page.locator('#log-input-bar #log-submit').count(), 1, 'input bar should expose the send/queue button');
  assert.equal(await page.locator('#log-input-bar #prompt-queue-steer').count(), 0, 'input bar should not expose queue/steer buttons');
  assert.equal(await page.locator('#ledger-remote-status').isHidden(), true, 'remote status chip should be hidden while idle');
  assert.equal(await page.locator('#log-input-bar #ledger-remote-status').count(), 0, 'remote status chip should stay in the ledger header');
  await page.setViewportSize({ width: 820, height: 720 });
  const remoteHeaderBoxes = await page.evaluate(() => {
    const panel = document.querySelector('#log-panel');
    const chip = document.querySelector('#ledger-remote-status');
    const title = document.querySelector('#log-header h2');
    const toggle = document.querySelector('#ledger-toggle');
    panel.style.width = '260px';
    panel.style.minWidth = '260px';
    panel.style.maxWidth = '260px';
    chip.hidden = false;
    chip.className = 'remote-running';
    chip.querySelector('.ledger-remote-label').textContent = 'Remote';
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    const result = { chip: box(chip), title: box(title), toggle: box(toggle) };
    chip.hidden = true;
    panel.style.width = '';
    panel.style.minWidth = '';
    panel.style.maxWidth = '';
    return result;
  });
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  assert.equal(overlaps(remoteHeaderBoxes.chip, remoteHeaderBoxes.toggle), false, 'remote status chip should not overlap ledger toggle');
  assert.equal(overlaps(remoteHeaderBoxes.chip, remoteHeaderBoxes.title), false, 'remote status chip should not overlap Guild Ledger title at narrow width');
  await page.setViewportSize({ width: 1280, height: 720 });
  assert.equal(await page.locator('#log-stop').isVisible(), false, 'stop should be hidden while idle');
  assert.equal(await page.locator('#log-submit').isVisible(), false, 'send should be hidden until there is composer text');

  await page.locator('#log-input').fill('Visible send control');
  await page.waitForFunction(() => document.querySelector('#log-input-bar')?.classList.contains('has-text'));
  assert.equal(await page.locator('#log-submit').isVisible(), true, 'send should show when the composer has text');
  await page.locator('#log-input').fill('');
  await page.waitForFunction(() => !document.querySelector('#log-input-bar')?.classList.contains('has-text'));
  assert.equal(await page.locator('#log-submit').isVisible(), false, 'send should hide again when the composer is empty');

  await submitPrompt(page, 'Idle direct command');
  await waitForCalls(page, 1);
  await waitForUserLine(page, 'Idle direct command');
  await page.waitForFunction(() => document.querySelectorAll('.log-line.latest.active-output').length === 1);
  assert.equal(await page.locator('#log-stop').isVisible(), true, 'stop should show while the agent is running');
  assert.equal(await page.locator('#prompt-queue-panel').isVisible(), false, 'queue panel should stay hidden while running with no queued prompts');
  assert.equal(await queueCount(page), 0, 'idle submit should not create a queued item');
  await page.waitForTimeout(260);
  assert.equal(await page.locator('#log-input-bar').evaluate((node) => node.classList.contains('running')), true, 'watchdog should not hide running state while a bridge request is still active');
  assert.equal(await page.locator('.log-line.latest.active-output').count(), 1, 'watchdog should keep the active output glow while a bridge request is still active');
  await resolveOldest(page, 'idle complete');
  await waitForUiIdle(page);
  assert.equal(await page.locator('.log-line.active-output').count(), 0, 'active read-glow marker should clear after the agent settles');
  assert.equal(await page.locator('#log-stop').isVisible(), false, 'stop should hide after the agent settles');

  await page.evaluate(async () => {
    const { addLog } = await import('/src/activity-log.js');
    document.querySelector('#log-content')?.classList.remove('ledger-idle');
    addLog('First active transition probe ' + 'alpha '.repeat(40));
  });
  await page.waitForFunction(() => {
    const active = document.querySelector('.log-line.latest.active-output .log-text');
    return active?.textContent.includes('First active transition probe');
  });
  await page.evaluate(async () => {
    const { addLog } = await import('/src/activity-log.js');
    addLog('Second active transition probe ' + 'beta '.repeat(180));
  });
  await page.waitForFunction(() => {
    const activeLines = Array.from(document.querySelectorAll('.log-line.latest.active-output'));
    const firstStillActive = Array.from(document.querySelectorAll('.log-line.active-output'))
      .some((line) => line.textContent.includes('First active transition probe'));
    const active = activeLines[0];
    return activeLines.length === 1 &&
      active?.classList.contains('typing') &&
      active.textContent.includes('Second active transition probe') &&
      !firstStillActive;
  }, null, { timeout: 8000 });
  assert.equal(await page.locator('.log-line.latest.active-output').count(), 1, 'only the newest printing ledger line should keep the active glow');
  assert.equal(await page.locator('.log-line.active-output').filter({ hasText: 'First active transition probe' }).count(), 0, 'previous active line should lose the glow as soon as the next line begins');

  const motionState = await page.evaluate(async () => {
    const activeText = document.querySelector('.log-line.latest.active-output .log-text');
    const before = getComputedStyle(activeText).backgroundPosition;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const style = getComputedStyle(activeText);
    const activeLine = document.querySelector('.log-line.latest.active-output');
    return {
      counts: {
        latest: document.querySelectorAll('.log-line.latest').length,
        activeOutput: document.querySelectorAll('.log-line.active-output').length,
        latestActiveOutput: document.querySelectorAll('.log-line.latest.active-output').length,
        dots: document.querySelectorAll('.log-dots').length,
      },
      vars: {
        ink: getComputedStyle(activeLine).getPropertyValue('--ledger-ink').trim(),
        soft: getComputedStyle(activeLine).getPropertyValue('--ledger-soft').trim(),
        hot: getComputedStyle(activeLine).getPropertyValue('--ledger-hot').trim(),
        glow: getComputedStyle(activeLine).getPropertyValue('--ledger-glow-rgb').trim(),
      },
      before,
      after: style.backgroundPosition,
      backgroundImage: style.backgroundImage,
      backgroundSize: style.backgroundSize,
      animationName: style.animationName,
      animationIterationCount: style.animationIterationCount,
      animations: activeText.getAnimations().map((animation) => ({
        name: animation.animationName || '',
        playState: animation.playState,
        currentTime: animation.currentTime,
        duration: animation.effect?.getTiming?.().duration ?? null,
      })),
      backgroundRepeat: style.backgroundRepeat,
      textShadow: style.textShadow,
      fillColor: style.webkitTextFillColor,
    };
  });
  assert.deepEqual(motionState.counts, {
    latest: 1,
    activeOutput: 1,
    latestActiveOutput: 1,
    dots: 1,
  }, 'active output should own exactly one latest marker, one glow marker, and one trailing dots marker');
  for (const [name, value] of Object.entries(motionState.vars)) {
    assert(value, `active glow should expose ${name} color variable`);
  }
  assert(motionState.backgroundImage.includes('linear-gradient'), 'active glow should use a visible text gradient');
  assert.equal(motionState.backgroundSize, '340% 100%', 'active glow should use the intended sweep width');
  assert(motionState.animationName.includes('activeReadGlow'), 'active output should run the glow sweep animation');
  assert(motionState.animationName.includes('activeReadBreath'), 'active output should run the subtle breathing animation');
  assert(motionState.animationIterationCount.includes('infinite'), 'active glow should loop continuously');
  assert(motionState.animations.some((animation) => animation.name === 'activeReadGlow' && animation.playState === 'running'), 'Web Animations API should report the active glow as running');
  assert(motionState.animations.some((animation) => animation.name === 'activeReadBreath' && animation.playState === 'running'), 'Web Animations API should report the active breath as running');
  assert.notEqual(motionState.before, motionState.after, 'active glow background position should keep moving while output is live');
  assert.equal(motionState.backgroundRepeat, 'no-repeat', 'active glow should sweep once across the text instead of tiling awkwardly');
  assert.notEqual(motionState.textShadow, 'none', 'active glow should include a category-colored neon shadow');
  assert(/transparent|rgba\(0, 0, 0, 0\)/i.test(motionState.fillColor), 'active glow should clip the gradient through transparent text fill');
  const activeKeyframes = await page.evaluate(() => {
    const names = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule.type === CSSRule.KEYFRAMES_RULE && /^activeRead(Glow|Breath)$/.test(rule.name)) {
          names.push(rule.name);
        }
      }
    }
    return names.sort();
  });
  assert.deepEqual(activeKeyframes, ['activeReadBreath', 'activeReadGlow'], 'active glow keyframes should be defined exactly once');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotionState = await page.evaluate(async () => {
    const { addLog } = await import('/src/activity-log.js');
    document.querySelector('#log-content')?.classList.remove('ledger-idle');
    addLog('[Read] reduced motion active probe', { immediate: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const activeText = document.querySelector('.log-line.latest.active-output .log-text');
    const style = getComputedStyle(activeText);
    return {
      activeOutput: document.querySelectorAll('.log-line.latest.active-output').length,
      backgroundImage: style.backgroundImage,
      animationName: style.animationName,
      textShadow: style.textShadow,
      animations: activeText.getAnimations().map((animation) => ({
        name: animation.animationName || '',
        playState: animation.playState,
      })),
    };
  });
  assert.equal(reducedMotionState.activeOutput, 1, 'reduced motion should preserve the semantic active-output marker');
  assert.equal(reducedMotionState.backgroundImage, 'none', 'reduced motion should disable the active glow gradient');
  assert.equal(reducedMotionState.animationName, 'none', 'reduced motion should disable active text animation');
  assert.equal(reducedMotionState.textShadow, 'none', 'reduced motion should disable active neon shadow');
  assert.equal(reducedMotionState.animations.length, 0, 'reduced motion should not leave active glow animations running');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const activeStyleProbes = await page.evaluate(async () => {
    const { addLog } = await import('/src/activity-log.js');
    const probes = [
      ['[Read] active color probe', true],
      ['[Bash] active color probe', true],
      ['[Agent] active color probe', true],
      ['[Write] active color probe', true],
      ['[WebFetch] active color probe', true],
      ['Stopped active color probe', true],
      ['vanquish active color probe', true],
      ['> user color probe', false],
      ['Queued prompt color probe', false],
      ['System color probe', false],
      ['ERROR color probe', false],
      ['[Complete]', false],
    ];
    const rows = [];
    for (const [text, expectedActive] of probes) {
      document.querySelector('#log-content')?.classList.remove('ledger-idle');
      addLog(text, { immediate: true });
      const latest = document.querySelector('.log-line.latest');
      rows.push({
        text,
        expectedActive,
        className: latest?.className || '',
        active: latest?.classList.contains('active-output') || false,
        ink: latest ? getComputedStyle(latest).getPropertyValue('--ledger-ink').trim() : '',
      });
    }
    return rows;
  });
  for (const row of activeStyleProbes) {
    assert.equal(row.active, row.expectedActive, `${row.text} active-output eligibility should match its semantic class`);
  }
  const activeInks = activeStyleProbes.filter((row) => row.active).map((row) => row.ink);
  assert(activeInks.length >= 6, 'active output probes should cover the main output classes');
  assert(new Set(activeInks).size >= 5, 'active read-glow should inherit category-specific colors across output classes');

  const cadence = await page.evaluate(async () => {
    const { __activityLogTestHooks } = await import('/src/activity-log.js');
    const batch = __activityLogTestHooks.typingTickBatchSize;
    const classify = __activityLogTestHooks.classify;
    return {
      base: batch(120, 0, 0),
      long: batch(600, 0, 0),
      veryLong: batch(1000, 0, 0),
      moderateBacklog: batch(120, 5, 800),
      heavyBacklog: batch(120, 9, 1800),
      charBacklog: batch(120, 2, 2600),
      floodBacklog: batch(120, 15, 6000),
      deliberateCompact: classify('Context compaction in progress'),
      compactLayoutText: classify('Use a compact layout for this CSS panel'),
    };
  });
  assert.deepEqual(cadence, {
    base: 1,
    long: 2,
    veryLong: 4,
    moderateBacklog: 5,
    heavyBacklog: 8,
    charBacklog: 8,
    floodBacklog: 12,
    deliberateCompact: 'compact',
    compactLayoutText: 'text',
  }, 'typing cadence should speed up predictably as line length or backlog pressure rises');
  await page.evaluate(async () => {
    const { hideLoadingIndicator, flushLogQueue } = await import('/src/activity-log.js');
    flushLogQueue();
    hideLoadingIndicator();
  });

  await setNarrationBusy(page, true);
  await submitPrompt(page, 'Narration must not block direct command');
  await waitForCalls(page, 2);
  await waitForUserLine(page, 'Narration must not block direct command');
  assert.equal(await queueCount(page), 0, 'background narration should not force normal prompts into the queue');
  assert.equal((await callTexts(page)).at(-1), 'Narration must not block direct command', 'background narration should not receive or steal the prompt');
  await resolveOldest(page, 'narration-safe complete');
  await setNarrationBusy(page, false);
  await waitForUiIdle(page);

  await page.evaluate(async () => {
    const { addLog } = await import('/src/activity-log.js');
    document.querySelector('#log-content')?.classList.remove('ledger-idle');
    for (let i = 0; i < 12; i += 1) {
      addLog(`Drain pressure probe ${i + 1} ${'rune '.repeat(24)}`);
    }
  });
  await waitForLog(page, /Drain pressure probe 12/, 'adaptive typewriter should drain a burst without manual flush', 7000);
  await page.evaluate(async () => {
    const { hideLoadingIndicator, flushLogQueue } = await import('/src/activity-log.js');
    flushLogQueue();
    hideLoadingIndicator();
  });

  await addSlowAgentLog(page);
  await submitPrompt(page, 'After backlog command');
  await waitForCalls(page, 3);
  await waitForUserLine(page, 'After backlog command');
  assert.equal(await queueCount(page), 0, 'idle submit during typewriter backlog should not become queued');

  await page.locator('#log-input').fill('Queued while busy');
  await page.locator('#log-input').press('Tab');
  await waitForQueueCount(page, 1);
  assert.equal(await page.locator('#prompt-queue-panel').isVisible(), true, 'queue panel should open only when queued prompts exist');
  assert.equal((await page.locator('#prompt-queue-steer').textContent()).trim(), 'Steer', 'busy queue action should steer the selected prompt');
  assert.equal((await callTexts(page)).length, 3, 'busy submit should wait in queue');
  assert.equal(await userLineCount(page, 'Queued while busy'), 0, 'queued text should not render as submitted user text');
  assert.equal(await queueStatusLeakCount(page, 'Queued while busy'), 0, 'queue status line should not leak queued prompt content');
  assert.equal(await genericQueueLogCount(page), 0, 'generic queue bookkeeping should stay out of the permanent ledger transcript');

  await page.locator('#log-input').fill('Queued through send button');
  await page.locator('#log-submit').click();
  await waitForQueueCount(page, 2);
  assert.deepEqual(await queueTexts(page), ['Queued while busy', 'Queued through send button'], 'send button should queue while the agent is busy');
  assert.equal(await genericQueueLogCount(page), 0, 'send-button queueing should not add generic queue bookkeeping to the ledger');

  await setSteerSupport(page, false);
  assert.equal(await page.locator('#prompt-queue-steer').isDisabled(), true, 'stale bridge without steering support should disable the steer action');
  assert.match(await page.locator('#prompt-queue-steer').getAttribute('title'), /Restart the Legends SEO Dungeon bridge/i, 'disabled steer action should explain the bridge restart requirement');
  await setSteerSupport(page, true);
  assert.equal(await page.locator('#prompt-queue-steer').isDisabled(), false, 'restored steering support should re-enable the steer action');

  await failNextSteer(page);
  await page.locator('.prompt-queue-item').first().click();
  await page.locator('#prompt-queue-steer').click();
  await page.waitForFunction(() => window.__dialogueHarness.failedSteers === 1);
  assert.deepEqual(await queueTexts(page), ['Queued while busy', 'Queued through send button'], 'failed steer should keep the queue order intact');
  assert.equal(await userLineCount(page, 'Queued while busy'), 0, 'failed steer should not render queued text as submitted user text');

  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.prompt-queue-item'));
    const data = new DataTransfer();
    rows[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
    rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    rows[1].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  });
  await page.waitForFunction(() => document.querySelector('.prompt-queue-text')?.textContent.includes('Queued through send button'));
  assert.deepEqual(await queueTexts(page), ['Queued through send button', 'Queued while busy'], 'dragging a queued prompt should reorder the queue');

  await page.locator('.prompt-queue-edit').first().click();
  await page.locator('#prompt-edit-text').waitFor({ state: 'visible' });
  await page.waitForTimeout(75);
  await page.locator('#prompt-edit-text').fill('Edited queued command');
  await page.locator('#prompt-edit-save').click();
  await page.waitForFunction(() => document.querySelector('.prompt-queue-text')?.textContent.includes('Edited queued command'));

  await page.locator('.prompt-queue-item').nth(1).locator('.prompt-queue-remove').click();
  await waitForQueueCount(page, 1);
  assert.deepEqual(await queueTexts(page), ['Edited queued command'], 'remove should drop the stale reordered row');

  await submitPrompt(page, 'Temporary queued prompt');
  await waitForQueueCount(page, 2);
  await page.locator('.prompt-queue-item').nth(1).locator('.prompt-queue-remove').click();
  await waitForQueueCount(page, 1);
  assert.deepEqual(await queueTexts(page), ['Edited queued command'], 'remove should only drop the targeted queued row');

  await page.locator('#log-stop').click();
  await page.waitForFunction(() => document.querySelector('#prompt-queue-title')?.textContent === 'Held');
  assert.equal((await page.locator('#prompt-queue-steer').textContent()).trim(), 'Send', 'held idle queue action should send the selected prompt');
  assert.equal((await callTexts(page)).length, 3, 'stop should not submit the held queue');
  await page.waitForTimeout(650);
  assert.equal((await callTexts(page)).length, 3, 'held queue should not auto-drain after stop');

  await submitPrompt(page, 'Manual direct after stop');
  await waitForCalls(page, 4);
  await waitForUserLine(page, 'Manual direct after stop');
  assert.deepEqual(await queueTexts(page), ['Edited queued command'], 'manual direct submit should leave held queued prompt alone');
  await resolveOldest(page, 'manual direct complete');
  await waitForUiIdle(page);
  assert.equal((await callTexts(page)).length, 4, 'held queue should not auto-drain after a later direct prompt completes');
  assert.deepEqual(await queueTexts(page), ['Edited queued command'], 'held queue should remain available after a later direct prompt completes');

  await submitPrompt(page, 'Second direct after held stop');
  await waitForCalls(page, 5);
  await page.waitForTimeout(650);
  const cancelsBeforeSingleEscape = (await cancelledIds(page)).length;
  await page.locator('#log-input').press('Escape');
  await page.waitForTimeout(120);
  assert.equal((await cancelledIds(page)).length, cancelsBeforeSingleEscape, 'single Escape in composer should not stop an active turn');
  const cancelsBeforeSteer = (await cancelledIds(page)).length;
  await page.locator('#prompt-queue-steer').click();
  await waitForSteers(page, 1);
  await waitForQueueCount(page, 0);
  await waitForUserLine(page, 'Edited queued command');
  assert.deepEqual(await steeredTexts(page), ['Edited queued command'], 'steer should inject the selected queued prompt');
  assert.equal((await callTexts(page)).length, 5, 'steer should not start a separate chat request');
  assert.equal((await cancelledIds(page)).length, cancelsBeforeSteer, 'steering while busy must not cancel the active request');

  await submitPrompt(page, 'Auto drain child');
  await waitForQueueCount(page, 1);
  await resolveOldest(page, 'steered complete');
  await waitForCalls(page, 6);
  assert.equal((await callTexts(page)).at(-1), 'Auto drain child', 'normal completion should auto-drain the next queued prompt');
  await waitForQueueCount(page, 0);
  await resolveOldest(page, 'child complete');
  await waitForUiIdle(page);

  await setConnected(page, false);
  await submitPrompt(page, 'Disconnected direct command');
  await waitForQueueCount(page, 1);
  assert.equal((await callTexts(page)).length, 6, 'disconnected submit should be preserved, not sent');
  assert.equal(await userLineCount(page, 'Disconnected direct command'), 0, 'disconnected preserved prompt should not render as submitted text');
  await setConnected(page, true);
  await waitForCalls(page, 7);
  assert.equal((await callTexts(page)).at(-1), 'Disconnected direct command', 'reconnect should drain preserved prompt');
  await waitForQueueCount(page, 0);
  await resolveOldest(page, 'disconnected complete');
  await waitForUiIdle(page);

  await setBusy(page, true);
  await submitPrompt(page, 'Queue item to clear');
  await waitForQueueCount(page, 1);
  await page.locator('#prompt-queue-clear').click();
  await waitForQueueCount(page, 0);
  assert.equal(await queueCount(page), 0, 'clear should remove all queued prompts');
  await setBusy(page, false);

  assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(' | ')}`);
  assert.equal(consoleErrors.length, 0, `console errors: ${consoleErrors.join(' | ')}`);

  console.log('Dialogue state tests passed');
} finally {
  if (browser) await browser.close();
  await stopServer();
}
