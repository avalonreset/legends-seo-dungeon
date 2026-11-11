import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';

const iterations = Number(process.env.SEO_DUNGEON_STRESS_ITERATIONS || 3);
const basePort = Number(process.env.SEO_DUNGEON_STRESS_BASE_PORT || (20000 + (process.pid % 20000)));
const npmExecPath = process.env.npm_execpath;

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (available) => {
      server.removeAllListeners();
      resolve(available);
    };
    server.unref();
    server.once('error', () => done(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => done(true));
    });
  });
}

async function findAvailablePort(start) {
  for (let port = start; port < 65535; port++) {
    if (await canBindPort(port)) return port;
  }
  throw new Error(`Could not find available TCP port at or above ${start}`);
}

async function findAvailablePortPair(start) {
  for (let port = start; port < 65534; port++) {
    if ((await canBindPort(port)) && (await canBindPort(port + 1))) {
      return [port, port + 1];
    }
  }
  throw new Error(`Could not find available adjacent TCP ports at or above ${start}`);
}

function npmRun(script) {
  if (npmExecPath) return [process.execPath, [npmExecPath, 'run', script]];
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return [npmCommand, ['run', script]];
}

const suites = [
  {
    name: 'dialogue',
    command: npmRun('test:dialogue'),
    async envFor(index) {
      const port = await findAvailablePort(basePort + index * 100);
      return { SEO_DUNGEON_DIALOGUE_TEST_PORT: String(port) };
    },
  },
  {
    name: 'live-bridge',
    command: npmRun('test:live-bridge'),
    async envFor(index) {
      const port = await findAvailablePort(basePort + index * 100 + 30);
      return { SEO_DUNGEON_LIVE_BRIDGE_TEST_PORT: String(port) };
    },
  },
  {
    name: 'ux',
    command: npmRun('test:ux'),
    async envFor(index) {
      const [bridgePort, vitePort] = await findAvailablePortPair(basePort + index * 100 + 60);
      return {
        SEO_DUNGEON_UX_BRIDGE_PORT: String(bridgePort),
        SEO_DUNGEON_UX_VITE_PORT: String(vitePort),
      };
    },
  },
];

function runCommand(label, command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        const error = new Error(`${label} exited with code ${code}`);
        error.output = output;
        reject(error);
      }
    });
  });
}

assert(Number.isInteger(iterations) && iterations > 0, 'SEO_DUNGEON_STRESS_ITERATIONS must be a positive integer');

const started = Date.now();
for (let i = 0; i < iterations; i++) {
  const iteration = i + 1;
  console.log(`\n=== SEO Dungeon stress iteration ${iteration}/${iterations} ===`);
  for (const suite of suites) {
    const [command, args] = suite.command;
    const label = `${suite.name} iteration ${iteration}`;
    console.log(`\n--- ${label} ---`);
    await runCommand(label, command, args, await suite.envFor(i));
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nSEO Dungeon stress loop passed: ${iterations} iteration(s), ${suites.length} suite(s), ${seconds}s`);
