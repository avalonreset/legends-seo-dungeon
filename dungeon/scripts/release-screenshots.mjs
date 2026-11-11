// Generate product screenshots from fictional local fixtures. No AI or site calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '..', 'screenshots');
fs.mkdirSync(output, { recursive: true });
const reservePort = () => new Promise(resolve => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});
const port = await reservePort();
const bridgePort = await reservePort();
const bridgeServer = spawn(process.execPath, ['server/index.js'], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, SEO_DUNGEON_BRIDGE_PORT: String(bridgePort), SEO_DUNGEON_BRIDGE_STRICT_PORT: '1', SEO_DUNGEON_ALLOWED_ORIGINS: `http://127.0.0.1:${port}` },
});
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, SEO_DUNGEON_BRIDGE_PORT: String(bridgePort) },
});
let browser;
try {
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Screenshot fixture server must start');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(bridgePort => {
    localStorage.clear(); localStorage.setItem('sfx_volume', '0');
    window.SEO_DUNGEON_BRIDGE_URL = `ws://127.0.0.1:${bridgePort}`;
  }, bridgePort);
  await page.goto(url);
  await page.waitForFunction(() => window.__seoDungeonDialogueReady === true);
  assert.equal(await page.locator('#domain-input').inputValue(), '');
  assert.equal(await page.locator('#path-input').inputValue(), '');
  assert.equal(await page.locator('.runtime-option').count(), 4);
  await page.evaluate(async () => {
    const { bridge } = await import('/src/utils/ws.js');
    bridge.audit = () => new Promise(() => {});
    bridge.publishSessionEvent = async () => ({});
    const issues = [
      { id: 'demo-1', title: 'Missing page descriptions', description: 'Fictional demo: add useful descriptions to help visitors choose a page in search results.', severity: 'critical', category: 'content', hp: 90 },
      { id: 'demo-2', title: 'Images need descriptive alternative text', description: 'Fictional demo: explain meaningful images for accessibility and search.', severity: 'high', category: 'technical', hp: 70 },
      { id: 'demo-3', title: 'Improve internal links', description: 'Fictional demo: connect related pages with clear anchor text.', severity: 'medium', category: 'content', hp: 45 },
    ];
    localStorage.setItem('seo_dungeon_audit_example.com_grok_deep', JSON.stringify({
      domain: 'example.com', runtime: 'grok', profile: 'deep', timestamp: Date.now(),
      auditData: { domain: 'example.com', score: 68, summary: 'Fictional demonstration data', issues },
    }));
  });
  await page.waitForFunction(() => document.querySelector('#bridge-status')?.classList.contains('connected'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(output, 'title-screen.png') });
  await page.locator('.runtime-option[data-runtime="grok"]').click();
  await page.locator('#domain-input').fill('example.com');
  await page.locator('#path-input').fill('/projects/example-site');
  await page.evaluate(async () => {
    const { bridge } = await import('/src/utils/ws.js');
    bridge._clearReconnect?.(); bridge._setConnected(true);
  });
  assert.equal(await page.locator('#danger-mode-toggle').isVisible(), false);
  await page.locator('#descend-btn').click();
  await page.locator('#gate-overlay [data-action="resume"]').waitFor({ timeout: 25000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(output, 'gate-scene-full.png') });
  await page.locator('#gate-overlay [data-action="resume"]').click();
  await page.waitForFunction(() => window.__seoDungeonGame?.scene.isActive('DungeonHall'));
  await page.waitForFunction(() => !window.__seoDungeonGame.scene.getScene('DungeonHall').cameras.main.fadeEffect.isRunning, null, { timeout: 60000 });
  await page.screenshot({ path: path.join(output, 'dungeon-hall.png') });
  await page.evaluate(() => {
    const game = window.__seoDungeonGame;
    game.scene.getScene('DungeonHall').scene.start('Battle', { issue: game.auditData.issues[0] });
  });
  await page.waitForFunction(() => window.__seoDungeonGame?.scene.isActive('Battle'));
  await page.waitForFunction(() => window.__seoDungeonGame.scene.getScene('Battle').demon.alpha >= 0.99, null, { timeout: 60000 });
  await page.screenshot({ path: path.join(output, 'battle-scene.png') });
  await page.evaluate(() => {
    window.__seoDungeonGame.scene.getScene('Battle').scene.start('Summoning', { domain: 'example.com', projectPath: '/projects/example-site' });
  });
  await page.waitForFunction(() => window.__seoDungeonGame?.scene.isActive('Summoning'));
  await page.waitForFunction(() => !window.__seoDungeonGame.scene.getScene('Summoning').cameras.main.fadeEffect.isRunning, null, { timeout: 60000 });
  await page.screenshot({ path: path.join(output, 'summoning-scene.png') });
  assert.deepEqual(errors, []);
  console.log('Five fictional screenshots generated; blank first launch and four-runtime picker verified.');
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill();
  if (bridgeServer.exitCode === null) bridgeServer.kill();
}
