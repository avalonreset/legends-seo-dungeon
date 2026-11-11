const { WebSocketServer } = require('ws');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const REMOTE_PROTOCOL = require('../shared/remote-protocol.cjs');

const DEFAULT_PORT = Number(process.env.SEO_DUNGEON_BRIDGE_PORT || 3003);
const STRICT_PORT = process.env.SEO_DUNGEON_BRIDGE_STRICT_PORT === '1';
let PORT = DEFAULT_PORT;

// Project root: server/ -> dungeon/ -> seo-dungeon/
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DUNGEON_ROOT = path.resolve(__dirname, '..');
let PACKAGE_VERSION = '0.0.0';
try {
  PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(DUNGEON_ROOT, 'package.json'), 'utf8')).version || PACKAGE_VERSION;
} catch (_) {}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/capabilities')) {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({
      ok: true,
      ...getBridgeCapabilities()
    }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

// Evidence directory for failed audits. When _tryParseAudit gives up
// and we fall back to the synthetic "Parse Error" demon, we write the
// full raw agent output here so the failure can be inspected after
// the fact instead of lost. One file per failure, timestamped.
const LOG_DIR = path.resolve(__dirname, '..', '.logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
const BRIDGE_LOG_FILE = process.env.SEO_DUNGEON_BRIDGE_LOG || path.join(LOG_DIR, 'bridge.log');
let consoleFileLoggerInstalled = false;

function serializeLogPart(part) {
  if (typeof part === 'string') return part;
  if (part instanceof Error) return part.stack || part.message;
  try { return JSON.stringify(part); } catch (_) { return String(part); }
}

function appendBridgeLog(level, args) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(serializeLogPart).join(' ')}\n`;
    fs.appendFileSync(BRIDGE_LOG_FILE, line);
  } catch (_) {}
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\b(AKIA)[0-9A-Z]{12}([0-9A-Z]{4})\b/g, '$1****$2')
    .replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{12,}\b/g, '$1****')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{4})[A-Za-z0-9_]{20,}\b/g, '$1****')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8})[A-Za-z0-9-]{12,}\b/g, '$1****')
    .replace(
      /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?)([^"'\s]{8,})/gi,
      (_, prefix, secret) => `${prefix}${secret.slice(0, 4)}****${secret.slice(-4)}`
    );
}

function installConsoleFileLogger() {
  if (consoleFileLoggerInstalled || process.env.SEO_DUNGEON_BRIDGE_LOG === '0') return;
  consoleFileLoggerInstalled = true;
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      appendBridgeLog(level, args);
    };
  }
}

function logFailedAudit(domain, raw, note) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeDomain = (domain || 'unknown').replace(/[^a-z0-9.-]/gi, '_');
    const file = path.join(LOG_DIR, `failed-audit-${safeDomain}-${stamp}.txt`);
    const text = typeof raw === 'string' ? raw : (raw && raw.raw ? raw.raw : JSON.stringify(raw, null, 2));
    const redacted = redactSensitiveText(text);
    fs.writeFileSync(file, `=== ${note || 'failed audit'} ===\ndomain: ${domain}\nwhen: ${new Date().toISOString()}\n\n----- RAW AGENT OUTPUT -----\n${redacted}\n`);
    console.log(`  [evidence] wrote failed audit to ${path.relative(PROJECT_ROOT, file)}`);
  } catch (e) {
    console.error('  [evidence] could not write failure log:', e.message);
  }
}

// ── Security: Allowed message types and rate limits ──
const ALLOWED_TYPES = [...REMOTE_PROTOCOL.allowedTypes];
const MAX_CONCURRENT_PROCESSES = 5;
const MAX_MESSAGES_PER_MINUTE = 30;
const SESSION_EVENT_HISTORY_LIMIT = 200;
const SESSION_EVENT_LOG_FILE = (() => {
  const value = String(process.env.SEO_DUNGEON_SESSION_LOG || '').trim();
  if (!value || value === '0') return null;
  return path.resolve(value);
})();
let sessionEventSequence = 0;
let sessionClientSequence = 0;
const sessionEvents = [];
const sessionClients = new Set();
const sessionClientMeta = new Map();
const remoteCommandClaims = new Map();
const TERMINAL_LEDGER_RESULT_STATUSES = new Set(REMOTE_PROTOCOL.terminalLedgerResultStatuses);
const RESERVED_SESSION_EVENT_KINDS = new Set(REMOTE_PROTOCOL.reservedSessionEventKinds);

function getBridgeCapabilities() {
  const codexTransport = /^exec$/i.test(String(process.env.SEO_DUNGEON_CODEX_TRANSPORT || ''))
    ? 'exec'
    : 'app-server';
  return {
    version: PACKAGE_VERSION,
    protocol: REMOTE_PROTOCOL.protocol,
    supportsSteer: codexTransport === 'app-server',
    supportsRemoteControl: true,
    supportsRemoteCommandClaim: true,
    steerMode: 'active-turn',
    remoteControlMode: 'shared-session-events',
    sessionEventPersistence: Boolean(SESSION_EVENT_LOG_FILE),
    sessionEventHistoryLimit: SESSION_EVENT_HISTORY_LIMIT,
    defaultCodexTransport: codexTransport,
    supportedRuntimes: ['codex', 'claude', 'gemini', 'grok'],
    allowedTypes: [...ALLOWED_TYPES]
  };
}

// ── Security: Origin validation ──
const EXTRA_ALLOWED_ORIGINS = (process.env.SEO_DUNGEON_ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = [
  'http://localhost:3002',
  'http://127.0.0.1:3002',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...EXTRA_ALLOWED_ORIGINS
];

function isAllowedOrigin(origin) {
  if (!origin) return process.env.SEO_DUNGEON_ALLOW_NO_ORIGIN === '1';
  return ALLOWED_ORIGINS.includes(origin);
}

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }) => {
    if (isAllowedOrigin(origin)) return true;
    console.warn(`Rejected WebSocket connection from origin: ${origin}`);
    return false;
  }
});

// Track active child processes so they can be cancelled
const activeProcesses = new Map(); // id -> ChildProcess
const activeProcessOwners = new Map(); // id -> connection token
const activeProcessMetadata = new Map(); // id -> public diagnostic metadata
const pendingProcessMetadata = new Map(); // id -> metadata staged before child starts

function isBlockedSystemPath(candidate) {
  const lower = String(candidate || '').toLowerCase();
  if (lower.startsWith('/var/folders/') || lower.startsWith('/private/var/folders/')) return false;
  const blocked = ['/etc', '/usr', '/bin', '/sbin', '/var', '/root',
    'c:\\windows', 'c:\\program files', 'c:\\program files (x86)'];
  return blocked.some((dir) => lower === dir || lower.startsWith(`${dir}/`) || lower.startsWith(`${dir}\\`));
}

/**
 * Validate and resolve projectPath to prevent path traversal and symlink bypass.
 * Returns the resolved path or null if invalid.
 */
function validateProjectPath(projectPath) {
  if (!projectPath) return PROJECT_ROOT;
  try {
    const resolved = path.resolve(projectPath);
    if (isBlockedSystemPath(resolved)) return null;
    // Must exist and be a directory
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
    const real = fs.realpathSync(resolved);
    if (isBlockedSystemPath(real)) return null;
    return real;
  } catch {
    return null;
  }
}

function revealProjectPath(projectPath) {
  const resolved = validateProjectPath(projectPath);
  if (!resolved) {
    throw new Error('Project folder does not exist or is not allowed.');
  }

  const platform = process.platform;
  const command = platform === 'win32'
    ? path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
    : platform === 'darwin'
      ? 'open'
      : 'xdg-open';

  const child = spawn(command, [resolved], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.once('error', (err) => {
    console.error(`Could not open folder ${resolved}: ${err.message}`);
  });
  child.unref();
  return resolved;
}

function commandAvailable(command) {
  try {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    execFileSync(lookup, [command], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function folderPickerStartPath(projectPath) {
  const candidates = [];
  if (projectPath && String(projectPath).trim()) {
    const resolved = path.resolve(projectPath);
    candidates.push(resolved, path.dirname(resolved));
  }
  candidates.push(
    process.env.USERPROFILE,
    process.env.HOME,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : null,
    PROJECT_ROOT
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    } catch (_) {}
  }
  return PROJECT_ROOT;
}

function pickProjectPath(projectPath) {
  if (process.env.SEO_DUNGEON_DISABLE_FOLDER_PICKER === '1') {
    throw new Error('Project folder does not exist or is not allowed.');
  }

  const startPath = folderPickerStartPath(projectPath);
  let selected = '';

  try {
    if (process.platform === 'win32') {
      throw new Error(
        'Interactive folder picker is disabled on Windows; paste or type the project folder path directly in the UI.'
      );
    } else if (process.platform === 'darwin') {
      selected = execFileSync('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "Choose project folder for Legends SEO Dungeon")'
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } else if (commandAvailable('zenity')) {
      selected = execFileSync('zenity', [
        '--file-selection',
        '--directory',
        '--title=Choose project folder for Legends SEO Dungeon',
        `--filename=${startPath}${path.sep}`
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } else if (commandAvailable('kdialog')) {
      selected = execFileSync('kdialog', [
        '--getexistingdirectory',
        startPath,
        '--title',
        'Choose project folder for Legends SEO Dungeon'
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } else {
      throw new Error('No native folder picker is available on this system.');
    }
  } catch (err) {
    if (err.status === 2 || err.status === 1) {
      throw new Error('Folder selection cancelled.');
    }
    throw err;
  }

  const picked = String(selected || '').trim();
  const validated = validateProjectPath(picked);
  if (!validated) throw new Error('Selected folder is not allowed.');
  return validated;
}

function revealOrPickProjectPath(projectPath) {
  const hasPath = typeof projectPath === 'string' && projectPath.trim().length > 0;
  const resolved = hasPath ? validateProjectPath(projectPath) : null;
  if (resolved) {
    return { action: 'opened', path: revealProjectPath(resolved) };
  }
  return {
    action: 'selected',
    path: pickProjectPath(projectPath),
    previousPath: hasPath ? projectPath : ''
  };
}

/**
 * Sanitize domain input for audit commands.
 */
function sanitizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim().slice(0, 253);
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/.test(trimmed)) return trimmed;
  // Allow URLs
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function normalizeRuntime(runtime) {
  const key = String(runtime || process.env.SEO_DUNGEON_RUNTIME || 'codex').trim().toLowerCase();
  return ['codex', 'claude', 'gemini', 'grok'].includes(key) ? key : 'codex';
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (value == null || value === '') return Boolean(fallback);
  const key = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'yolo', 'danger'].includes(key)) return true;
  if (['0', 'false', 'no', 'off'].includes(key)) return false;
  return Boolean(fallback);
}

function normalizeDangerousBypass(value) {
  const envFallback = normalizeBoolean(
    process.env.SEO_DUNGEON_CODEX_DANGEROUS_BYPASS ?? process.env.SEO_DUNGEON_CODEX_BYPASS,
    false
  );
  return normalizeBoolean(value, envFallback);
}

function resolveAgentProvider(runtime) {
  return normalizeRuntime(runtime);
}

function resolveCodexCli() {
  return {
    execPath: process.env.SEO_DUNGEON_CODEX_CLI || 'codex',
    args: splitArgs(process.env.SEO_DUNGEON_CODEX_ARGS || '')
  };
}

function splitArgs(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const matches = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return matches.map(part => {
    const quote = part[0];
    if ((quote === '"' || quote === "'") && part.endsWith(quote)) return part.slice(1, -1);
    return part;
  });
}

const PROJECT_ENV_EXACT_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'GROK_HOME',
  'PAGESPEED_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CONFIG_DIR',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GSC_PROPERTY',
  'GSC_SITE_URL',
  'GA4_PROPERTY_ID',
]);

const PROJECT_ENV_PREFIXES = [
  'DATAFORSEO_',
  'FIRECRAWL_',
  'GOOGLE_',
  'RAILWAY_',
  'SEO_DUNGEON_',
];

function shouldForwardProjectEnv(key) {
  return PROJECT_ENV_EXACT_KEYS.has(key) ||
    PROJECT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function unquoteEnvValue(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

const MAX_DOTENV_BYTES = 65536;

function readDotEnvFile(filePath) {
  const values = {};
  try {
    if (!fs.existsSync(filePath)) return values;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_DOTENV_BYTES) {
      return values;
    }
    const source = fs.readFileSync(filePath, 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (!shouldForwardProjectEnv(key)) continue;
      values[key] = unquoteEnvValue(trimmed.slice(index + 1));
    }
  } catch (err) {
    console.warn(`  [env] Could not read ${filePath}: ${err.message}`);
  }
  return values;
}

function projectEnv(cwd) {
  const values = {};
  if (!cwd) return values;
  for (const name of ['.env', '.env.local']) {
    Object.assign(values, readDotEnvFile(path.join(cwd, name)));
  }
  return values;
}

function getPathEnv() {
  return process.env.PATH || process.env.Path || process.env.path || '';
}

function isPathLike(value) {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

function uniqueCaseInsensitive(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = String(value || '').trim();
    if (!item) continue;
    const key = process.platform === 'win32' ? item.toLowerCase() : item;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function windowsExecutableCandidates(command) {
  const raw = String(command || '').trim();
  if (!raw || process.platform !== 'win32') return [raw];

  const candidates = [];
  const pathExt = uniqueCaseInsensitive([
    ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';'),
    '.PS1'
  ]).filter(Boolean);
  if (isPathLike(raw)) {
    candidates.push(raw);
    if (!path.extname(raw)) {
      for (const ext of pathExt) candidates.push(`${raw}${ext.toLowerCase()}`);
    }
  } else {
    for (const dir of getPathEnv().split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, raw));
      if (!path.extname(raw)) {
        for (const ext of pathExt) candidates.push(path.join(dir, `${raw}${ext.toLowerCase()}`));
      }
    }
    try {
      const pathEnv = getPathEnv();
      const output = execFileSync('where.exe', [raw], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, PATH: pathEnv, Path: pathEnv }
      });
      candidates.push(...output.split(/\r?\n/));
    } catch (_) {
      // Fall back to the raw command. The later spawn error will be clearer.
    }
    candidates.push(raw);
  }

  return uniqueCaseInsensitive(candidates).filter((candidate) => {
    if (!isPathLike(candidate)) return candidate === raw;
    try { return fs.existsSync(candidate); } catch (_) { return false; }
  });
}

function selectWindowsCliCandidate(command) {
  const candidates = windowsExecutableCandidates(command);
  const directExts = new Set(['.exe', '.com', '.ps1']);
  const direct = candidates.find((candidate) =>
    directExts.has(path.extname(candidate).toLowerCase())
  );
  if (direct) return direct;

  const batch = candidates.find((candidate) =>
    ['.cmd', '.bat'].includes(path.extname(candidate).toLowerCase())
  );
  if (batch) return batch;

  return candidates[0] || command;
}

function resolveNpmPowerShellShim(ps1Path, trySiblingCmd = true) {
  try {
    const source = fs.readFileSync(ps1Path, 'utf8');
    const basedir = path.dirname(ps1Path);
    const match = source.match(/node\$exe"\s+([^"\r\n]*?)"\$basedir[\\/](.*?\.(?:c|m)?js)"\s+\$args/i);
    if (match) {
      const nodeExe = fs.existsSync(path.join(basedir, 'node.exe'))
        ? path.join(basedir, 'node.exe')
        : 'node.exe';
      const nodeArgs = splitArgs(match[1] || '');
      const scriptPath = path.join(basedir, ...match[2].split(/[\\/]/));
      if (fs.existsSync(scriptPath)) {
        return {
          command: nodeExe,
          argsPrefix: [...nodeArgs, scriptPath],
          shell: false,
          display: `${ps1Path} -> ${scriptPath}`
        };
      }
    }

    const exeMatch = source.match(/&\s+"\$basedir[\\/]([^"\r\n]+?\.exe)"\s+\$args/i);
    if (exeMatch) {
      const exePath = path.join(basedir, ...exeMatch[1].split(/[\\/]/));
      if (fs.existsSync(exePath)) {
        return {
          command: exePath,
          argsPrefix: [],
          shell: false,
          display: `${ps1Path} -> ${exePath}`
        };
      }
    }

    if (trySiblingCmd) {
      const siblingCmd = ps1Path.replace(/\.ps1$/i, '.cmd');
      if (siblingCmd !== ps1Path && fs.existsSync(siblingCmd)) {
        const cmdResolved = resolveNpmCmdShim(siblingCmd, false);
        if (cmdResolved) {
          return {
            ...cmdResolved,
            display: `${ps1Path} -> ${cmdResolved.argsPrefix[cmdResolved.argsPrefix.length - 1] || cmdResolved.command}`
          };
        }
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

function resolveNpmCmdShim(cmdPath, trySiblingPs1 = true) {
  try {
    const source = fs.readFileSync(cmdPath, 'utf8');
    const basedir = path.dirname(cmdPath);
    const match = source.match(/(?:node(?:\.exe)?|%_prog%)"?\s+([^"\r\n]*?)"%(?:~?dp0%?)[\\/](.*?\.(?:c|m)?js)"\s+%\*/i)
      || source.match(/"%(?:~?dp0%?)[\\/](.*?\.(?:c|m)?js)"\s+%\*/i);
    if (match) {
      const nodeExe = fs.existsSync(path.join(basedir, 'node.exe'))
        ? path.join(basedir, 'node.exe')
        : 'node.exe';
      const hasArgsGroup = match.length > 2;
      const nodeArgs = hasArgsGroup ? splitArgs(match[1] || '') : [];
      const relScript = hasArgsGroup ? match[2] : match[1];
      const scriptPath = path.join(basedir, ...relScript.split(/[\\/]/));
      if (fs.existsSync(scriptPath)) {
        return {
          command: nodeExe,
          argsPrefix: [...nodeArgs, scriptPath],
          shell: false,
          display: `${cmdPath} -> ${scriptPath}`
        };
      }
    }

    const exeMatch = source.match(/"%(?:~?dp0%?)[\\/]([^"\r\n]+?\.exe)"\s+%\*/i);
    if (exeMatch) {
      const exePath = path.join(basedir, ...exeMatch[1].split(/[\\/]/));
      if (fs.existsSync(exePath)) {
        return {
          command: exePath,
          argsPrefix: [],
          shell: false,
          display: `${cmdPath} -> ${exePath}`
        };
      }
    }

    if (trySiblingPs1) {
      const siblingPs1 = cmdPath.replace(/\.(cmd|bat)$/i, '.ps1');
      if (siblingPs1 !== cmdPath && fs.existsSync(siblingPs1)) {
        const ps1Resolved = resolveNpmPowerShellShim(siblingPs1, false);
        if (ps1Resolved) {
          return {
            ...ps1Resolved,
            display: `${cmdPath} -> ${ps1Resolved.argsPrefix[ps1Resolved.argsPrefix.length - 1] || ps1Resolved.command}`
          };
        }
      }
    }
  } catch (_) {}
  return null;
}

function resolveCliLaunch(execPath) {
  const raw = String(execPath || '').trim();
  if (!raw) throw new Error('CLI executable path is empty.');
  if (process.platform !== 'win32') {
    return { command: raw, argsPrefix: [], shell: false, display: raw };
  }

  const selected = selectWindowsCliCandidate(raw);
  const ext = path.extname(selected).toLowerCase();

  if (ext === '.cmd' || ext === '.bat') {
    const cmdShim = resolveNpmCmdShim(selected);
    if (cmdShim) return cmdShim;
    throw new Error(
      `Cannot safely unwrap Windows script shim (${selected}). Set SEO_DUNGEON_<RUNTIME>_CLI to the underlying .exe or .js entrypoint.`
    );
  }

  if (ext === '.ps1') {
    const npmShim = resolveNpmPowerShellShim(selected);
    if (npmShim) return npmShim;
    throw new Error(
      `Cannot safely unwrap Windows script shim (${selected}). Set SEO_DUNGEON_<RUNTIME>_CLI to the underlying .exe or .js entrypoint.`
    );
  }

  return {
    command: selected,
    argsPrefix: [],
    shell: false,
    display: selected
  };
}

/**
 * Build a minimal environment for child processes.
 */
function safeEnv(cwd) {
  const pathEnv = getPathEnv();
  const env = { HOME: process.env.HOME };
  if (pathEnv) {
    env.PATH = pathEnv;
    if (process.platform === 'win32') env.Path = pathEnv;
  }
  if (process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
  if (process.env.APPDATA) env.APPDATA = process.env.APPDATA;
  if (process.env.USERPROFILE) env.USERPROFILE = process.env.USERPROFILE;
  if (process.env.LOCALAPPDATA) env.LOCALAPPDATA = process.env.LOCALAPPDATA;
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (process.env.GOOGLE_API_KEY) env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  if (process.env.GEMINI_CONFIG_DIR) env.GEMINI_CONFIG_DIR = process.env.GEMINI_CONFIG_DIR;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;
  for (const [key, value] of Object.entries(process.env)) {
    if (shouldForwardProjectEnv(key) && value) env[key] = value;
  }
  Object.assign(env, projectEnv(cwd));
  return env;
}

function trackProcess(requestId, proc, ownerToken = null, metadata = {}) {
  if (requestId === undefined || requestId === null) return;
  activeProcesses.set(requestId, proc);
  if (ownerToken) activeProcessOwners.set(requestId, ownerToken);
  const staged = pendingProcessMetadata.get(requestId) || {};
  pendingProcessMetadata.delete(requestId);
  activeProcessMetadata.set(requestId, {
    ...staged,
    ...metadata,
    startedAt: staged.startedAt || metadata.startedAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    status: metadata.status || staged.status || 'running',
  });
}

function untrackProcess(requestId) {
  if (requestId === undefined || requestId === null) return;
  activeProcesses.delete(requestId);
  activeProcessOwners.delete(requestId);
  activeProcessMetadata.delete(requestId);
  pendingProcessMetadata.delete(requestId);
}

function steerActiveProcess(targetId, text) {
  const numericTargetId = Number(targetId);
  const clean = String(text || '').trim();
  if (!Number.isFinite(numericTargetId)) {
    throw new Error('Invalid active turn id.');
  }
  if (!clean) {
    throw new Error('Nothing to steer.');
  }

  const proc = activeProcesses.get(numericTargetId);
  if (!proc) {
    throw new Error('No active operation to steer.');
  }

  if (typeof proc.steer === 'function') {
    return proc.steer(clean);
  }

  if (proc.stdin && proc.stdin.writable && !proc.stdin.destroyed) {
    proc.stdin.write(`\n${clean}\n`);
    return { targetId: numericTargetId, mode: 'stdin' };
  }

  throw new Error('Active runtime cannot accept live steering. Prompt kept in queue.');
}

function trimEventText(value, max = 4000) {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function publicClientMeta(meta) {
  return {
    id: meta.clientId,
    role: meta.role,
    origin: meta.origin,
    connectedAt: meta.connectedAt,
    lastSeenAt: meta.lastSeenAt,
    lastType: meta.lastType || null,
    lastSource: meta.lastSource || null,
    messageCount: meta.messageCount || 0,
  };
}

function publicConnectedClients() {
  return [...sessionClientMeta.values()].map(publicClientMeta);
}

function inferClientRole(type, source, currentRole = 'unknown') {
  const sourceKey = String(source || '').toLowerCase();
  if (['remote-command-claim', 'audit', 'fix', 'chat', 'commit', 'narrate', 'open-folder'].includes(type)) return 'browser';
  if (currentRole === 'browser') return 'browser';
  if (['remote-command'].includes(type) || /^codex/.test(sourceKey)) return 'controller';
  if (sourceKey === 'guild-ledger') return 'browser';
  return currentRole || 'unknown';
}

function updateClientMeta(ws, msg = {}) {
  const meta = sessionClientMeta.get(ws);
  if (!meta) return;
  const source = msg.source || msg.event?.source || null;
  meta.lastSeenAt = new Date().toISOString();
  meta.lastType = trimEventText(msg.type || 'unknown', 80);
  meta.lastSource = source ? trimEventText(source, 80) : meta.lastSource;
  meta.messageCount = (meta.messageCount || 0) + 1;
  meta.role = inferClientRole(msg.type, source, meta.role);
}

function operationSummary(id, metadata = {}, proc = null) {
  const hasSteerFunction = typeof proc?.steer === 'function';
  const hasWritableStdin = Boolean(proc?.stdin && proc.stdin.writable && !proc.stdin.destroyed);
  const canSteer = hasSteerFunction
    ? Boolean(proc.turnId)
    : hasWritableStdin;
  return {
    id,
    type: metadata.type || 'operation',
    status: metadata.status || 'running',
    runtime: metadata.runtime || 'codex',
    profile: metadata.profile || 'balanced',
    source: metadata.source || 'guild-ledger',
    projectPath: metadata.projectPath || null,
    label: metadata.label || metadata.type || 'operation',
    startedAt: metadata.startedAt,
    lastSeenAt: metadata.lastSeenAt || metadata.startedAt,
    lastStreamAt: metadata.lastStreamAt || null,
    lastStream: metadata.lastStream || null,
    canSteer,
    steerMode: hasSteerFunction ? 'app-server-turn' : (hasWritableStdin ? 'stdin' : 'none'),
  };
}

function publicActiveOperations() {
  return [...activeProcessMetadata.entries()]
    .map(([id, metadata]) => operationSummary(id, metadata, activeProcesses.get(id)));
}

function stageProcessMetadata(requestId, metadata = {}) {
  if (requestId === undefined || requestId === null) return;
  pendingProcessMetadata.set(requestId, {
    ...metadata,
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
}

function updateActiveProcessMetadata(requestId, updates = {}) {
  const existing = activeProcessMetadata.get(requestId) || pendingProcessMetadata.get(requestId);
  if (!existing) return;
  const next = {
    ...existing,
    ...updates,
    lastSeenAt: new Date().toISOString(),
  };
  if (activeProcessMetadata.has(requestId)) activeProcessMetadata.set(requestId, next);
  else pendingProcessMetadata.set(requestId, next);
}

function updateActiveProcessStream(requestId, chunk) {
  const clean = trimEventText(chunk, 300);
  if (!clean) return;
  updateActiveProcessMetadata(requestId, {
    status: 'streaming',
    lastStream: clean,
    lastStreamAt: new Date().toISOString(),
  });
}

function updateActiveProcessStatus(requestId, status = {}) {
  if (!status || typeof status !== 'object') return;
  const phase = [status.kind, status.phase].filter(Boolean).join(':') || status.message || 'status';
  updateActiveProcessMetadata(requestId, {
    status: trimEventText(phase, 120),
  });
}

function publicSessionEvent(input = {}) {
  const now = new Date().toISOString();
  const sequence = ++sessionEventSequence;
  const kind = trimEventText(input.kind || 'event', 80) || 'event';
  const source = trimEventText(input.source || 'unknown', 80) || 'unknown';
  const event = {
    eventId: input.eventId || `evt_${sequence}`,
    sequence,
    at: input.at || now,
    kind,
    source,
  };

  for (const key of ['commandId', 'targetId', 'status', 'message', 'action', 'domain', 'character']) {
    if (input[key] != null) event[key] = trimEventText(input[key], 500);
  }
  if (input.command != null) event.command = trimEventText(input.command);
  if (input.projectPath != null) event.projectPath = trimEventText(input.projectPath, 1000);
  if (input.runtime != null) event.runtime = normalizeRuntime(input.runtime);
  if (input.profile != null || input.model != null) event.profile = normalizeProfile(input.profile || input.model);
  if (input.dangerousBypass != null) event.dangerousBypass = normalizeDangerousBypass(input.dangerousBypass);
  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    event.metadata = {};
    for (const [key, value] of Object.entries(input.metadata).slice(0, 20)) {
      event.metadata[trimEventText(key, 80)] = trimEventText(value, 1000);
    }
  }
  return event;
}

function redactSessionEventForPersistence(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSessionEventForPersistence(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSessionEventForPersistence(item)])
    );
  }
  return value;
}

function trimSessionEventHistory() {
  let trimmed = 0;
  while (sessionEvents.length > SESSION_EVENT_HISTORY_LIMIT) {
    const removed = sessionEvents.shift();
    trimmed += 1;
    if (removed?.kind === 'remote-command' && removed.commandId) {
      remoteCommandClaims.delete(removed.commandId);
    }
  }
  return trimmed;
}

function persistSessionEvent(event) {
  if (!SESSION_EVENT_LOG_FILE) return;
  try {
    fs.mkdirSync(path.dirname(SESSION_EVENT_LOG_FILE), { recursive: true });
    fs.appendFileSync(SESSION_EVENT_LOG_FILE, `${JSON.stringify(redactSessionEventForPersistence(event))}\n`, 'utf8');
  } catch (err) {
    console.warn(`Could not persist session event: ${err.message}`);
  }
}

function compactSessionEventLog() {
  if (!SESSION_EVENT_LOG_FILE) return true;
  try {
    fs.mkdirSync(path.dirname(SESSION_EVENT_LOG_FILE), { recursive: true });
    const body = sessionEvents
      .map((event) => JSON.stringify(redactSessionEventForPersistence(event)))
      .join('\n');
    fs.writeFileSync(SESSION_EVENT_LOG_FILE, body ? `${body}\n` : '', 'utf8');
    return true;
  } catch (err) {
    console.warn(`Could not compact session event log: ${err.message}`);
    return false;
  }
}

function loadPersistedSessionEvents() {
  if (!SESSION_EVENT_LOG_FILE || !fs.existsSync(SESSION_EVENT_LOG_FILE)) return;
  try {
    const events = [];
    let skipped = 0;
    const lines = fs.readFileSync(SESSION_EVENT_LOG_FILE, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event && typeof event === 'object' && typeof event.kind === 'string') events.push(event);
        else skipped += 1;
      } catch (_) {
        skipped += 1;
      }
    }
    events.splice(0, Math.max(0, events.length - SESSION_EVENT_HISTORY_LIMIT));
    sessionEvents.push(...events);
    for (const event of events) {
      const sequence = Number(event.sequence || 0);
      if (Number.isFinite(sequence)) sessionEventSequence = Math.max(sessionEventSequence, sequence);
    }
    trimSessionEventHistory();
    compactSessionEventLog();
    console.log(`Loaded ${sessionEvents.length} persisted session events from ${SESSION_EVENT_LOG_FILE}`);
    if (skipped) console.warn(`Skipped ${skipped} malformed persisted session event line(s).`);
  } catch (err) {
    console.warn(`Could not load persisted session events: ${err.message}`);
  }
}

function recordSessionEvent(event) {
  sessionEvents.push(event);
  const trimmed = trimSessionEventHistory();
  if (trimmed > 0) {
    if (!compactSessionEventLog()) persistSessionEvent(event);
  } else {
    persistSessionEvent(event);
  }
  return event;
}

function broadcastSessionEvent(event) {
  const recorded = recordSessionEvent(event);
  const payload = JSON.stringify({ type: 'session-event', event: recorded });
  for (const client of sessionClients) {
    if (client.readyState !== client.OPEN) continue;
    try { client.send(payload); } catch (_) {}
  }
  return recorded;
}

function buildRemoteCommandEvent(msg, validatedPath) {
  const command = trimEventText(msg.command);
  if (!command) throw new Error('Remote command cannot be empty.');
  if (normalizeRuntime(msg.runtime || 'codex') !== 'codex') {
    throw new Error('Remote control mode is Codex-only in this release.');
  }
  const requestedCommandId = msg.commandId ? trimEventText(msg.commandId, 200) : '';
  if (requestedCommandId && sessionEvents.some((entry) =>
    entry.kind === 'remote-command' && entry.commandId === requestedCommandId
  )) {
    throw new Error('Duplicate remote command id rejected.');
  }
  return publicSessionEvent({
    kind: 'remote-command',
    source: msg.source || 'codex-app',
    commandId: requestedCommandId || `cmd_${Date.now().toString(36)}_${sessionEventSequence + 1}`,
    command,
    projectPath: validatedPath || undefined,
    runtime: msg.runtime || 'codex',
    profile: msg.profile || msg.model,
    dangerousBypass: msg.dangerousBypass,
    metadata: msg.metadata,
  });
}

function findRemoteCommandEvent(commandId) {
  const clean = trimEventText(commandId, 200);
  if (!clean) return null;
  for (let index = sessionEvents.length - 1; index >= 0; index -= 1) {
    const entry = sessionEvents[index];
    if (entry?.kind === 'remote-command' && entry.commandId === clean) return entry;
  }
  return null;
}

function hasTerminalLedgerResult(commandId) {
  const commandEvent = findRemoteCommandEvent(commandId);
  if (!commandEvent) return false;
  const commandSequence = Number(commandEvent.sequence || 0);
  return sessionEvents.some((entry) =>
    entry.kind === 'ledger-result' &&
    entry.commandId === commandEvent.commandId &&
    Number(entry.sequence || 0) >= commandSequence &&
    TERMINAL_LEDGER_RESULT_STATUSES.has(String(entry.status || '').toLowerCase())
  );
}

function claimRemoteCommand(commandId, ownerToken) {
  const clean = trimEventText(commandId, 200);
  if (!clean) throw new Error('Remote command claim requires a command id.');
  const event = findRemoteCommandEvent(clean);
  if (!event) throw new Error('Remote command is not available to claim.');
  if (hasTerminalLedgerResult(clean)) throw new Error('Remote command already has a terminal ledger result.');
  const existing = remoteCommandClaims.get(clean);
  if (existing && existing.ownerToken !== ownerToken) {
    return { claimed: false, commandId: clean, claimedAt: existing.claimedAt };
  }
  if (existing && existing.ownerToken === ownerToken) {
    return { claimed: true, commandId: clean, claimedAt: existing.claimedAt };
  }
  const claimedAt = new Date().toISOString();
  remoteCommandClaims.set(clean, { ownerToken, claimedAt });
  return { claimed: true, commandId: clean, claimedAt };
}

function releaseClaimsForOwner(ownerToken) {
  for (const [commandId, claim] of remoteCommandClaims.entries()) {
    if (claim.ownerToken === ownerToken) remoteCommandClaims.delete(commandId);
  }
}

function createSpawnError(runtime, err, launch) {
  const display = launch?.display || runtime;
  const hint = err && err.code === 'EPERM'
    ? ' On Windows this usually means the command resolved to a blocked script shim; set the matching SEO_DUNGEON_*_CLI variable to a .cmd, .bat, or .exe path.'
    : '';
  return new Error(`Failed to spawn ${runtime} CLI (${display}): ${err.message}.${hint} Is ${runtime} installed and authenticated?`);
}

function summarizeCliFailure(runtime, code, stderr, stdout) {
  const text = String(stderr || stdout || '').trim();
  if (!text) return `${runtime} CLI exited with code ${code}`;
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() || text;
  return `${runtime} CLI exited with code ${code}: ${firstLine}`;
}

wss.on('connection', (ws, req) => {
  console.log('Game client connected');
  sessionClients.add(ws);
  const connectionToken = Symbol('seo-dungeon-client');
  const clientMeta = {
    clientId: `client_${++sessionClientSequence}`,
    role: 'unknown',
    origin: req?.headers?.origin || 'none',
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    lastType: null,
    lastSource: null,
    messageCount: 0,
  };
  sessionClientMeta.set(ws, clientMeta);

  // Per-connection rate limiting
  const messageTimestamps = [];

  // Keepalive ping every 15s so the connection doesn't drop during long audits
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 15000);

  const safeSend = (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  };

  ws.on('message', async (raw) => {
    // Rate limiting: max N messages per minute
    const now = Date.now();
    messageTimestamps.push(now);
    while (messageTimestamps.length > 0 && messageTimestamps[0] < now - 60000) {
      messageTimestamps.shift();
    }
    if (messageTimestamps.length > MAX_MESSAGES_PER_MINUTE) {
      safeSend(JSON.stringify({ id: 0, type: 'error', message: 'Rate limit exceeded. Max 30 messages per minute.' }));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error('Invalid JSON from client:', e.message);
      safeSend(JSON.stringify({ id: 0, type: 'error', message: 'Invalid message format' }));
      return;
    }
    updateClientMeta(ws, msg);
    const { id, command, type, projectPath, issue, userMessage, model, profile, runtime, dangerousBypass, targetId } = msg;
    const agentOptions = {
      runtime: normalizeRuntime(runtime),
      profile: normalizeProfile(profile || model),
      dangerousBypass: normalizeDangerousBypass(dangerousBypass)
    };
    agentOptions.connectionToken = connectionToken;
    agentOptions.onStatus = (status) => {
      updateActiveProcessStatus(id, status);
      safeSend({ id, type: 'status', status });
    };

    // Validate message type against allowlist
    if (type && !ALLOWED_TYPES.includes(type)) {
      console.warn(`Rejected unknown message type: ${type}`);
      safeSend(JSON.stringify({ id, type: 'error', message: `Unknown command type: ${type}` }));
      return;
    }

    if (type === 'capabilities') {
      safeSend(JSON.stringify({ id, type: 'result', data: getBridgeCapabilities() }));
      return;
    }

    if (type === 'session-state') {
      safeSend(JSON.stringify({
        id,
        type: 'result',
        data: {
          events: [...sessionEvents],
          claimedCommandIds: [...remoteCommandClaims.keys()],
          activeOperationIds: [...activeProcesses.keys()],
          activeOperations: publicActiveOperations(),
          connectedClients: publicConnectedClients(),
          capabilities: getBridgeCapabilities()
        }
      }));
      return;
    }

    // Validate and resolve projectPath. Folder-open requests get their own
    // fallback path: if the saved folder is invalid, the bridge opens a
    // native folder picker instead of rejecting before the handler runs.
    const validatedPath = validateProjectPath(projectPath);
    if (
      projectPath &&
      !validatedPath &&
      !['open-folder', 'cancel', 'steer', 'session-event'].includes(type)
    ) {
      console.warn(`Rejected invalid projectPath: ${projectPath}`);
      safeSend(JSON.stringify({ id, type: 'error', message: 'Invalid project path' }));
      return;
    }

    // Use validated project path for fixes, project root for audits
    const fixCwd = validatedPath;

    console.log(`Command #${id} [${type}]: ${command || '(no command)'}`);
    if (type !== 'cancel' && type !== 'steer' && type !== 'capabilities') console.log(`  Runtime: ${agentOptions.runtime}, profile: ${agentOptions.profile}`);
    if (type !== 'cancel' && type !== 'steer' && type !== 'capabilities' && agentOptions.runtime === 'codex') console.log(`  Codex dangerous bypass: ${agentOptions.dangerousBypass ? 'on' : 'off'}`);
    if (validatedPath && validatedPath !== PROJECT_ROOT) console.log(`  Project: ${validatedPath}`);

    if (type === 'remote-command') {
      try {
        const event = buildRemoteCommandEvent(msg, validatedPath);
        const recorded = broadcastSessionEvent(event);
        safeSend(JSON.stringify({
          id,
          type: 'result',
          data: {
            accepted: true,
            commandId: recorded.commandId,
            event: recorded
          }
        }));
        console.log(`Remote command queued: ${recorded.commandId}`);
      } catch (err) {
        safeSend(JSON.stringify({ id, type: 'error', message: err.message || 'Could not queue remote command' }));
      }
      return;
    }

    if (type === 'remote-command-claim') {
      try {
        const claim = claimRemoteCommand(msg.commandId || targetId || command, connectionToken);
        safeSend(JSON.stringify({ id, type: 'result', data: claim }));
      } catch (err) {
        safeSend(JSON.stringify({ id, type: 'error', message: err.message || 'Could not claim remote command' }));
      }
      return;
    }

    if (type === 'session-event') {
      const incoming = msg.event && typeof msg.event === 'object' && !Array.isArray(msg.event)
        ? msg.event
        : {};
      const incomingKind = trimEventText(incoming.kind || 'event', 80) || 'event';
      if (RESERVED_SESSION_EVENT_KINDS.has(incomingKind)) {
        safeSend(JSON.stringify({
          id,
          type: 'error',
          message: `${incomingKind} events must use the guarded command endpoint.`
        }));
        return;
      }
      const incomingProjectPath = incoming.projectPath || projectPath;
      let eventProjectPath;
      if (incomingProjectPath && String(incomingProjectPath).trim()) {
        eventProjectPath = validateProjectPath(incomingProjectPath);
        if (!eventProjectPath) {
          safeSend(JSON.stringify({
            id,
            type: 'error',
            message: 'Project folder does not exist or is not allowed.'
          }));
          return;
        }
      }
      if (incomingKind === 'ledger-result' && incoming.commandId) {
        const resultCommandId = trimEventText(incoming.commandId, 200);
        if (!findRemoteCommandEvent(resultCommandId)) {
          safeSend(JSON.stringify({
            id,
            type: 'error',
            message: 'Ledger result references an unknown remote command.'
          }));
          return;
        }
      }
      const event = publicSessionEvent({
        ...incoming,
        source: incoming.source || msg.source || 'guild-ledger',
        projectPath: eventProjectPath || undefined,
      });
      const recorded = broadcastSessionEvent(event);
      safeSend(JSON.stringify({ id, type: 'result', data: { accepted: true, event: recorded } }));
      return;
    }

    // Cancel - kill the child process for a given request
    if (type === 'cancel') {
      const proc = activeProcesses.get(id);
      if (proc) {
        console.log(`Cancelling process #${id}`);
        if (typeof proc.kill === 'function') proc.kill('SIGTERM');
        untrackProcess(id);
      }
      safeSend(JSON.stringify({ id, type: 'error', message: 'Cancelled by user' }));
      return;
    }

    if (type === 'steer') {
      try {
        const steerResult = await steerActiveProcess(targetId, command);
        console.log(`Steered process #${targetId}`);
        safeSend(JSON.stringify({ id, type: 'result', data: steerResult || { targetId } }));
      } catch (err) {
        safeSend(JSON.stringify({ id, type: 'error', message: err.message || 'Could not steer active turn' }));
      }
      return;
    }

    if (type === 'open-folder') {
      try {
        const folderResult = revealOrPickProjectPath(projectPath);
        safeSend(JSON.stringify({ id, type: 'result', data: folderResult }));
      } catch (err) {
        safeSend(JSON.stringify({ id, type: 'error', message: err.message || 'Could not open project folder' }));
      }
      return;
    }

    try {
      // Enforce max concurrent processes
      if (activeProcesses.size >= MAX_CONCURRENT_PROCESSES) {
        safeSend(JSON.stringify({ id, type: 'error', message: `Too many concurrent operations (max ${MAX_CONCURRENT_PROCESSES})` }));
        return;
      }

      if (type === 'audit') {
        const domain = sanitizeDomain(command);
        if (!domain) {
          safeSend(JSON.stringify({ id, type: 'error', message: 'Invalid domain' }));
          return;
        }
        stageProcessMetadata(id, {
          type: 'audit',
          runtime: agentOptions.runtime,
          profile: agentOptions.profile,
          source: 'guild-ledger',
          projectPath: fixCwd,
          label: `Audit ${domain}`,
        });
        const result = await runAudit(domain, (chunk) => {
          updateActiveProcessStream(id, chunk);
          safeSend(JSON.stringify({ id, type: 'stream', content: chunk }));
        }, fixCwd, id, agentOptions);
        untrackProcess(id);
        safeSend(JSON.stringify({ id, type: 'result', data: result }));
        console.log(`Audit done: ${result.issues.length} issues, score ${result.score}`);

      } else if (type === 'fix') {
        stageProcessMetadata(id, {
          type: 'fix',
          runtime: agentOptions.runtime,
          profile: agentOptions.profile,
          source: 'guild-ledger',
          projectPath: fixCwd,
          label: trimEventText(issue?.title || command || 'Fix SEO issue', 160),
        });
        const result = await runFix(issue, userMessage, fixCwd, (chunk) => {
          updateActiveProcessStream(id, chunk);
          safeSend(JSON.stringify({ id, type: 'stream', content: chunk }));
        }, id, agentOptions);
        untrackProcess(id);
        safeSend(JSON.stringify({ id, type: 'result', data: result }));
        console.log(`Fix done: ${(issue && issue.title) || command}`);

      } else if (type === 'commit') {
        // Sanitize commit message: limit length, strip control characters
        const safeMessage = (command || 'SEO fix').replace(/[^\x20-\x7E\n]/g, '').slice(0, 500);
        stageProcessMetadata(id, {
          type: 'commit',
          runtime: agentOptions.runtime,
          profile: agentOptions.profile,
          source: 'guild-ledger',
          projectPath: fixCwd,
          label: 'Commit SEO changes',
        });
        const result = await runCommit(safeMessage, fixCwd, (chunk) => {
          updateActiveProcessStream(id, chunk);
          safeSend(JSON.stringify({ id, type: 'stream', content: chunk }));
        }, id, agentOptions);
        untrackProcess(id);
        safeSend(JSON.stringify({ id, type: 'result', data: result }));
        console.log(`Commit done in ${fixCwd}`);

      } else if (type === 'narrate') {
        stageProcessMetadata(id, {
          type: 'narrate',
          runtime: agentOptions.runtime,
          profile: agentOptions.profile,
          source: 'guild-ledger',
          projectPath: null,
          label: 'Narrate attack',
        });
        const result = await runAgent(command, (chunk) => {
          updateActiveProcessStream(id, chunk);
          safeSend(JSON.stringify({ id, type: 'stream', content: chunk }));
        }, undefined, id, agentOptions);
        untrackProcess(id);
        safeSend(JSON.stringify({ id, type: 'result', data: result }));
        console.log(`Narration done`);

      } else if (type === 'chat') {
        // Neutral pass-through - used outside of battle (Hall, Lodge,
        // between fights). Zero framing, zero demon context. Codex sees
        // exactly what the user typed and runs in their project directory.
        stageProcessMetadata(id, {
          type: 'chat',
          runtime: agentOptions.runtime,
          profile: agentOptions.profile,
          source: msg.source || 'guild-ledger',
          projectPath: fixCwd,
          label: 'Guild Ledger chat',
        });
        const result = await runAgent(command, (chunk) => {
          updateActiveProcessStream(id, chunk);
          safeSend(JSON.stringify({ id, type: 'stream', content: chunk }));
        }, fixCwd, id, agentOptions);
        untrackProcess(id);
        safeSend(JSON.stringify({ id, type: 'result', data: result }));
        console.log(`Chat done`);
      }
    } catch (err) {
      pendingProcessMetadata.delete(id);
      console.error(`Error on #${id}:`, err.message);
      safeSend(JSON.stringify({ id, type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    sessionClients.delete(ws);
    sessionClientMeta.delete(ws);
    releaseClaimsForOwner(connectionToken);
    // Kill only the processes launched by this browser connection. Other
    // clients may probe the bridge, refresh, or close without owning the
    // user's active turn.
    for (const [procId, proc] of activeProcesses.entries()) {
      if (activeProcessOwners.get(procId) !== connectionToken) continue;
      try {
        if (typeof proc.kill === 'function') proc.kill('SIGTERM');
      } catch (e) {}
      untrackProcess(procId);
    }
    console.log('Game client disconnected');
  });
});

/**
 * Check if a directory is a git repository.
 */
function isGitRepo(cwd) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure fixes run on a dedicated branch, not main.
 * Creates or switches to a date-stamped branch: seo-dungeon-fixes-YYYY-MM-DD
 * Returns the branch name on success, or null if branching was skipped.
 */
function ensureFixBranch(projectCwd) {
  try {
    if (!isGitRepo(projectCwd)) {
      console.log('  [branch] Not a git repo - skipping branch protection');
      return null;
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const branchName = `seo-dungeon-fixes-${today}`;

    // Check current branch
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectCwd,
      stdio: 'pipe'
    }).toString().trim();

    if (currentBranch === branchName) {
      console.log(`  [branch] Already on ${branchName}`);
      return branchName;
    }

    // Check if the branch already exists locally
    try {
      execFileSync('git', ['rev-parse', '--verify', branchName], {
        cwd: projectCwd,
        stdio: 'pipe'
      });
      // Branch exists - switch to it
      execFileSync('git', ['checkout', branchName], {
        cwd: projectCwd,
        stdio: 'pipe'
      });
      console.log(`  [branch] Switched to existing ${branchName}`);
    } catch {
      // Branch doesn't exist - create it
      execFileSync('git', ['checkout', '-b', branchName], {
        cwd: projectCwd,
        stdio: 'pipe'
      });
      console.log(`  [branch] Created and switched to ${branchName}`);
    }

    return branchName;
  } catch (err) {
    console.warn(`  [branch] Warning: could not set up fix branch - ${err.message}`);
    return null;
  }
}

/**
 * Run an SEO audit via Codex CLI.
 */
async function runAudit(domain, onStream, cwd, requestId, agentOptions) {
  const prompt = `Run /seo audit on ${domain}. This will trigger the full SEO audit skill which spawns multiple subagents for technical SEO, content quality, schema markup, performance, crawlability, images, and more.

After the audit completes, CONSOLIDATE the findings into actionable groups. Do NOT list every granular finding as a separate issue. Instead, group related problems that would be fixed together into a single issue. For example, all mobile responsiveness problems (touch targets, font sizes, overflow) become one issue. All missing meta tags become one issue. Aim for 8-15 total issues maximum - each one should represent a meaningful, distinct area of work.

ORDER THE ISSUES BY SEO IMPACT - the issue that would make the single biggest difference to search rankings and user experience goes first (id:1). The last issue should be the least impactful nice-to-have. Use severity labels that reflect this: "critical" for top-priority ranking killers, "high" for significant problems, "medium" for meaningful improvements, "low" for minor optimizations, "info" for best-practice suggestions.

Format as a single JSON object. Return ONLY valid JSON at the very end (no markdown fences): {"domain":"${domain}","score":<overall 0-100>,"totalIssues":<n>,"issues":[{"id":<n>,"severity":"<critical|high|medium|low|info>","title":"<clear actionable title>","description":"<what specifically is wrong and what needs to be fixed - include key details so the fix agent knows what to do>","category":"<category>","hp":<10-100 based on combined effort to fix all items in this group>}]}

Quality over quantity. Each issue should be a real battle worth fighting, not busywork.`;

  const raw = await runAgent(prompt, onStream, cwd, requestId, agentOptions);

  // Try to extract structured audit data from the agent response.
  const parsed = _tryParseAudit(raw, domain);
  if (parsed) return parsed;

  // RETRY: Ask the agent to reformat the raw output as JSON
  console.log('  First parse failed - retrying with reformat prompt...');
  logFailedAudit(domain, raw, 'first parse attempt failed');
  onStream('[Reformatting results...]');
  const rawText = typeof raw === 'string' ? raw : (raw.raw || JSON.stringify(raw));
  const retryPrompt = `The following is the raw output of an SEO audit on ${domain}. Convert it into a single valid JSON object with this exact structure (no markdown fences, no extra text - ONLY the JSON):
{"domain":"${domain}","score":<0-100>,"totalIssues":<n>,"issues":[{"id":<n>,"severity":"<critical|high|medium|low|info>","title":"<title>","description":"<description>","category":"<category>","hp":<10-100>}]}

Raw audit output:
${rawText.slice(-12000)}`;

  const retryRaw = await runAgent(retryPrompt, onStream, undefined, requestId, agentOptions);
  const retryParsed = _tryParseAudit(retryRaw, domain);
  if (retryParsed) return retryParsed;

  // Last resort: return a single issue so the game doesn't get stuck
  console.error('  Retry also failed - returning fallback issue');
  logFailedAudit(domain, retryRaw, 'retry parse attempt failed');
  return {
    domain,
    score: 50,
    totalIssues: 1,
    issues: [{
      id: 1, severity: 'high', title: 'SEO Audit Parse Error',
      description: 'The audit completed but the results could not be parsed into structured data. Try running the audit again.',
      category: 'General', hp: 30
    }]
  };
}

/**
 * Attempt to extract a valid audit JSON from agent output.
 * Returns the parsed object or null if extraction fails.
 */
function _tryParseAudit(raw, domain) {
  try {
    if (raw && raw.issues) return _normalizeAudit(raw, domain);

    const text = typeof raw === 'string' ? raw : (raw.raw || JSON.stringify(raw));

    // Try progressively looser JSON extraction
    const patterns = [
      /\{[\s\S]*"issues"\s*:\s*\[[\s\S]*\][\s\S]*\}/,  // Strict: must have "issues":[]
      /\{[\s\S]*\}/                                       // Loose: any JSON object
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed.issues && Array.isArray(parsed.issues)) {
          return _normalizeAudit(parsed, domain);
        }
      }
    }
  } catch (e) {
    console.error('  Parse attempt failed:', e.message);
  }
  return null;
}

function _normalizeAudit(parsed, domain) {
  parsed.issues = parsed.issues.map((issue, i) => ({
    id: issue.id || i + 1,
    severity: issue.severity || 'medium',
    title: issue.title || 'Unknown Issue',
    description: issue.description || 'No description',
    category: issue.category || 'General',
    hp: issue.hp || 50
  }));
  parsed.domain = parsed.domain || domain;
  parsed.score = parsed.score || 50;
  parsed.totalIssues = parsed.issues.length;
  return parsed;
}

/**
 * Fix a specific SEO issue via Codex CLI.
 * Runs inside the user's project directory so Codex can edit real files.
 */
/**
 * Build the demon-focus header that anchors every battle turn to the
 * selected SEO issue. Every available field (severity, category, URL,
 * selector, file, line, etc.) is included so Codex has full situational
 * awareness - even when the user's message is vague or conversational.
 */
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

/**
 * Run a battle turn against one demon.
 *
 * The demon-focus header anchors the turn. The user's message is
 * passed through verbatim - Codex reads their intent. No heuristic
 * mode switching: if they ask a question, Codex answers; if they
 * give a directive, Codex acts; if they're polite or ambiguous,
 * Codex figures it out. This matches how an agent normally handles
 * requests, just scoped to one SEO issue.
 *
 * @param {object} issue        Full issue object (title, description,
 *                              severity, category, url, selector, etc.).
 * @param {string} userMessage  What the user typed in the Attack input.
 *                              May be empty, a question, or a directive.
 */
async function runFix(issue, userMessage, projectCwd, onStream, requestId, agentOptions) {
  const header = buildDemonHeader(issue);
  const msg = (userMessage || '').trim();
  const userBlock = msg
    ? `USER'S MESSAGE THIS TURN\n------------------------\n${msg}`
    : `USER'S MESSAGE THIS TURN\n------------------------\n(empty - the user hit Attack without typing. Proceed with fixing what the demon above describes.)`;

  const prompt = `You are working in a website project directory.

${header}

${userBlock}

HOW TO RESPOND
--------------
Stay focused on the ONE demon above. Read the user's message and react
to it naturally:
  - If they asked a question, answer it - grounded in this demon and
    any project files you need to read to verify your answer.
  - If they gave a directive (including a polite one like "can you fix
    this"), do the work - edit the relevant source files to address
    the demon.
  - If the message is empty or ambiguous and looks like "just go",
    proceed to fix what the demon describes.
  - If it's genuinely unclear what they want, ask one short clarifying
    question instead of guessing.

Do NOT investigate unrelated SEO issues, even if you notice them - the
user will select those demons separately. Do NOT rewrite the entire
project. Make surgical changes for THIS demon only.

End your response with a single-line JSON summary so the battle scene
can score the turn:
  {"fixed":<true if you edited files, false otherwise>,"summary":"<one short sentence>","filesChanged":["<list of files you changed, or []>"]}`;

  const raw = await runAgent(prompt, onStream, projectCwd, requestId, agentOptions);

  try {
    const text = typeof raw === 'string' ? raw : (raw.raw || JSON.stringify(raw));
    const jsonMatch = text.match(/\{[\s\S]*"fixed"[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) { /* fall through */ }

  return { fixed: true, summary: 'The agent handled this turn.', filesChanged: [] };
}

/**
 * Commit current changes in the project.
 */
async function runCommit(message, projectCwd, onStream, requestId, agentOptions) {
  const prompt = `In this project directory, stage all changed files and create a git commit with this message: "${message}". Do NOT push. Return JSON: {"committed":true,"message":"<commit message>","hash":"<short hash>"}`;

  const raw = await runAgent(prompt, onStream, projectCwd, requestId, agentOptions);

  try {
    const text = typeof raw === 'string' ? raw : (raw.raw || JSON.stringify(raw));
    const jsonMatch = text.match(/\{[\s\S]*"committed"[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {}

  return { committed: true, message, hash: 'unknown' };
}

/**
 * Run the Codex CLI through the user's existing local login.
 * @param {string} prompt - The prompt to send
 * @param {function} onStream - Callback for streaming output
 * @param {string} [cwd] - Working directory (defaults to PROJECT_ROOT)
 */
function normalizeProfile(profile) {
  const key = String(profile || '').trim().toLowerCase();
  if (key === 'deep' || key === 'opus') return 'deep';
  if (key === 'fast' || key === 'haiku') return 'fast';
  return 'balanced';
}

function delegationEffortPhrase(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase().replace(/[\s_]+/g, '-');
  if (['xhigh', 'extra-high', 'extrahigh', 'maximum', 'max'].includes(key)) {
    return 'xhigh / maximum comparable effort';
  }
  if (key === 'high') return 'high effort';
  if (key === 'medium') return 'medium effort';
  if (key === 'low') return 'low effort';
  return raw ? `${raw} effort` : 'the selected profile effort';
}

function buildRuntimePolicy(runtime, profile) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const normalizedProfile = normalizeProfile(profile);
  const codexProfile = getCodexProfileConfig(normalizedProfile);
  const textProfile = normalizedRuntime === 'codex'
    ? null
    : getTextCliProfileConfig(normalizedRuntime, normalizedProfile);
  const strengthLabel = {
    deep: 'Warrior / extra-high',
    balanced: 'Samurai / high',
    fast: 'Knight / medium'
  }[normalizedProfile] || 'Samurai / high';
  const effortLabel = normalizedRuntime === 'codex'
    ? delegationEffortPhrase(codexProfile.effort)
    : ({
        deep: 'maximum comparable effort',
        balanced: 'high comparable effort',
        fast: 'medium comparable effort'
      }[normalizedProfile] || 'high comparable effort');
  const runtimeLine = normalizedRuntime === 'codex'
    ? '- Codex is the packaged default runtime. Use Codex-native skills, TOML profiles, and worker/subagent delegation when available.'
    : `- Codex is the packaged default runtime; this run is using ${normalizedRuntime} only because the user selected that local CLI. Stay grounded in the same skills, agents, and scripts.`;
  const detailLine = normalizedRuntime === 'codex'
    ? `- Selected strength: ${strengthLabel}; Codex effort is ${codexProfile.effort}.`
    : `- Selected strength: ${strengthLabel}; ${normalizedRuntime} model is ${textProfile?.model || 'the CLI default'}.`;

  const policy = [
    'Legends SEO Dungeon runtime policy:',
    runtimeLine,
    detailLine,
    `- Bundled SEO engine: ${PROJECT_ROOT}. For every upstream claude-seo command, use Python 3.10+ with the absolute entrypoint ${path.join(PROJECT_ROOT, 'scripts', 'runtime.py')} and the same arguments (doctor --json, setup, or run <script.py>). Quote paths for the current shell. Run doctor first; setup requires an explicit dependency-install request.`,
    `- Delegation strength rule: instruct any spawned audit worker/subagent to use ${effortLabel}. Do not let deep/xhigh runs fall back to default medium worker effort; if the runtime cannot set worker effort explicitly, put the effort requirement in the delegated prompt and run equivalent-depth specialist passes.`,
    '- Multi-agent audit default: for /seo audit or any substantial SEO audit, delegate in parallel where the runtime supports subagents/workers instead of doing one linear pass. Use the always-on audit workers seo-technical, seo-content, seo-schema, seo-sitemap, seo-performance, seo-visual, seo-geo, and seo-sxo, then add seo-google, seo-local, seo-maps, seo-backlinks, seo-cluster, seo-ecommerce, seo-drift, or extension agents when signals and credentials warrant.',
    '- Treat credentials in the selected project .env as the primary integration path.',
    '- Prefer direct scripts/APIs for DataForSEO, Firecrawl, Google Search Console, GA4, CrUX, and PageSpeed when credentials are present.',
    '- MCP servers are optional adapters. Use them quietly if already available, but do not require them, inventory them, or tell the user they are needed unless the user explicitly asks about MCP setup.',
    '- If an optional integration is unavailable, continue with available sources and mention the skipped data briefly only when it affects the result.'
  ];

  if (normalizedRuntime === 'codex') {
    policy.push(`- Codex delegation rule: when launching Codex subagents from this turn, explicitly request reasoning_effort=${codexProfile.effort} and pass the relevant specialist scope.`);
  }

  return policy.join('\n');
}

function runAgent(prompt, onStream, cwd, requestId, options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const profile = normalizeProfile(options.profile);
  const dangerousBypass = normalizeDangerousBypass(options.dangerousBypass);
  const policy = buildRuntimePolicy(runtime, profile);
  const effectivePrompt = `${policy}\n\n${prompt}`;
  if (runtime !== 'codex') {
    return runTextCli(runtime, effectivePrompt, onStream, cwd, requestId, profile, {
      connectionToken: options.connectionToken || null
    });
  }
  return runCodex(effectivePrompt, onStream, cwd, requestId, profile, {
    dangerousBypass,
    connectionToken: options.connectionToken || null,
    onStatus: options.onStatus
  });
}

function getCodexProfileConfig(profile) {
  const key = normalizeProfile(profile);
  const envSuffix = key.toUpperCase();
  const defaultEffort = { deep: 'xhigh', balanced: 'high', fast: 'medium' }[key];
  return {
    key,
    model: process.env[`SEO_DUNGEON_CODEX_MODEL_${envSuffix}`] || process.env.SEO_DUNGEON_CODEX_MODEL || '',
    effort: process.env[`SEO_DUNGEON_CODEX_EFFORT_${envSuffix}`] || defaultEffort,
  };
}

function buildCodexExecArgs({ cliArgs = [], prompt, workDir, profile, dangerousBypass }) {
  const codexProfile = getCodexProfileConfig(profile);
  if (!normalizeDangerousBypass(dangerousBypass)) {
    throw new Error('YOLO Mode must be armed before Legends SEO Dungeon can launch Codex.');
  }
  const args = [
    ...cliArgs,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox'
  ];

  args.push(
    '-c',
    `model_reasoning_effort="${codexProfile.effort}"`,
    '-C',
    workDir
  );
  if (codexProfile.model) args.push('-m', codexProfile.model);
  args.push('--', prompt);

  return { args, codexProfile };
}

function codexTextInput(text) {
  return [{ type: 'text', text: String(text || ''), text_elements: [] }];
}

function codexRpcErrorMessage(error) {
  if (!error) return 'Unknown Codex app-server error';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function detectCompactionPhaseFromText(value) {
  const text = String(value || '').toLowerCase();
  if (!/(auto[-\s]?compact|compaction|compacting|compressing context|context compression|summari[sz]ing context|context.*summari[sz])/i.test(text)) {
    return null;
  }
  return /(complete|completed|done|finished|finish|summari[sz]ed|compressed)/i.test(text)
    ? 'complete'
    : 'start';
}

function detectCompactionPhase(method, params = {}) {
  const parts = [
    method,
    params?.type,
    params?.phase,
    params?.state,
    params?.status,
    params?.event,
    params?.item?.type,
    params?.item?.status,
    params?.item?.phase
  ].filter(Boolean);
  const marker = parts.join(' ').toLowerCase();
  if (/(compact|compaction)/i.test(marker)) {
    return /(complete|completed|done|finished|end|ended|success)/i.test(marker)
      ? 'complete'
      : 'start';
  }
  return detectCompactionPhaseFromText(marker);
}

function compactionStatusMessage(phase) {
  return phase === 'complete'
    ? 'Context compaction complete. The hunt continues.'
    : 'Compacting context. Preserving the trail before the hunt continues.';
}

function summarizeCodexAppServerFailure(code, stderr) {
  const text = String(stderr || '').trim();
  if (!text) return `Codex app-server exited with code ${code}`;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .map((entry) => entry?.fields?.message || entry?.message)
    .filter(Boolean);
  return `Codex app-server exited with code ${code}: ${(parsed[parsed.length - 1] || lines[lines.length - 1] || text).slice(0, 500)}`;
}

function createCodexAppServerRun({ prompt, onStream, onStatus, workDir, requestId, profile, dangerousBypass, ownerToken = null }) {
  const { execPath: cliExec, args: cliArgs } = resolveCodexCli();
  const launch = resolveCliLaunch(cliExec);
  const codexProfile = getCodexProfileConfig(profile);
  const appArgs = [...launch.argsPrefix, ...cliArgs, 'app-server', '--stdio'];
  const launchDisplay = `${launch.display} app-server --stdio`;

  console.log(`  Running with codex app-server (profile: ${codexProfile.key}, effort: ${codexProfile.effort}${codexProfile.model ? `, model: ${codexProfile.model}` : ''}, bypass: ${dangerousBypass ? 'on' : 'off'})`);
  console.log(`  Executable: ${launchDisplay}`);
  console.log(`  CWD: ${workDir}`);

  const child = spawn(launch.command, appArgs, {
    cwd: workDir,
    env: safeEnv(workDir),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let nextRpcId = 1;
  let stdoutBuffer = '';
  let stderr = '';
  let fullText = '';
  let sawAgentDelta = false;
  let threadId = null;
  let turnId = null;
  let timeoutHandle = null;
  let settled = false;
  let agentStreamBuffer = '';
  let agentStreamTimer = null;
  let compactionActive = false;
  const pending = new Map();

  let settleResolve;
  let settleReject;
  const completion = new Promise((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });

  function cleanup() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (agentStreamTimer) {
      clearTimeout(agentStreamTimer);
      agentStreamTimer = null;
    }
    for (const [id, handlers] of pending.entries()) {
      handlers.reject(new Error('Codex app-server stopped before responding.'));
      pending.delete(id);
    }
    untrackProcess(requestId);
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }

  function settle(fn, value) {
    if (settled) return;
    settled = true;
    cleanup();
    fn(value);
  }

  function request(method, params = {}) {
    if (settled || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is no longer accepting requests.'));
    }
    const id = nextRpcId++;
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
  }

  function notify(method, params = {}) {
    if (settled || child.stdin.destroyed || !child.stdin.writable) return;
    child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForTurnReady(timeoutMs = 5000) {
    const started = Date.now();
    while (!settled && (!threadId || !turnId) && Date.now() - started < timeoutMs) {
      await delay(100);
    }
    if (settled) {
      throw new Error('Codex turn already ended.');
    }
    if (!threadId || !turnId) {
      throw new Error('Codex turn is still starting and cannot be steered yet.');
    }
  }

  function shouldFlushAgentBuffer(text) {
    if (!text) return false;
    if (text.includes('\n') || text.includes('\r')) return true;
    const cleanLength = text.replace(/\s+/g, ' ').trim().length;
    if (cleanLength >= 1000) return true;
    if (cleanLength >= 220 && /[\s,;:)}\]"']$/.test(text)) return true;
    return /[.!?)]["']?\s$/.test(text);
  }

  function flushAgentStream({ force = false } = {}) {
    if (agentStreamTimer) {
      clearTimeout(agentStreamTimer);
      agentStreamTimer = null;
    }
    const clean = agentStreamBuffer.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) {
      agentStreamBuffer = '';
      return;
    }
    if (!force && !shouldFlushAgentBuffer(agentStreamBuffer)) return;
    agentStreamBuffer = '';
    onStream(clean);
  }

  function scheduleAgentFlush() {
    if (agentStreamTimer) return;
    agentStreamTimer = setTimeout(() => {
      agentStreamTimer = null;
      const cleanLength = agentStreamBuffer.replace(/\s+/g, ' ').trim().length;
      if (
        shouldFlushAgentBuffer(agentStreamBuffer) ||
        (cleanLength >= 400 && /[\s,;:)}\]"']$/.test(agentStreamBuffer))
      ) {
        flushAgentStream({ force: true });
      } else if (agentStreamBuffer) {
        scheduleAgentFlush();
      }
    }, 1200);
  }

  function enqueueAgentDelta(text) {
    const value = String(text || '');
    if (!value) return;
    fullText += value;
    agentStreamBuffer += value;
    if (shouldFlushAgentBuffer(agentStreamBuffer)) {
      flushAgentStream({ force: true });
      return;
    }
    scheduleAgentFlush();
  }

  function streamText(text) {
    const phase = detectCompactionPhaseFromText(text);
    if (phase) emitCompactionStatus(phase);
    enqueueAgentDelta(text);
  }

  function emitCompactionStatus(phase) {
    if (phase === 'start') {
      if (compactionActive) return;
      compactionActive = true;
    } else {
      if (!compactionActive) return;
      compactionActive = false;
    }
    if (typeof onStatus === 'function') {
      onStatus({
        kind: 'compaction',
        phase,
        message: compactionStatusMessage(phase)
      });
    }
  }

  function handleItemCompleted(item) {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'agentMessage') {
      if (!sawAgentDelta && item.text) streamText(item.text);
      return;
    }
    if (item.type === 'commandExecution') {
      flushAgentStream({ force: true });
      const label = item.command ? `command: ${String(item.command).slice(0, 90)}` : 'command';
      onStream(`[${label}]`);
      return;
    }
    if (item.type === 'mcpToolCall') {
      flushAgentStream({ force: true });
      const label = [item.server, item.tool].filter(Boolean).join('/') || 'mcp tool';
      onStream(`[${label}]`);
      return;
    }
    if (item.type === 'dynamicToolCall') {
      flushAgentStream({ force: true });
      onStream(`[${item.tool || 'tool'}]`);
    }
  }

  function handleNotification(method, params = {}) {
    const compactionPhase = detectCompactionPhase(method, params);
    if (compactionPhase) {
      emitCompactionStatus(compactionPhase);
    }
    if (method === 'item/agentMessage/delta') {
      sawAgentDelta = true;
      streamText(params.delta || '');
      return;
    }
    if (method === 'item/completed') {
      handleItemCompleted(params.item);
      return;
    }
    if (method === 'turn/started' && params.turn?.id) {
      turnId = params.turn.id;
      return;
    }
    if (method === 'turn/completed') {
      const completedTurn = params.turn || {};
      const status = completedTurn.status;
      flushAgentStream({ force: true });
      if (compactionActive) emitCompactionStatus('complete');
      if (status === 'completed') {
        onStream('[Complete]');
        settle(settleResolve, { raw: fullText });
      } else if (status === 'interrupted') {
        settle(settleReject, new Error('Cancelled by user'));
      } else {
        const message = completedTurn.error?.message || `Codex turn ${status || 'failed'}`;
        settle(settleReject, new Error(message));
      }
      return;
    }
    if (method === 'error' && params.error?.message && !params.willRetry) {
      settle(settleReject, new Error(params.error.message));
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (message.id && pending.has(message.id)) {
        const handlers = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          handlers.reject(new Error(codexRpcErrorMessage(message.error)));
        } else {
          handlers.resolve(message.result);
        }
      } else if (message.method) {
        handleNotification(message.method, message.params || {});
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (err) => {
    settle(settleReject, createSpawnError('codex app-server', err, launch));
  });

  child.on('close', (code) => {
    if (settled) return;
    const message = code === 0
      ? 'Codex app-server closed before the turn completed.'
      : summarizeCodexAppServerFailure(code, stderr);
    settle(settleReject, new Error(message));
  });

  const run = {
    get threadId() { return threadId; },
    get turnId() { return turnId; },
    child,
    async start() {
      timeoutHandle = setTimeout(() => {
        this.kill('SIGTERM');
        settle(settleReject, new Error('Operation timed out after 15 minutes.'));
      }, 15 * 60 * 1000);

      await request('initialize', {
        clientInfo: { name: 'seo-dungeon', version: '2.2' },
        capabilities: { experimentalApi: true }
      });
      notify('initialized', {});

      const threadResponse = await request('thread/start', {
        cwd: workDir,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: true,
        threadSource: 'seo-dungeon',
        model: codexProfile.model || null
      });
      threadId = threadResponse?.thread?.id;
      if (!threadId) throw new Error('Codex app-server did not return a thread id.');

      const turnParams = {
        threadId,
        cwd: workDir,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        effort: codexProfile.effort,
        input: codexTextInput(prompt)
      };
      if (codexProfile.model) turnParams.model = codexProfile.model;
      const turnResponse = await request('turn/start', turnParams);
      turnId = turnResponse?.turn?.id || turnId;
      if (!turnId) throw new Error('Codex app-server did not return a turn id.');
      return completion;
    },
    steer(text) {
      return (async () => {
        await waitForTurnReady();
        const params = {
          threadId,
          expectedTurnId: turnId,
          input: codexTextInput(text)
        };
        let lastError;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            const result = await request('turn/steer', params);
            return {
              ...(result || {}),
              targetId: requestId,
              threadId,
              turnId,
              mode: 'codex-app-server'
            };
          } catch (err) {
            lastError = err;
            const message = String(err.message || '');
            if (!/no active turn|active turn|expected turn|not steerable/i.test(message) || settled) {
              break;
            }
            await delay(250);
          }
        }
        throw lastError || new Error('Could not steer active Codex turn.');
      })();
    },
    kill(signal = 'SIGTERM') {
      if (threadId && turnId && !settled) {
        request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill(signal); } catch {}
        }
      }, 250);
      if (!settled) settle(settleReject, new Error('Cancelled by user'));
    }
  };

  trackProcess(requestId, run, ownerToken);
  return run;
}

function runCodexAppServer(prompt, onStream, cwd, requestId, profile, options = {}) {
  const workDir = cwd || PROJECT_ROOT;
  const dangerousBypass = normalizeDangerousBypass(options.dangerousBypass);
  if (!dangerousBypass) {
    throw new Error('YOLO Mode must be armed before Legends SEO Dungeon can launch Codex.');
  }
  const run = createCodexAppServerRun({
    prompt,
    onStream,
    onStatus: options.onStatus,
    workDir,
    requestId,
    profile,
    dangerousBypass,
    ownerToken: options.connectionToken || null
  });
  return run.start().catch((err) => {
    try {
      if (run.child && !run.child.killed) run.child.kill('SIGTERM');
    } catch {}
    untrackProcess(requestId);
    throw err;
  });
}

const DEFAULT_TEXT_CLI_MODELS = {
  claude: {
    deep: 'opus',
    balanced: 'sonnet',
    fast: 'haiku',
  },
  gemini: {
    deep: 'pro',
    balanced: 'flash',
    fast: 'flash-lite',
  },
  // Use the model selected in the user's official Grok CLI account.
  grok: { deep: '', balanced: '', fast: '' },
};

function getTextCliProfileConfig(runtime, profile) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const key = normalizeProfile(profile);
  const runtimeEnv = normalizedRuntime.toUpperCase();
  const profileEnv = key.toUpperCase();
  const configuredModel =
    process.env[`SEO_DUNGEON_${runtimeEnv}_MODEL_${profileEnv}`] ??
    process.env[`SEO_DUNGEON_${runtimeEnv}_MODEL`] ??
    DEFAULT_TEXT_CLI_MODELS[normalizedRuntime]?.[key] ??
    '';
  const model = /^(auto|default|none)$/i.test(String(configuredModel)) ? '' : configuredModel;
  const effort = normalizedRuntime === 'grok'
    ? (process.env[`SEO_DUNGEON_GROK_EFFORT_${profileEnv}`] ||
       { deep: 'high', balanced: 'high', fast: 'medium' }[key])
    : '';
  return { key, model, effort };
}

function resolveGrokCli() {
  if (process.env.SEO_DUNGEON_GROK_CLI) return process.env.SEO_DUNGEON_GROK_CLI;
  // The official installer uses this location. Prefer it over unrelated npm
  // packages also named "grok", without depending on shell-profile aliases.
  const home = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
  const binary = path.join(home, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  return fs.existsSync(binary) ? binary : 'grok';
}

function resolveTextCli(runtime) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const runtimeEnv = normalizedRuntime.toUpperCase();
  const execPath = normalizedRuntime === 'grok' ? resolveGrokCli()
    : process.env[`SEO_DUNGEON_${runtimeEnv}_CLI`] || normalizedRuntime;
  const defaultArgs = normalizedRuntime === 'claude'
    ? ['--print', '--output-format', 'text', '--permission-mode', 'acceptEdits']
    : normalizedRuntime === 'grok'
      ? ['--single', '{{prompt}}', '--output-format', 'plain', '--permission-mode', 'acceptEdits']
      : ['--prompt', '{{prompt}}', '--output-format', 'text', '--approval-mode', 'auto_edit'];
  const args = process.env[`SEO_DUNGEON_${runtimeEnv}_ARGS`]
    ? splitArgs(process.env[`SEO_DUNGEON_${runtimeEnv}_ARGS`])
    : defaultArgs;
  return { execPath, args };
}

function insertPromptArg(args, prompt) {
  let inserted = false;
  const finalArgs = args.map((arg) => {
    if (arg === '{{prompt}}') {
      inserted = true;
      return prompt;
    }
    return arg;
  });
  if (!inserted) {
    if (!finalArgs.includes('--')) finalArgs.push('--');
    finalArgs.push(prompt);
  }
  return finalArgs;
}

function runTextCli(runtime, prompt, onStream, cwd, requestId, profile, options = {}) {
  const normalizedRuntime = normalizeRuntime(runtime);
  const workDir = cwd || PROJECT_ROOT;
  return new Promise((resolve, reject) => {
    const { execPath: cliExec, args: cliArgs } = resolveTextCli(normalizedRuntime);
    const launch = resolveCliLaunch(cliExec);
    const cliProfile = getTextCliProfileConfig(normalizedRuntime, profile);
    const args = [...cliArgs];
    if (cliProfile.model) args.push('--model', cliProfile.model);
    if (cliProfile.effort) args.push('--reasoning-effort', cliProfile.effort);
    const finalArgs = insertPromptArg(args, prompt);
    const launchArgs = [...launch.argsPrefix, ...finalArgs];

    console.log(`  Running with ${normalizedRuntime} CLI (profile: ${cliProfile.key}${cliProfile.model ? `, model: ${cliProfile.model}` : ', default model'})`);
    console.log(`  Executable: ${launch.display}`);
    console.log(`  CWD: ${workDir}`);
    const proc = spawn(launch.command, launchArgs, {
      cwd: workDir,
      env: safeEnv(workDir),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    trackProcess(requestId, proc, options.connectionToken || null);

    let fullText = '';
    let lineBuffer = '';
    let stderr = '';
    let settled = false;
    let timeoutHandle;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      untrackProcess(requestId);
      fn(value);
    };

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      fullText += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onStream(trimmed);
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      const trimmed = text.trim();
      if (trimmed && !/^\[?debug\]?/i.test(trimmed)) onStream(trimmed);
    });

    proc.on('close', (code) => {
      if (lineBuffer.trim()) onStream(lineBuffer.trim());
      console.log(`  ${normalizedRuntime} CLI finished (exit ${code}), ${fullText.length} chars`);
      if (code !== 0) {
        console.error(`  ${normalizedRuntime} CLI stderr: ${stderr || fullText}`);
        settle(reject, new Error(summarizeCliFailure(normalizedRuntime, code, stderr, fullText)));
        return;
      }
      try {
        settle(resolve, JSON.parse(fullText));
      } catch {
        settle(resolve, { raw: fullText });
      }
    });

    proc.on('error', (err) => {
      settle(reject, createSpawnError(normalizedRuntime, err, launch));
    });

    const MAX_RUNTIME_MS = 15 * 60 * 1000;
    timeoutHandle = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      settle(reject, new Error('Operation timed out after 15 minutes.'));
    }, MAX_RUNTIME_MS);
  });
}

function runCodexExec(prompt, onStream, cwd, requestId, profile, options = {}) {
  const workDir = cwd || PROJECT_ROOT;
  return new Promise((resolve, reject) => {
    const { execPath: cliExec, args: cliArgs } = resolveCodexCli();
    const launch = resolveCliLaunch(cliExec);
    const dangerousBypass = normalizeDangerousBypass(options.dangerousBypass);
    const { args, codexProfile } = buildCodexExecArgs({
      cliArgs,
      prompt,
      workDir,
      profile,
      dangerousBypass
    });
    const launchArgs = [...launch.argsPrefix, ...args];

    console.log(`  Running with codex exec (profile: ${codexProfile.key}, effort: ${codexProfile.effort}${codexProfile.model ? `, model: ${codexProfile.model}` : ''}, bypass: ${dangerousBypass ? 'on' : 'off'})`);
    console.log(`  Executable: ${launch.display}`);
    console.log(`  CWD: ${workDir}`);
    const proc = spawn(launch.command, launchArgs, {
      cwd: workDir,
      env: safeEnv(workDir),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    trackProcess(requestId, proc, options.connectionToken || null);

    let fullText = '';
    let buffer = '';
    let stderr = '';
    let settled = false;
    let timeoutHandle;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      untrackProcess(requestId);
      fn(value);
    };

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item) {
            const item = event.item;
            if (item.type === 'agent_message' && item.text) {
              fullText += item.text;
              for (const textLine of item.text.split('\n').filter(l => l.trim())) {
                onStream(textLine.trim());
              }
            } else if (item.type && item.type.includes('tool')) {
              onStream(`[${item.name || item.type}]`);
            }
          } else if (event.type === 'turn.completed') {
            onStream('[Complete]');
          }
        } catch {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('{')) onStream(trimmed);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
            fullText += event.item.text;
          }
        } catch {}
      }

      console.log(`  Codex finished (exit ${code}), ${fullText.length} chars`);
      if (code !== 0) {
        console.error(`  Codex stderr: ${stderr}`);
        settle(reject, new Error(summarizeCliFailure('Codex', code, stderr, fullText)));
        return;
      }
      try {
        settle(resolve, JSON.parse(fullText));
      } catch {
        settle(resolve, { raw: fullText });
      }
    });

    proc.on('error', (err) => {
      settle(reject, createSpawnError('codex', err, launch));
    });

    const MAX_RUNTIME_MS = 15 * 60 * 1000;
    timeoutHandle = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      settle(reject, new Error('Operation timed out after 15 minutes.'));
    }, MAX_RUNTIME_MS);
  });
}

function runCodex(prompt, onStream, cwd, requestId, profile, options = {}) {
  if (/^exec$/i.test(String(process.env.SEO_DUNGEON_CODEX_TRANSPORT || ''))) {
    return runCodexExec(prompt, onStream, cwd, requestId, profile, options);
  }
  return runCodexAppServer(prompt, onStream, cwd, requestId, profile, options);
}

function startBridge() {
  installConsoleFileLogger();
  loadPersistedSessionEvents();
  // Catch crashes only in the live bridge. Tests import this module and should
  // fail normally instead of being swallowed by global handlers.
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (server stays alive):', err.message);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection (server stays alive):', err.message || err);
  });

  console.log('Legends SEO Dungeon - Bridge Server');
  console.log('─'.repeat(40));
  console.log(`Bridge log: ${BRIDGE_LOG_FILE}`);
  listenWithFallback(DEFAULT_PORT);
}

function listenWithFallback(port, attemptsLeft = 24) {
  const onError = (err) => {
    server.off('listening', onListening);
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0 && !STRICT_PORT) {
      const nextPort = port + 1;
      console.warn(`Bridge port ${port} is busy; trying ${nextPort}.`);
      setTimeout(() => listenWithFallback(nextPort, attemptsLeft - 1), 80);
      return;
    }
    console.error(`Bridge failed to listen on port ${port}:`, err.message);
    process.exitCode = 1;
  };
  const onListening = () => {
    server.off('error', onError);
    PORT = port;
    console.log(`Bridge listening on ws://127.0.0.1:${PORT} (localhost only)`);
    console.log(`Agent provider: ${resolveAgentProvider()}`);
    console.log(`Agent runs from: ${PROJECT_ROOT}`);
    console.log('─'.repeat(40));
    if (typeof process.send === 'function') {
      try { process.send({ type: 'bridge-ready', port: PORT }); } catch (_) {}
    }
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}

if (require.main === module) startBridge();

module.exports = {
  normalizeRuntime,
  normalizeProfile,
  normalizeDangerousBypass,
  splitArgs,
  resolveCliLaunch,
  resolveCodexCli,
  resolveTextCli,
  buildCodexExecArgs,
  runCodex,
  runAgent,
  runTextCli,
  getCodexProfileConfig,
  getTextCliProfileConfig,
  buildRuntimePolicy,
  insertPromptArg,
  getBridgeCapabilities,
  steerActiveProcess,
  safeEnv,
  validateProjectPath,
  folderPickerStartPath,
  revealOrPickProjectPath,
  isAllowedOrigin,
  redactSensitiveText,
  startBridge
};
