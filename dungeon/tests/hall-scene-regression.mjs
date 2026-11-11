import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dungeonRoot = path.resolve(__dirname, '..');
const port = await resolveTestPort();
const baseUrl = `http://127.0.0.1:${port}/`;
const domain = 'regression.test';
const projectPath = 'E:\\seo-dungeon-regression-fixture';
const cacheKey = `seo_dungeon_audit_${domain}_codex_deep`;
const auditData = buildAuditData();

let server;
let browser;
const serverOutput = [];

async function resolveTestPort() {
  if (process.env.SEO_DUNGEON_HALL_TEST_PORT) {
    return Number(process.env.SEO_DUNGEON_HALL_TEST_PORT);
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => {
        if (!freePort) reject(new Error('Unable to allocate a free Vite test port.'));
        else resolve(freePort);
      });
    });
  });
}

function buildAuditData() {
  const severities = ['critical', 'high', 'medium', 'low', 'info'];
  const issues = Array.from({ length: 12 }, (_, index) => {
    const severity = severities[index % severities.length];
    return {
      id: `hall-regression-${index + 1}`,
      title: `Regression demon ${index + 1} covers a long hall row`,
      description: `Fixture issue ${index + 1} has enough body copy to keep row geometry realistic for masked hit testing.`,
      severity,
      category: index % 2 === 0 ? 'technical' : 'content',
      hp: 45 + index,
    };
  });

  return {
    domain,
    score: 64,
    summary: 'DungeonHall regression fixture',
    issues,
  };
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
  if (!server || server.killed || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }
  server.kill('SIGTERM');
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
    await new Promise((resolve) => setTimeout(resolve, 150));
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
    bridge.openFolder = (projectPath) => Promise.resolve({ data: { action: 'opened', path: projectPath } });
    bridge._setConnected(true);
  });
}

async function enterCachedHall(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#domain-input');
  await page.waitForFunction(() => window.__seoDungeonDialogueReady === true);
  await installBridgeHarness(page);

  await page.locator('#domain-input').fill(domain);
  await page.locator('#path-input').fill(projectPath);

  if (await page.locator('#danger-mode-toggle').getAttribute('aria-pressed') !== 'true') {
    await page.locator('#danger-mode-toggle').click();
  }

  await page.evaluate(async () => {
    const { bridge } = await import('/src/utils/ws.js');
    bridge._setConnected(true);
  });
  await page.waitForFunction(() => !document.querySelector('#descend-btn')?.disabled, null, { timeout: 5000 }).catch(async (err) => {
    const state = await page.evaluate(async () => {
      const { bridge } = await import('/src/utils/ws.js');
      return {
        disabled: document.querySelector('#descend-btn')?.disabled,
        domain: document.querySelector('#domain-input')?.value,
        path: document.querySelector('#path-input')?.value,
        dangerPressed: document.querySelector('#danger-mode-toggle')?.getAttribute('aria-pressed'),
        dangerousBypass: window.seoDungeonDangerousBypass === true,
        bridgeConnected: bridge.connected,
        bridgeStatus: document.querySelector('#bridge-status')?.textContent,
        validation: document.querySelector('#validation-errors')?.textContent,
      };
    });
    throw new Error(`Descend button did not enable: ${JSON.stringify(state)}\n${err.message}`);
  });
  await page.locator('#descend-btn').click();
  await page.locator('#gate-overlay [data-action="resume"]').waitFor({ timeout: 25000 });
  await page.locator('#gate-overlay [data-action="resume"]').click();
  await waitForHall(page);
}

async function waitForHall(page) {
  await page.waitForFunction(() => {
    const game = window.__seoDungeonGame;
    return Boolean(
      game &&
      game.scene?.isActive('DungeonHall') &&
      window.__seoDungeonHallScene &&
      window.__seoDungeonHallState?.().maxScroll > 0
    );
  }, null, { timeout: 25000 });
}

async function hallTexts(page) {
  return page.evaluate(() => {
    const scene = window.__seoDungeonHallScene;
    return scene.children.list
      .filter((child) => child.type === 'Text')
      .map((child) => child.text);
  });
}

async function canvasPoint(page, worldX, worldY) {
  const box = await page.locator('#game-container canvas').boundingBox();
  assert(box, 'hall canvas should have a bounding box');
  return {
    x: box.x + (box.width * worldX / 800),
    y: box.y + (box.height * worldY / 600),
  };
}

async function clickWorld(page, worldX, worldY) {
  const point = await canvasPoint(page, worldX, worldY);
  await page.mouse.click(point.x, point.y);
}

async function wheelHall(page, deltaY) {
  const point = await canvasPoint(page, 400, 320);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, deltaY);
}

async function setRowCenterAt(page, targetY, preferredIndex = 0) {
  return page.evaluate(({ targetY, preferredIndex }) => {
    const scene = window.__seoDungeonHallScene;
    const rowCount = scene.demonRowYs.length;
    let best = null;

    for (let i = 0; i < rowCount; i += 1) {
      const center = scene.demonRowYs[i] + scene.demonRowHeights[i] / 2;
      const maxScroll = scene.maxHallScroll();
      const offset = Math.max(-maxScroll, Math.min(0, targetY - center));
      const visualCenter = center + offset;
      const distance = Math.abs(visualCenter - targetY);
      const candidate = { index: i, offset, visualCenter, distance };
      if (!best || distance < best.distance || (i === preferredIndex && distance <= best.distance + 2)) {
        best = candidate;
      }
    }

    scene.scrollVelocity = 0;
    scene.scrollOffset = best.offset;
    scene.targetScrollOffset = best.offset;
    if (scene.demonContainer) scene.demonContainer.y = best.offset;
    scene.saveHallScrollOffset();

    return {
      index: best.index,
      offset: best.offset,
      visualCenter: best.visualCenter,
      maxScroll: scene.maxHallScroll(),
    };
  }, { targetY, preferredIndex });
}

async function assertCoveredClickDoesNotEnterBattle(page, label, worldY, preferredIndex) {
  const placement = await setRowCenterAt(page, worldY, preferredIndex);
  assert(Math.abs(placement.visualCenter - worldY) <= 2, `${label} row should be centered under covered chrome`);

  await clickWorld(page, 400, worldY);
  await page.waitForTimeout(1400);

  const state = await page.evaluate(() => ({
    hallActive: window.__seoDungeonGame?.scene?.isActive('DungeonHall') || false,
    battleActive: window.__seoDungeonGame?.scene?.isActive('Battle') || false,
  }));
  assert.deepEqual(state, { hallActive: true, battleActive: false }, `${label} covered row click should not start Battle`);
}

async function assertScrollPersistsAcrossRestartAndResume(page) {
  await wheelHall(page, 520);
  await page.waitForFunction(() => window.__seoDungeonHallState?.().targetScrollOffset < -80, null, { timeout: 5000 });

  const saved = await page.evaluate(() => {
    const state = window.__seoDungeonHallState();
    return {
      offset: Math.round(state.targetScrollOffset),
      storageKey: state.storageKey,
      storageValue: Number(localStorage.getItem(state.storageKey)),
    };
  });
  assert.equal(saved.storageValue, saved.offset, 'wheel scroll should save the hall offset to localStorage');

  await page.evaluate((offset) => {
    window.__expectedHallOffset = offset;
    window.__hallRestartCreateCount = 0;
    const scene = window.__seoDungeonHallScene;
    const originalCreate = scene.create;
    scene.create = function patchedCreate(...args) {
      window.__hallRestartCreateCount += 1;
      scene.create = originalCreate;
      return originalCreate.apply(this, args);
    };
    scene.scene.restart();
  }, saved.offset);
  await page.waitForFunction(() => (
    window.__seoDungeonHallScene &&
    window.__hallRestartCreateCount >= 1 &&
    Math.abs(Math.round(window.__seoDungeonHallState().targetScrollOffset) - window.__expectedHallOffset) <= 1
  ), null, { timeout: 8000 });

  const afterRestart = await page.evaluate(() => Math.round(window.__seoDungeonHallState().targetScrollOffset));
  assert(Math.abs(afterRestart - saved.offset) <= 1, `restart should restore saved hall offset (${afterRestart} vs ${saved.offset})`);

  await page.evaluate(() => {
    const scene = window.__seoDungeonHallScene;
    scene.saveHallScrollOffset();
    scene.scene.start('Battle', { issue: scene.game.auditData.issues[0] });
  });
  await page.waitForFunction(() => window.__seoDungeonGame?.scene?.isActive('Battle'), null, { timeout: 8000 });
  await page.evaluate(() => {
    window.__seoDungeonGame.scene.getScene('Battle').scene.start('DungeonHall');
  });
  await waitForHall(page);

  const afterResume = await page.evaluate(() => Math.round(window.__seoDungeonHallState().targetScrollOffset));
  assert(Math.abs(afterResume - saved.offset) <= 1, `resume should restore saved hall offset (${afterResume} vs ${saved.offset})`);
}

runServer();

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  await context.route('https://regression.test/**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>opened</title>' });
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && !/ws:\/\/127\.0\.0\.1:3003|favicon|manifest\.webmanifest/i.test(text)) {
      pageErrors.push(text);
    }
  });

  await page.addInitScript(({ domain, projectPath, cacheKey, auditData }) => {
    localStorage.clear();
    window.seoDungeonDangerousBypass = true;
    localStorage.setItem('sfx_volume', '0');
    localStorage.setItem('seo_dungeon_runtime', 'codex');
    localStorage.setItem('seo_dungeon_last_domain', domain);
    localStorage.setItem('seo_dungeon_last_path', projectPath);
    localStorage.setItem(cacheKey, JSON.stringify({
      domain,
      runtime: 'codex',
      profile: 'deep',
      model: 'deep',
      auditData,
      timestamp: Date.now(),
    }));
  }, { domain, projectPath, cacheKey, auditData });

  await enterCachedHall(page);

  const texts = await hallTexts(page);
  assert(texts.includes('ORIGINAL SEO SCORE'), 'DungeonHall should label the cached score as ORIGINAL SEO SCORE');
  assert(texts.includes('64/100'), 'DungeonHall should render the original score value');

  const popupPromise = page.waitForEvent('popup', { timeout: 6000 });
  await clickWorld(page, 400, 42);
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  assert.equal(popup.url(), 'https://regression.test/', 'clicking the hall domain should open the normalized site in a new tab');
  await popup.close();

  await assertScrollPersistsAcrossRestartAndResume(page);
  await assertCoveredClickDoesNotEnterBattle(page, 'header mask', 78, 0);
  await assertCoveredClickDoesNotEnterBattle(page, 'footer mask', 540, 6);

  assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join('\n')}`);
  await context.close();

  console.log('DungeonHall regression tests passed');
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
}
