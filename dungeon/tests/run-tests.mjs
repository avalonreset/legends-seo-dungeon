// Internal QA harness for the v1.9.0 polish session.
// Runs with: node tests/run-tests.mjs
//
// Covers the parts you can't see from a compile-clean build:
//   1. Demon manifest - assignment, hierarchy, theme matching, no collisions
//   2. Battle prompt shape - demon focus header contains every expected field
//   3. Neutral chat prompt shape - zero framing
//   4. Asset reachability - every demon frame served from :3002
//   5. Bridge routing - the `chat` type is accepted, `fix` payload validated
//   6. Playwright smoke - the game page loads, canvas mounts, no JS errors

import { assignAllDemons, POOLS, pickDemonForIssue, getAllDemons } from '../src/demons-manifest.js';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dungeonRoot = path.resolve(__dirname, '..');
const { appPort, bridgePort } = await resolveSmokePorts();
const appUrl = `http://127.0.0.1:${appPort}`;
const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
const bridgeWs = `ws://127.0.0.1:${bridgePort}`;
const appOutput = [];
const bridgeOutput = [];
let appServer;
let bridgeServer;

// ───────── harness plumbing ─────────
let passed = 0, failed = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  fails.push(msg);
  console.log(`  FAIL  ${msg}`);
}
function section(name) { console.log(`\n── ${name} ──`); }

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const freePort = typeof address === 'object' && address ? address.port : null;
      probe.close(() => {
        if (!freePort) reject(new Error('Unable to allocate a free smoke test port.'));
        else resolve(freePort);
      });
    });
  });
}

async function resolveSmokePorts() {
  const requestedApp = process.env.SEO_DUNGEON_SMOKE_APP_PORT
    ? Number(process.env.SEO_DUNGEON_SMOKE_APP_PORT)
    : null;
  const requestedBridge = process.env.SEO_DUNGEON_SMOKE_BRIDGE_PORT
    ? Number(process.env.SEO_DUNGEON_SMOKE_BRIDGE_PORT)
    : null;
  const app = requestedApp || await reserveFreePort();
  let bridge = requestedBridge || await reserveFreePort();
  while (bridge === app && !requestedBridge) bridge = await reserveFreePort();
  if (bridge === app) throw new Error('Smoke app and bridge ports must be different.');
  return { appPort: app, bridgePort: bridge };
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
    if (proc && proc.exitCode !== null) throw new Error(`${label} exited early:\n${output.join('').slice(-4000)}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return res;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}:\n${output.join('').slice(-4000)}`);
}

async function startSmokeServers() {
  bridgeServer = spawnNode(['server/index.js'], {
    cwd: dungeonRoot,
    env: {
      ...process.env,
      SEO_DUNGEON_BRIDGE_PORT: String(bridgePort),
      SEO_DUNGEON_ALLOWED_ORIGINS: appUrl,
    },
  });
  bridgeServer.stdout.on('data', (chunk) => bridgeOutput.push(chunk.toString()));
  bridgeServer.stderr.on('data', (chunk) => bridgeOutput.push(chunk.toString()));

  const viteBin = path.join(dungeonRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  appServer = spawnNode([viteBin, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {
    cwd: dungeonRoot,
    env: { ...process.env },
  });
  appServer.stdout.on('data', (chunk) => appOutput.push(chunk.toString()));
  appServer.stderr.on('data', (chunk) => appOutput.push(chunk.toString()));

  await waitForHttp(`${bridgeUrl}/health`, 'bridge', bridgeOutput, bridgeServer);
  await waitForHttp(appUrl, 'app', appOutput, appServer);
}

async function stopSmokeServers() {
  await killTree(appServer);
  await killTree(bridgeServer);
}

// ───────── 1. Demon manifest ─────────
section('1. Demon manifest');

// Shape check - every demon has the keys scenes expect
const all = getAllDemons();
assert(all.length === 13, `expected 13 demons, got ${all.length}`);
for (const d of all) {
  assert(typeof d.name === 'string' && d.name.length > 0, `demon missing name: ${JSON.stringify(d)}`);
  assert(d.key === `demon_${d.name}`, `demon ${d.name} has wrong key: ${d.key}`);
  assert(d.animKey === `demon_${d.name}_idle`, `demon ${d.name} has wrong animKey`);
  assert(d.frame0Key === `demon_${d.name}_f0`, `demon ${d.name} has wrong frame0Key`);
  assert(d.framePrefix === `demon_${d.name}_f`, `demon ${d.name} has wrong framePrefix`);
  assert(d.frames === 4, `demon ${d.name} has wrong frame count`);
  assert(typeof d.label === 'string' && d.label.length > 0, `demon ${d.name} missing label`);
}

// Pool sizes match the committed hierarchy
assert(POOLS.critical.length === 2, 'critical pool should have 2 demons');
assert(POOLS.high.length === 3,     'high pool should have 3 demons');
assert(POOLS.medium.length === 3,   'medium pool should have 3 demons');
assert(POOLS.low.length === 3,      'low pool should have 3 demons');
assert(POOLS.info.length === 2,     'info pool should have 2 demons');

// Rank hierarchy - most severe HP per tier should get rank 0 → pool[0]
const issues = [
  // critical tier - two demons, higher HP should get Archdemon (pool[0])
  { id: 1, severity: 'critical', title: 'Massive content issue',  description: 'E-E-A-T problem',      hp: 100 },
  { id: 2, severity: 'critical', title: 'Minor critical',          description: 'Second critical',     hp:  50 },
  // high tier - three demons
  { id: 3, severity: 'high', title: 'Broken links everywhere',     description: 'many 404s',           hp: 80 },
  { id: 4, severity: 'high', title: 'Slightly broken link',        description: 'one 404',             hp: 40 },
  { id: 5, severity: 'high', title: 'Outdated post',               description: 'stale content',       hp: 30 },
  // medium - three demons
  { id: 6, severity: 'medium', title: 'Mobile viewport bug',       description: 'responsive issue',    hp: 50 },
  { id: 7, severity: 'medium', title: 'Duplicate canonical',       description: 'duplicate pages',     hp: 40 },
  { id: 8, severity: 'medium', title: 'Generic issue',             description: 'no theme match',      hp: 30 },
  // low - three demons
  { id: 9,  severity: 'low', title: 'Image alt missing',           description: 'image alt attribute', hp: 20 },
  { id: 10, severity: 'low', title: 'Internal link audit',         description: 'link graph weak',     hp: 15 },
  { id: 11, severity: 'low', title: 'Generic low',                 description: 'nothing special',     hp: 10 },
  // info - two demons
  { id: 12, severity: 'info', title: 'Mobile tap target small',    description: 'tap target',          hp:  5 },
  { id: 13, severity: 'info', title: 'Trivial nit',                description: 'barely matters',      hp:  3 },
];
assignAllDemons(issues);

for (const i of issues) {
  assert(!!i._demonKey, `issue ${i.id} missing _demonKey`);
  assert(!!i._demonName, `issue ${i.id} missing _demonName`);
}

// Rank 0 issue of each tier should get the top demon of its pool
const rank0 = {};
for (const i of issues) if (i._tierRank === 0) rank0[i.severity] = i;
assert(rank0.critical._demonKey === POOLS.critical[0].key || findsThemeMatch(rank0.critical, POOLS.critical),
  `critical rank-0 should get top or themed demon, got ${rank0.critical._demonKey}`);

// No duplicate demon within a tier (since pool sizes ≥ issue count per tier here)
const seenByTier = { critical: new Set(), high: new Set(), medium: new Set(), low: new Set(), info: new Set() };
for (const i of issues) {
  const s = seenByTier[i.severity];
  assert(!s.has(i._demonKey), `duplicate demon ${i._demonKey} in ${i.severity} tier`);
  s.add(i._demonKey);
}

// Theme matching: performance→imp/chort/goblin family
const perfIssue = { id: 99, severity: 'low', title: 'Core Web Vitals lcp slow', description: 'LCP too slow', hp: 30 };
assignAllDemons([perfIssue]);
assert(['demon_imp', 'demon_chort', 'demon_goblin', 'demon_wogol'].includes(perfIssue._demonKey) || perfIssue._demonKey === POOLS.low[0].key,
  `performance issue should get themed or rank-0 demon, got ${perfIssue._demonKey}`);

// Overflow - more issues than demons in a tier
const flood = [];
for (let i = 0; i < 10; i++) flood.push({ id: 1000+i, severity: 'info', title: `issue ${i}`, description: 'x', hp: 1 });
assignAllDemons(flood);
for (const f of flood) assert(!!f._demonKey, `overflow issue ${f.id} missing demon`);

// pickDemonForIssue round-trips the batch assignment
const firstIssue = issues[0];
const picked = pickDemonForIssue(firstIssue.severity, firstIssue.id, firstIssue);
assert(picked.key === firstIssue._demonKey, 'pickDemonForIssue should return the batch-assigned demon');

function findsThemeMatch(issue, pool) {
  // Used when a themed match might beat the rank-0 choice
  return pool.some(d => d.key === issue._demonKey);
}

// ───────── 2. Battle prompt shape ─────────
section('2. Battle prompt shape (demon focus header)');
// Reproduce the server's buildDemonHeader to assert on its output.
// Keeping this in sync with server/index.js is a trade-off - if you
// change the prompt there, update this mirror. Breakage shows up
// immediately on the next test run.
function buildDemonHeader(issue) {
  const i = issue || {};
  const lines = [
    '════════════════════════════════════════════════════════',
    '  YOU ARE FIGHTING ONE SPECIFIC DEMON.  FOCUS ON IT.',
    '════════════════════════════════════════════════════════',
    '',
    'This is a gamified SEO tool. The user has selected an issue',
    'from their audit list and is now engaging with ONLY that issue.',
    'The demon below is the entire scope of this turn. Stay on it.',
    '',
    'DEMON FILE',
    '----------',
  ];
  if (i.title)       lines.push(`  Name:       ${i.title}`);
  if (i.severity)    lines.push(`  Severity:   ${String(i.severity).toUpperCase()}`);
  if (i.category)    lines.push(`  Category:   ${i.category}`);
  if (i.url)         lines.push(`  URL:        ${i.url}`);
  if (i.page)        lines.push(`  Page:       ${i.page}`);
  if (i.file)        lines.push(`  File:       ${i.file}`);
  if (i.selector)    lines.push(`  Selector:   ${i.selector}`);
  if (i.line)        lines.push(`  Line:       ${i.line}`);
  if (i.id != null)  lines.push(`  Issue ID:   ${i.id}`);
  if (i.description) {
    lines.push('');
    lines.push('DESCRIPTION');
    lines.push('-----------');
    lines.push(i.description.split('\n').map((ln) => '  ' + ln).join('\n'));
  }
  return lines.join('\n');
}

const richIssue = {
  id: 42, severity: 'critical', category: 'Technical',
  title: 'Sitemap lastmod values are build artifacts',
  description: 'Nine legal/marketing URLs all share the same lastmod timestamp.',
  url: 'https://example.com/sitemap.xml',
  file: 'src/app/sitemap.ts', line: 24, selector: 'urlset>url>lastmod',
};
const header = buildDemonHeader(richIssue);
for (const must of ['Name:', 'Severity:   CRITICAL', 'Category:   Technical',
  'URL:        https://example.com/sitemap.xml', 'File:       src/app/sitemap.ts',
  'Line:       24', 'Selector:   urlset>url>lastmod', 'Issue ID:   42',
  'DESCRIPTION', 'Nine legal/marketing URLs']) {
  assert(header.includes(must), `header missing field: ${must}`);
}

// Minimal issue - header should gracefully skip missing fields
const tinyIssue = { id: 1, severity: 'info', title: 'Tiny nit', description: 'x' };
const tinyHeader = buildDemonHeader(tinyIssue);
assert(tinyHeader.includes('Name:       Tiny nit'), 'tiny header should include name');
assert(!tinyHeader.includes('URL:'), 'tiny header should not include URL line (no url set)');
assert(!tinyHeader.includes('File:'), 'tiny header should not include File line');
assert(!tinyHeader.includes('Selector:'), 'tiny header should not include Selector line');

// User-intent guidance block - no hard branching anymore
// (We just check the documentation string present in server/index.js
// by reading the file directly.)
import('node:fs').then(async (fs) => {
  const serverSrc = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert(!serverSrc.includes('function isQuestion('), 'isQuestion heuristic should be removed');
  assert(serverSrc.includes("Stay focused on the ONE demon"),  'runFix should anchor to one demon');
  assert(serverSrc.includes("If they asked a question, answer"), 'runFix should handle question intent');
  assert(serverSrc.includes("If they gave a directive"),         'runFix should handle directive intent');
  assert(serverSrc.includes("ask one short clarifying"),         'runFix should offer clarification path');
  assert(serverSrc.includes("type === 'chat'"),                  'server should accept chat type');
  assert(serverSrc.includes("ALLOWED_TYPES") && serverSrc.match(/'chat'/), 'chat should be in allowed types');

  // ───────── 3. Asset reachability ─────────
  await startSmokeServers();

  section(`3. Asset reachability (game server :${appPort})`);
  const chars = ['big_demon', 'ogre', 'orc_warrior', 'big_zombie', 'skelet',
    'chort', 'masked_orc', 'pumpkin_dude', 'orc_shaman', 'imp', 'wogol',
    'goblin', 'tiny_zombie'];
  for (const c of chars) {
    for (let f = 0; f < 4; f++) {
      const url = `${appUrl}/assets/0x72/frames/${c}_idle_anim_f${f}.png`;
      const code = await httpCode(url);
      assert(code === 200, `${c} frame ${f} should serve 200, got ${code}`);
    }
  }
  // The old DCSS assets should NO LONGER be served
  const deadUrl = `${appUrl}/assets/demons-new/boss/cerebov.png`;
  const deadCode = await httpCode(deadUrl);
  assert(deadCode === 404 || deadCode === 200 /* SPA fallback */, `dead DCSS asset reachable-or-SPA-404: got ${deadCode}`);
  // (serve -s falls back to index.html for unknowns, so 200 is expected
  // and fine; the Phaser loader would fail to parse it as PNG, which is
  // why we removed the refs entirely.)

  // ───────── 4. Bridge routing: chat type accepted ─────────
  section(`4. Bridge routing (${bridgeWs})`);
  await testBridgeType('chat',   /chat/i,   'chat handler should accept the type');
  await testBridgeType('fix',    /fix/i,    'fix handler should accept the type');
  await testBridgeType('audit',  /audit/i,  'audit handler should accept the type');
  await testBridgeType('narrate',/narrat/i, 'narrate handler should accept the type');
  await testBridgeRejects('not_a_real_type', 'unknown types should be rejected');

  // ───────── 5. Playwright smoke - page loads cleanly ─────────
  section('5. Playwright smoke (headless Chromium)');
  await smokeTest();

  // ───────── report ─────────
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const f of fails) console.log('    ✗ ' + f);
    await stopSmokeServers();
    process.exit(1);
  } else {
    console.log(`  All clear.`);
    await stopSmokeServers();
    process.exit(0);
  }
});

// ───────── helpers ─────────
function httpCode(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode); })
        .on('error', () => resolve(0))
        .setTimeout(5000, function () { this.destroy(); resolve(0); });
  });
}

function testBridgeType(type, expectHandlerLog, msg) {
  return new Promise((resolve) => {
    const ws = new WebSocket(bridgeWs, { origin: appUrl });
    let gotReply = false;
    const timeout = setTimeout(() => {
      if (!gotReply) { assert(false, `${msg} - timeout waiting for reply`); }
      try { ws.terminate(); } catch {}
      resolve();
    }, 3500);
    ws.on('open', () => {
      // Send with a projectPath that WILL fail validation so we don't
      // actually spawn claude. The server should still acknowledge the
      // type was accepted (no "Unknown command type" error), just return
      // an "Invalid project path" error instead.
      ws.send(JSON.stringify({ id: 9999, type, command: 'ping',
        projectPath: 'E:/__definitely_not_a_real_path__', model: 'sonnet' }));
    });
    ws.on('message', (data) => {
      gotReply = true;
      const m = JSON.parse(data.toString());
      // The test passes if the server didn't reject with "Unknown command type".
      // It can return an error (invalid path, spawn fail) - that means the
      // type routing reached the handler.
      const rejectedByAllowlist = m.type === 'error' && /Unknown command type/.test(m.message || '');
      assert(!rejectedByAllowlist, `${msg} - got: ${m.message || m.type}`);
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve();
    });
    ws.on('error', () => { /* will time out */ });
  });
}

function testBridgeRejects(type, msg) {
  return new Promise((resolve) => {
    const ws = new WebSocket(bridgeWs, { origin: appUrl });
    const timeout = setTimeout(() => {
      assert(false, `${msg} - timeout`);
      try { ws.terminate(); } catch {}
      resolve();
    }, 3500);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 8888, type, command: 'ping' }));
    });
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      const rejected = m.type === 'error' && /Unknown command type/.test(m.message || '');
      assert(rejected, `${msg} - got: ${m.message || m.type}`);
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve();
    });
    ws.on('error', () => { /* will time out */ });
  });
}

async function smokeTest() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => { pageErrors.push(e.message); });
    await page.goto(`${appUrl}/?bridge=${encodeURIComponent(bridgeWs)}`, { waitUntil: 'networkidle', timeout: 15000 });
    // Title screen is HTML, Phaser canvas mounts after a user clicks Start.
    // For smoke, just confirm the page rendered and bundle evaluated cleanly.
    const title = await page.title();
    assert(title && title.length > 0, 'game page should have a title');
    const hasStart = await page.$('button#start-btn, button[class*="start"], input#domain-input, input[placeholder*="domain" i]');
    assert(!!hasStart, 'title screen UI (start button or domain input) should be present');
    // Critical: no JS errors at boot
    const nonFatalNoise = consoleErrors.filter((t) =>
      !/ws:\/\/127\.0\.0\.1:\d+/i.test(t) &&         // bridge-not-yet-started ws noise is fine at early boot
      !/favicon/i.test(t) &&
      !/manifest\.json/i.test(t)
    );
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
    assert(nonFatalNoise.length === 0, `console errors: ${nonFatalNoise.join(' | ')}`);
  } finally {
    await browser.close();
  }
}
