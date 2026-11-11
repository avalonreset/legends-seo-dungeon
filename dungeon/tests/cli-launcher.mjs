import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../server/index.js');

const envKeys = [
  'PATH',
  'Path',
  'path',
  'SEO_DUNGEON_CODEX_CLI',
  'SEO_DUNGEON_CODEX_ARGS',
  'SEO_DUNGEON_CODEX_TRANSPORT',
  'SEO_DUNGEON_CODEX_BYPASS',
  'SEO_DUNGEON_CODEX_DANGEROUS_BYPASS',
  'SEO_DUNGEON_CLAUDE_ARGS',
  'SEO_DUNGEON_GEMINI_ARGS',
  'SEO_DUNGEON_CODEX_EFFORT_DEEP',
  'SEO_DUNGEON_CODEX_EFFORT_BALANCED',
  'SEO_DUNGEON_CODEX_EFFORT_FAST',
  'SEO_DUNGEON_CLAUDE_MODEL',
  'SEO_DUNGEON_CLAUDE_MODEL_DEEP',
  'SEO_DUNGEON_CLAUDE_MODEL_BALANCED',
  'SEO_DUNGEON_CLAUDE_MODEL_FAST',
  'SEO_DUNGEON_GEMINI_MODEL',
  'SEO_DUNGEON_GEMINI_MODEL_DEEP',
  'SEO_DUNGEON_GEMINI_MODEL_BALANCED',
  'SEO_DUNGEON_GEMINI_MODEL_FAST',
  'SEO_DUNGEON_ALLOW_NO_ORIGIN',
  'SEO_DUNGEON_DISABLE_FOLDER_PICKER'
];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dungeon-cli-'));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTempDir(dir) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      return;
    } catch (err) {
      lastError = err;
      await delay(250);
    }
  }
  console.warn(`Warning: could not remove temp test directory ${dir}: ${lastError.message}`);
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

try {
  const fakeBase = path.join(tmp, 'fakeagent');
  const fakeCmd = `${fakeBase}.cmd`;
  const fakePs1 = `${fakeBase}.ps1`;
  const fakeJs = path.join(tmp, 'node_modules', 'fakeagent', 'bin', 'fakeagent.js');
  const fakeCodexAppServer = path.join(tmp, 'fake-codex-app-server.cjs');
  fs.writeFileSync(fakeBase, 'extensionless shim\n', 'utf8');
  fs.writeFileSync(fakeCmd, '@echo off\r\necho fakeagent\r\n', 'utf8');
  fs.mkdirSync(path.dirname(fakeJs), { recursive: true });
  fs.writeFileSync(fakeJs, 'console.log("fakeagent")\n', 'utf8');
  fs.writeFileSync(fakeCodexAppServer, `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let turnStarted = false;
let completed = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const textFromInput = (input) => {
  if (!Array.isArray(input)) return '';
  for (const item of input) {
    if (item?.type === 'text' && !Array.isArray(item.text_elements)) {
      throw new Error('Codex text input must include text_elements');
    }
  }
  return input.map((item) => item && item.text ? item.text : '').join('\\n').trim();
};

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'fake-codex', platformFamily: 'test', platformOs: 'test' } });
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'thread_fake' } } });
    send({ method: 'thread/started', params: { thread: { id: 'thread_fake' } } });
    return;
  }
  if (msg.method === 'turn/start') {
    textFromInput(msg.params && msg.params.input);
    setTimeout(() => {
      turnStarted = true;
      send({ method: 'turn/started', params: { turn: { id: 'turn_fake' } } });
      send({ id: msg.id, result: { turn: { id: 'turn_fake' } } });
    }, 300);
    setTimeout(() => {
      if (completed) return;
      completed = true;
      send({ method: 'item/agentMessage/delta', params: { delta: 'initial complete\\n' } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'completed' } } });
    }, 800);
    return;
  }
  if (msg.method === 'turn/steer') {
    if (!turnStarted) {
      send({ id: msg.id, error: { code: -32000, message: 'no active turn to steer' } });
      return;
    }
    send({ id: msg.id, result: { turnId: 'turn_fake' } });
    send({ method: 'item/agentMessage/delta', params: { delta: 'steered=' + textFromInput(msg.params.input) + '\\n' } });
    return;
  }
  if (msg.method === 'turn/interrupt') {
    completed = true;
    send({ id: msg.id, result: {} });
    send({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'interrupted' } } });
  }
});
`, 'utf8');
  fs.writeFileSync(fakePs1, `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=".exe"
if (Test-Path "$basedir/node$exe") {
  & "$basedir/node$exe" --no-warnings=DEP0040 "$basedir/node_modules/fakeagent/bin/fakeagent.js" $args
} else {
  & "node$exe" --no-warnings=DEP0040 "$basedir/node_modules/fakeagent/bin/fakeagent.js" $args
}
exit $LASTEXITCODE
`, 'utf8');

  const testPath = `${tmp}${path.delimiter}${savedEnv.PATH || savedEnv.Path || savedEnv.path || ''}`;
  process.env.PATH = testPath;
  process.env.Path = testPath;
  process.env.path = testPath;

  const fakeLaunch = bridge.resolveCliLaunch('fakeagent');
  if (process.platform === 'win32') {
    assert.equal(fakeLaunch.command, 'node.exe');
    assert.equal(fakeLaunch.shell, false);
    assert.deepEqual(fakeLaunch.argsPrefix, ['--no-warnings=DEP0040', fakeJs]);
    assert.match(fakeLaunch.display, /fakeagent\.ps1 -> .*fakeagent\.js$/i);
  } else {
    assert.equal(fakeLaunch.command, 'fakeagent');
    assert.equal(fakeLaunch.shell, false);
  }

  const ps1Launch = bridge.resolveCliLaunch(fakePs1);
  if (process.platform === 'win32') {
    assert.equal(ps1Launch.command, 'node.exe');
    assert.match(ps1Launch.display, /fakeagent\.ps1 -> .*fakeagent\.js$/i);
    assert.deepEqual(ps1Launch.argsPrefix, ['--no-warnings=DEP0040', fakeJs]);
    assert.equal(ps1Launch.shell, false);
  } else {
    assert.equal(ps1Launch.command, fakePs1);
    assert.equal(ps1Launch.shell, false);
  }

  const cmdLaunch = bridge.resolveCliLaunch(fakeCmd);
  if (process.platform === 'win32') {
    assert.equal(cmdLaunch.command, 'node.exe');
    assert.equal(cmdLaunch.shell, false);
    assert.deepEqual(cmdLaunch.argsPrefix, ['--no-warnings=DEP0040', fakeJs]);
    assert.match(cmdLaunch.display, /fakeagent\.cmd -> .*fakeagent\.js$/i);
  }

  process.env.SEO_DUNGEON_CODEX_CLI = 'fakeagent';
  process.env.SEO_DUNGEON_CODEX_ARGS = '--flag "two words"';
  assert.deepEqual(bridge.resolveCodexCli(), {
    execPath: 'fakeagent',
    args: ['--flag', 'two words']
  });

  for (const key of envKeys.filter((key) => key.startsWith('SEO_DUNGEON_') && key.includes('_MODEL_'))) {
    delete process.env[key];
  }
  delete process.env.SEO_DUNGEON_CODEX_EFFORT_DEEP;
  delete process.env.SEO_DUNGEON_CODEX_EFFORT_BALANCED;
  delete process.env.SEO_DUNGEON_CODEX_EFFORT_FAST;
  assert.equal(bridge.getCodexProfileConfig('deep').effort, 'xhigh');
  assert.equal(bridge.getCodexProfileConfig('balanced').effort, 'high');
  assert.equal(bridge.getCodexProfileConfig('fast').effort, 'medium');
  delete process.env.SEO_DUNGEON_CODEX_BYPASS;
  delete process.env.SEO_DUNGEON_CODEX_DANGEROUS_BYPASS;
  assert.equal(bridge.normalizeDangerousBypass(undefined), false);
  process.env.SEO_DUNGEON_CODEX_DANGEROUS_BYPASS = '1';
  assert.equal(bridge.normalizeDangerousBypass(undefined), true);
  assert.equal(bridge.normalizeDangerousBypass(false), false);
  delete process.env.SEO_DUNGEON_CODEX_DANGEROUS_BYPASS;

  delete process.env.SEO_DUNGEON_CODEX_TRANSPORT;
  const capabilities = bridge.getBridgeCapabilities();
  assert.equal(capabilities.supportsSteer, true, 'bridge capabilities should advertise live steering');
  assert(capabilities.allowedTypes.includes('steer'), 'bridge allowlist should accept steer messages');
  assert(capabilities.allowedTypes.includes('capabilities'), 'bridge allowlist should accept capability probes');
  process.env.SEO_DUNGEON_CODEX_TRANSPORT = 'exec';
  const execCapabilities = bridge.getBridgeCapabilities();
  assert.equal(execCapabilities.supportsSteer, false, 'codex exec transport should not advertise app-server live steering');
  assert.equal(execCapabilities.defaultCodexTransport, 'exec');
  delete process.env.SEO_DUNGEON_CODEX_TRANSPORT;

  const validProjectDir = fs.mkdtempSync(path.join(tmp, 'project-'));
  process.env.SEO_DUNGEON_CODEX_CLI = process.execPath;
  process.env.SEO_DUNGEON_CODEX_ARGS = `"${fakeCodexAppServer}"`;
  const streamed = [];
  const codexRun = bridge.runCodex(
    'initial prompt',
    (chunk) => streamed.push(chunk),
    validProjectDir,
    73001,
    'fast',
    { dangerousBypass: true }
  );
  const steerResult = await bridge.steerActiveProcess(73001, 'steer while starting');
  assert.equal(steerResult.mode, 'codex-app-server');
  await codexRun;
  assert(streamed.includes('steered=steer while starting'), 'app-server transport should wait for a steerable turn and inject steering');
  assert(streamed.includes('[Complete]'), 'app-server transport should stream completion');

  assert.throws(
    () => bridge.buildCodexExecArgs({
      cliArgs: ['--agent-flag'],
      prompt: 'audit example.com',
      workDir: validProjectDir,
      profile: 'deep',
      dangerousBypass: false
    }),
    /YOLO Mode must be armed/
  );

  const bypassCodex = bridge.buildCodexExecArgs({
    cliArgs: [],
    prompt: 'git push dry run',
    workDir: validProjectDir,
    profile: 'balanced',
    dangerousBypass: true
  }).args;
  assert(bypassCodex.includes('--dangerously-bypass-approvals-and-sandbox'), 'YOLO Codex args should include dangerous bypass');
  assert(!bypassCodex.includes('workspace-write'), 'YOLO Codex args should not also request workspace-write');
  assert(!bypassCodex.includes('-s'), 'YOLO Codex args should not include sandbox selection');

  assert.equal(bridge.getTextCliProfileConfig('claude', 'deep').model, 'opus');
  assert.equal(bridge.getTextCliProfileConfig('claude', 'balanced').model, 'sonnet');
  assert.equal(bridge.getTextCliProfileConfig('claude', 'fast').model, 'haiku');
  assert.equal(bridge.getTextCliProfileConfig('gemini', 'deep').model, 'pro');
  assert.equal(bridge.getTextCliProfileConfig('gemini', 'balanced').model, 'flash');
  assert.equal(bridge.getTextCliProfileConfig('gemini', 'fast').model, 'flash-lite');

  const geminiCli = bridge.resolveTextCli('gemini');
  assert.equal(geminiCli.execPath, 'gemini');
  assert(geminiCli.args.includes('{{prompt}}'), 'Gemini args must include a prompt placeholder');

  assert.deepEqual(
    bridge.insertPromptArg(['--prompt', '{{prompt}}', '--model', 'flash'], 'hello'),
    ['--prompt', 'hello', '--model', 'flash']
  );
  assert.deepEqual(
    bridge.insertPromptArg(['exec', '--json'], 'multi word prompt stays together'),
    ['exec', '--json', '--', 'multi word prompt stays together']
  );

  delete process.env.SEO_DUNGEON_ALLOW_NO_ORIGIN;
  assert.equal(bridge.isAllowedOrigin('http://localhost:3002'), true);
  assert.equal(bridge.isAllowedOrigin('http://evil.test:3000'), false);
  assert.equal(bridge.isAllowedOrigin(undefined), false);
  process.env.SEO_DUNGEON_ALLOW_NO_ORIGIN = '1';
  assert.equal(bridge.isAllowedOrigin(undefined), true);

  const fakeOpenAiKey = 'sk-' + '1234567890abcdefghijklmnopqrstuvwxyz';
  const fakeGithubToken = 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz123456';
  const fakeAwsKey = 'AKIA' + '1234567890ABCDEF';
  const redacted = bridge.redactSensitiveText(
    `api_key=${fakeOpenAiKey} token=${fakeGithubToken} ${fakeAwsKey}`
  );
  assert(!redacted.includes('abcdefghijklmnopqrstuvwxyz123456'), 'GitHub token should be redacted');
  assert(!redacted.includes('1234567890ABCDEF'), 'AWS key body should be redacted');
  assert(redacted.includes('api_key=sk-1****'), 'generic key assignment should be redacted');

  const missingProjectDir = path.join(tmp, 'missing-project');
  assert.equal(bridge.validateProjectPath(validProjectDir), fs.realpathSync(validProjectDir));
  assert.equal(bridge.validateProjectPath(missingProjectDir), null);
  assert.equal(bridge.folderPickerStartPath(missingProjectDir), tmp);
  process.env.SEO_DUNGEON_DISABLE_FOLDER_PICKER = '1';
  assert.throws(
    () => bridge.revealOrPickProjectPath(missingProjectDir),
    /Project folder does not exist or is not allowed/
  );

  console.log('CLI launcher tests passed');
} finally {
  restoreEnv();
  await cleanupTempDir(tmp);
}
