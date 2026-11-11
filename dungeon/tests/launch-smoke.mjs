import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dungeon launch fixture '));
const blocker = net.createServer();
await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
const blockedPort = blocker.address().port;
let child;
let output = '';
try {
  fs.mkdirSync(path.join(fixture, 'dist'));
  fs.mkdirSync(path.join(fixture, 'server'));
  fs.copyFileSync(path.join(root, 'launch.js'), path.join(fixture, 'launch.js'));
  fs.writeFileSync(path.join(fixture, 'dist/index.html'), '<html>Generic launcher fixture</html>');
  fs.writeFileSync(path.join(fixture, 'server/index.js'), `
    if (process.env.SEO_DUNGEON_BRIDGE_STRICT_PORT !== '1') process.exit(2);
    require('http').createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ok: true, protocol: 2, supportedRuntimes: ['codex']}));
    }).listen(Number(process.env.SEO_DUNGEON_BRIDGE_PORT), '127.0.0.1');
  `);
  fs.writeFileSync(path.join(fixture, 'start.cjs'), `
    process.on('message', message => { if (message === 'shutdown') process.emit('SIGINT'); });
    require('./launch.js');
  `);
  child = fork(path.join(fixture, 'start.cjs'), [], {
    silent: true,
    env: {
      ...process.env,
      NODE_PATH: path.join(root, 'node_modules'),
      SEO_DUNGEON_APP_PORT: String(blockedPort),
      SEO_DUNGEON_BRIDGE_PORT: String(blockedPort)
    }
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const deadline = Date.now() + 15000;
  while (!output.includes('Open http://localhost:')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Launcher failed: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const appPort = Number(output.match(/Open http:\/\/localhost:(\d+)/)[1]);
  const bridgePort = Number(output.match(/Bridge server started \(port (\d+)\)/)[1]);
  assert.notEqual(appPort, blockedPort);
  assert.notEqual(bridgePort, blockedPort);
  assert.notEqual(appPort, bridgePort, 'UI and bridge need distinct ports even when both defaults are busy');
  const response = await fetch(`http://127.0.0.1:${appPort}/`);
  assert.match(await response.text(), /Generic launcher fixture/);
  const config = await fetch(`http://127.0.0.1:${appPort}/seo-dungeon-runtime-config.js`);
  assert.match(await config.text(), new RegExp(`127\\.0\\.0\\.1:${bridgePort}`));
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.send('shutdown');
  await exited;
  for (const port of [appPort, bridgePort]) {
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise(resolve => probe.close(resolve));
  }
  console.log('PASS: ZIP-style startup, no npx download, busy ports, runtime config, and child cleanup');
} finally {
  child?.kill();
  await new Promise(resolve => blocker.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
}
