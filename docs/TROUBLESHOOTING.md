# Troubleshooting

## Dungeon App

### The dungeon is unreachable

Start the bridge from the app folder:

```bash
cd dungeon
npm run server
```

For normal development, run both the bridge and game:

```bash
cd dungeon
npm run dev
```

The game runs on [http://localhost:3002](http://localhost:3002). The bridge
listens on `ws://127.0.0.1:3003`.

### The page loads but the bridge stays disconnected

Check that no other process is already using port `3003`:

```powershell
netstat -ano | findstr :3003
```

Stop the conflicting process or set a different port in the bridge server before
starting the app.

### The app starts but the build fails

Use Node.js 22+ and refresh dependencies:

```bash
cd dungeon
node --version
npm install
npm run build
```

## Runtime Picker

### Codex fails to spawn

Confirm the CLI is installed and authenticated:

```bash
codex --version
```

On Windows, Legends SEO Dungeon resolves local `.cmd`, `.bat`, and `.exe` shims
directly to their Node or binary entrypoints before launching the CLI. If you still see `spawn EPERM`, point the bridge at a
specific executable or shim:

If Codex is installed in a non-standard path, set:

```powershell
$env:SEO_DUNGEON_CODEX_CLI='C:\path\to\codex.exe'
```

### Claude fails to spawn

Confirm Claude Code is available on `PATH`:

```bash
claude --version
```

The bridge default is:

```text
claude --print --output-format text --permission-mode acceptEdits <prompt>
```

Override the CLI or argument template when needed:

```powershell
$env:SEO_DUNGEON_CLAUDE_CLI='C:\path\to\claude.exe'
$env:SEO_DUNGEON_CLAUDE_ARGS='--print --output-format text --permission-mode acceptEdits'
```

### Gemini fails to spawn

Confirm Gemini CLI is available on `PATH`:

```bash
gemini --version
```

If Gemini reports `GEMINI_API_KEY` is required, configure Gemini CLI auth or set:

```powershell
$env:GEMINI_API_KEY='your-key'
```

The bridge default is:

```text
gemini --prompt {{prompt}} --output-format text --approval-mode auto_edit
```

Override the CLI or argument template when needed:

```powershell
$env:SEO_DUNGEON_GEMINI_CLI='C:\path\to\gemini.cmd'
$env:SEO_DUNGEON_GEMINI_ARGS='--prompt {{prompt}} --output-format text --approval-mode auto_edit'
```

### Selected model is unavailable

Each runtime profile has environment overrides. Set a model variable to a model
your account can access, or set it to `default`, `auto`, or `none` to let the CLI
choose.

```powershell
$env:SEO_DUNGEON_CLAUDE_MODEL_DEEP='opus'
$env:SEO_DUNGEON_GEMINI_MODEL_DEEP='pro'
```

## SEO Skills

### Skills not found by Codex

Run the root installer:

```bash
python scripts/runtime.py install-codex
```

Then restart Codex so it reloads skills and agents.

### Python dependency import errors

Install the runtime dependencies:

```bash
python -m pip install -r requirements.txt
```

If the root installer already ran, it also copied `requirements.txt` into the
installed `seo` skill directory.

### URL fetches fail

Legends SEO Dungeon uses SSRF-safe fetchers. Private IPs, loopback hosts, and metadata
endpoints are blocked intentionally. Use a public test URL or run the relevant
script against local files.

### Google API commands fail

Run:

```text
/seo google setup
```

Credentials are optional. The core audit works without Google API keys, but
PageSpeed, CrUX, Search Console, GA4, and Ads Keyword Planner features need the
corresponding credential tier.

### Drift baseline not found

Create a baseline first:

```text
/seo drift baseline https://example.com
```

Then compare later:

```text
/seo drift compare https://example.com
```

## Debug Artifacts

Live bridge logs are mirrored to:

```text
dungeon/.logs/bridge.log
```

Watch them while testing the app:

```bash
cd dungeon
npm run logs
```

Failed audit parsing writes evidence files under:

```text
dungeon/.logs/
```

Generated audit outputs should stay inside the explicit audit output directory
or project folder selected in the app.
