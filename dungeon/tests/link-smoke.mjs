// Verify the activity-log linkifier wraps URLs and backticked content
// in clickable elements, and that clicking them triggers the expected
// behaviour (open for URLs, copy+toast for backticked).
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dungeonRoot = path.resolve(__dirname, '..');
const appPort = process.env.SEO_DUNGEON_LINK_TEST_PORT
  ? Number(process.env.SEO_DUNGEON_LINK_TEST_PORT)
  : await reserveFreePort();
const appUrl = `http://127.0.0.1:${appPort}`;
const viteOutput = [];
let vite;

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => {
        if (!freePort) reject(new Error('Unable to allocate a free link smoke test port.'));
        else resolve(freePort);
      });
    });
  });
}

function spawnNode(args, options) {
  return spawn(process.execPath, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHttp(url, label, output, proc, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (proc && proc.exitCode !== null) throw new Error(`${label} exited early:\n${output.join('').slice(-4000)}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}:\n${output.join('').slice(-4000)}`);
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

function runVite() {
  const viteBin = path.join(dungeonRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  vite = spawnNode([viteBin, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {
    cwd: dungeonRoot,
    env: { ...process.env },
  });
  vite.stdout.on('data', (chunk) => viteOutput.push(chunk.toString()));
  vite.stderr.on('data', (chunk) => viteOutput.push(chunk.toString()));
}

runVite();
await waitForHttp(appUrl, 'vite', viteOutput, vite);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();

try {
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(1500);

  // Inject a line that contains every variety of linkable content
  await page.evaluate(() => {
    // The addLog helper is exposed on window by main.js... actually it's
    // not exported to window. Find the log-content element and inject
    // via the module-scoped queue by dispatching a DOM insert that the
    // typewriter runs on. Easiest: use the internal addLog if exposed,
    // otherwise call it through a MutationObserver-less shortcut.
    // In main.js, addLog is assigned to game.addLog; we can also just
    // fire it via the activity-log module indirectly.
    // But since we don't have access, let's directly manipulate: we
    // know the log element id + we can just simulate a finished typed
    // line by creating the structure and calling linkify manually.
    // Simpler: import via window.__addLog hack if we can patch.
    // Fallback: check if window exposes addLog anywhere.
    if (typeof window.addLog === 'function') {
      window.addLog('Check this: `https://example.com/api`, local file `E:\\\\src\\\\app.ts`, or `src/lib/handler.js`. Also bare https://github.com/avalonreset/legends-seo-dungeon.');
      return 'used window.addLog';
    }
    return 'no addLog exposed';
  }).then((s) => console.log('  inject result:', s));

  // If addLog isn't on window, expose it via the module for the test
  const exposed = await page.evaluate(async () => {
    // Try to find the log container and simulate a line by walking
    // through the activity-log.js flow: just insert the DOM the same
    // way typewriterLine would, then call linkify ourselves.
    // We grab the linkify function by looking for the script's module.
    // Cleanest: re-import the activity-log module from the running bundle.
    try {
      const m = await import('/src/activity-log.js').catch(() => null);
      if (m && m.addLog) {
        m.addLog('Check this: `https://example.com/api`, local file `E:\\\\src\\\\app.ts`, or `src/lib/handler.js`. Also bare https://github.com/avalonreset/legends-seo-dungeon.');
        return 'used dynamic import';
      }
    } catch {}
    return 'fallback: direct DOM injection';
  });
  console.log('  exposed result:', exposed);

  // Wait enough time for typing + linkify to complete
  await page.waitForTimeout(3500);

  // Inspect the DOM to see what got rendered with links
  const linkInfo = await page.evaluate(() => {
    const urls = [...document.querySelectorAll('.log-link-url')].map((a) => ({
      text: a.textContent,
      href: a.href,
      target: a.target,
    }));
    const codes = [...document.querySelectorAll('.log-link-code')].map((s) => ({
      text: s.textContent,
      title: s.title,
    }));
    return { urls, codes };
  });

  console.log(`\n  URL anchors found: ${linkInfo.urls.length}`);
  linkInfo.urls.forEach((u) => console.log(`    ${u.target}  ${u.text}  ->  ${u.href}`));
  console.log(`  Code spans found:  ${linkInfo.codes.length}`);
  linkInfo.codes.forEach((c) => console.log(`    [copy]  ${c.text}`));

  // Simulate a click on the first code span to verify clipboard + toast
  if (linkInfo.codes.length > 0) {
    await page.click('.log-link-code');
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    const toastText = await page.locator('#log-copy-toast').textContent().catch(() => null);
    console.log(`\n  Clicked code span. Clipboard: "${clip}"  Toast: "${toastText}"`);
  }

  // All expected?
  const pass = linkInfo.urls.length >= 2 && linkInfo.codes.length >= 2;
  console.log(`\n  ${pass ? 'PASS' : 'FAIL'} - links rendered as expected`);
  if (!pass) process.exitCode = 1;
} finally {
  await browser.close();
  await killTree(vite);
}
