# Installation

Legends SEO Dungeon has two installation surfaces:

- Codex skill installation through `python scripts/runtime.py install-codex` or `install.sh`.
- The local dungeon app under `dungeon/`, which starts a Phaser UI and a
  localhost WebSocket bridge.

The packaged app selects Codex by default. Claude Code, Gemini CLI, and xAI's
official Grok CLI are available in the same picker when installed and signed in.
See [runtime setup](RUNTIMES.md) for provider-specific requirements and [release readiness](RELEASE-READINESS.md) for verification checks.

## Requirements

- Python 3.11+
- Node.js 22.12+ for the dungeon app
- At least one supported CLI installed and authenticated with your own account
- Internet access for the initial dependency install and hosted model/API calls
- Git only if cloning or using the standalone remote installer; a full source
  ZIP can be installed without Git

## Start From A Source ZIP

Extract the complete release source ZIP, then open a terminal in its root folder.
Do not run the installers inside an archive preview. Install the isolated SEO
engine environment:

```bash
python scripts/runtime.py setup
python scripts/runtime.py doctor --json
```

On Windows, use `py -3` instead of `python` if that is your installed launcher.
Setup installs Python dependencies and browser support locally for this engine.
If browser installation is incomplete, the core engine can still run; doctor
reports the missing capability.

Start the app:

```bash
cd dungeon
npm ci
npm start
```

`npm start` builds the game if needed and serves it with the installed local
server dependency. Open the localhost URL it prints. The usual UI port is 3002
and bridge port is 3003; occupied ports are handled automatically. Keep the
launcher running, and press Ctrl+C to stop its app and bridge. Development work
can use `npm run dev` instead.

Enter your own domain and project directory. No customer site or maintainer
project is preselected. Select your installed CLI. The game can use the
repository-local engine without a global Codex skill installation.

## Optional Codex Skill Installation

For `/seo` commands in Codex sessions outside the game, run the root installer
from the extracted checkout:

```bash
python scripts/runtime.py install-codex
```

```bash
bash install.sh
```

The installer copies `skills/` into the Codex skills directory and
`agents-codex/*.toml` into the Codex agents directory. Shared runtime files,
schema templates, hooks, and extensions are installed under the SEO skill.
Set `CODEX_HOME` before running if you use a custom Codex home.

The public repository is `https://github.com/avalonreset/legends-seo-dungeon`.
Clone it without GitHub authentication, or download the latest release ZIP:

```bash
git clone https://github.com/avalonreset/legends-seo-dungeon.git
```

A standalone copy of the installer downloads from this repository's `main`
branch. `SEO_DUNGEON_REPO` and `SEO_DUNGEON_REF` can select
another source repository and explicit branch or tag. These overrides
apply to remote downloads; a complete local checkout is always used directly.

The title screen requires YOLO Mode to be armed on every fresh app launch. The
choice is intentionally not persisted. Once the dungeon is running, the Guild
Ledger can queue follow-up prompts or promote one to run next after the active
agent turn settles.

For live development visibility, keep a second terminal open:

```bash
cd dungeon
npm run logs
```

The bridge mirrors startup, runtime selection, CLI executable paths, child
exits, and errors to `dungeon/.logs/bridge.log`.

## Codex Remote Control

When the app and bridge are running, Codex can use the local helper to drive the
browser-owned setup and Guild Ledger paths:

```powershell
cd dungeon
npm run remote -- status --json
npm run remote -- event --wait --timeout 30000 --kind ui-intent --action launch --domain example.com --project /path/to/your/project --runtime codex --profile fast --character knight --dangerous-bypass --meta source=codex-helper
npm run remote -- send --wait --timeout 120000 --project /path/to/your/project --profile fast --dangerous-bypass -- "/seo page https://example.com"
npm run remote -- watch --kind ledger-result --filter-source guild-ledger --count 1 --timeout 30000
```

The helper talks to the localhost WebSocket bridge. It does not automate the
Codex desktop composer; the browser applies `ui-intent` setup/start actions and
the Guild Ledger claims `send` commands through the normal Codex app-server
runtime.

To record browser-side structured intent proof:

```powershell
cd dungeon
npm run demo:remote-intents -- --keep-open-ms 100
```

To record a full Windows desktop capture:

```powershell
cd dungeon
npm run proof:desktop-intents -- --fake-codex --keep-open-ms 100 --allow-foreground-mismatch
```

The fake proof mode is for interface regression checks. An authenticated CLI
run is separate proof of model execution. Review recordings and generated
logs before sharing them because they may show domains, paths, and findings.

## Runtime Selection

The title screen includes a local CLI selector:

| Runtime | Bridge command | Profile mapping |
|---------|----------------|-----------------|
| Codex | `codex app-server --stdio` by default; `codex exec --json` only when `SEO_DUNGEON_CODEX_TRANSPORT=exec` | Warrior `xhigh`, Samurai `high`, Knight `medium` |
| Claude | `claude --print` | Warrior `opus`, Samurai `sonnet`, Knight `haiku` |
| Gemini | `gemini --prompt` | Warrior `pro`, Samurai `flash`, Knight `flash-lite` |
| Grok | `grok --single` with plain output | Warrior/Samurai `high`, Knight `medium` reasoning; account-configured model |

Useful overrides:

```powershell
$env:SEO_DUNGEON_RUNTIME='codex'
$env:SEO_DUNGEON_CODEX_MODEL='default'
$env:SEO_DUNGEON_CLAUDE_MODEL_BALANCED='sonnet'
$env:SEO_DUNGEON_GEMINI_MODEL_BALANCED='flash'
```

Set a model variable to `default`, `auto`, or `none` to let that CLI use its own
configured default.

## Portable Usage

Compatible terminal agents can read `skills/`, `agents/`, and `scripts/`
directly from the repository. Before shipping changes to frontmatter or agent
prompts, run:

```bash
python scripts/portability_check.py --strict
```

## Uninstall

Remove the installed Codex SEO skills and agent profiles from your Codex home:

```bash
python scripts/runtime.py uninstall-codex
```

```bash
bash uninstall.sh
```
