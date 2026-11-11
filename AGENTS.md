# Legends SEO Dungeon: Multi-Agent Instructions

Legends SEO Dungeon combines the
v2.2.7 SEO engine, a Codex-default 16-bit dungeon crawler UI, portable SEO skill
instructions, and Codex-first agent profiles.

## Overview

The current bundle has 25 sub-skills (21 core + 1 orchestrator + 1 framework
integration + 2 extension mirrors), 23 Codex TOML profiles, 18 portable Markdown
agent prompts, and 53 upstream Python modules plus 2 Dungeon API adapters for fetching, parsing, reporting,
and SEO data integrations.

## Runtime Policy

- Default dungeon runtime: Codex CLI through `codex app-server --stdio`.
  Set `SEO_DUNGEON_CODEX_TRANSPORT=exec` only when deliberately testing the
  older `codex exec --json` transport.
- Optional dungeon runtimes: local Claude Code through `claude --print`,
  Gemini CLI through `gemini --prompt`, and xAI Grok through `grok --single`.
- The bridge must only spawn local terminal CLIs. Do not add consumer-app browser
  wrappers or remote proxy services.
- Codex installs use the root installer and `agents-codex/` TOML profiles.
- Non-Codex usage should stay grounded in the same skill files, scripts, and
  URL-safety rules instead of inventing runtime-specific forks.
- Use the repository checkout as the working source directory. Resolve paths
  relative to that checkout; never assume a maintainer-specific installation.

## Quick Reference

| Command | What it does |
|---------|-------------|
| `/seo audit <url>` | Full website audit with parallel subagent delegation |
| `/seo page <url>` | Deep single-page analysis |
| `/seo technical <url>` | Technical SEO audit (9 categories) |
| `/seo content <url>` | E-E-A-T and content quality analysis |
| `/seo schema <url>` | Schema.org detection, validation, generation |
| `/seo sitemap <url>` | XML sitemap analysis or generation |
| `/seo images <url>` | Image SEO: on-page audit, SERP analysis, file optimization |
| `/seo geo <url>` | AI Overviews / Generative Engine Optimization |
| `/seo plan <type>` | Strategic SEO planning |
| `/seo cluster <keyword>` | SERP-based semantic clustering and content architecture |
| `/seo sxo <url>` | Search Experience Optimization: page-type analysis, personas |
| `/seo drift baseline <url>` | Capture SEO baseline for change monitoring |
| `/seo drift compare <url>` | Compare current state to stored baseline |
| `/seo ecommerce <url>` | E-commerce SEO: product schema, marketplace intelligence |
| `/seo programmatic [url]` | Programmatic SEO at scale |
| `/seo competitor-pages [url]` | Competitor comparison pages |
| `/seo local <url>` | Local SEO analysis (GBP, citations, reviews) |
| `/seo maps [cmd] [args]` | Maps intelligence (geo-grid, GBP audit, competitors) |
| `/seo hreflang <url>` | Hreflang/i18n SEO audit, cultural profiles, content parity |
| `/seo google [cmd] [url]` | Google SEO APIs (GSC, PageSpeed, CrUX, Indexing, GA4) |
| `/seo backlinks <url>` | Backlink profile analysis |
| `/seo dataforseo [cmd]` | Live SEO data via DataForSEO (extension) |
| `/seo image-gen [use-case]` | AI image generation for SEO assets (extension) |
| `/seo firecrawl [cmd] <url>` | Full-site crawling and site mapping (extension) |
| `/seo ahrefs [cmd] <target>` | Ahrefs backlink and keyword data (extension) |
| `/seo bing [cmd] <url>` | Bing Webmaster data and IndexNow (extension) |
| `/seo profound [cmd]` | LLM brand-citation tracking (extension) |
| `/seo seranking [cmd]` | AI share-of-voice tracking (extension) |
| `/seo unlighthouse <url>` | Multi-page Lighthouse audits (extension) |

## Architecture

```
skills/                    # 25 sub-skills
  seo/SKILL.md             # Main orchestrator + routing
agents/                    # Portable Markdown agent prompts
agents-codex/              # 23 Codex TOML agent profiles
scripts/                   # Python execution scripts
schema/                    # JSON-LD templates
extensions/                # Optional SEO data/crawl add-ons
dungeon/                   # Phaser UI + local CLI bridge
```

## Portability Notes

Codex is the default runtime for Legends SEO Dungeon. The browser app can also
spawn local Claude Code, Gemini CLI, or Grok CLI when selected, and compatible terminal
agent workflows such as Cursor, Cline, Aider, and Antigravity can read the same
`skills/`, `agents/`, and `scripts/` files directly when a user chooses to adapt
the package outside the dungeon UI.

Run `python scripts/portability_check.py --strict` before shipping changes that
touch skill frontmatter, agent prompts, or extension mirrors.

| Tool name | Codex | Cline | Aider | Portable note |
|-----------|-------|-------|-------|---------------|
| Read | read files directly | read files directly | read files directly | Use repo-relative paths. |
| Write | edit files directly | edit files directly | edit files directly | Keep generated files in the repo or explicit output folders. |
| Edit | patch files directly | patch files directly | patch files directly | Prefer small, reviewable edits. |
| Bash | shell command | shell command | shell command | Preserve URL-safety and credential rules. |
| WebFetch | browser or fetch script | browser or fetch script | browser or fetch script | Use `scripts/url_safety.py` guarded fetch paths for live URLs. |

## Key Principles

1. Keep the game bridge Codex-powered and the SEO engine portable.
2. Prefer existing skill and script patterns over new abstractions.
3. Preserve SSRF protections in scripts that fetch URLs.
4. Keep user-facing copy clear that Legends SEO Dungeon is independent and
   Codex-first, with portable source and user-selected local runtimes.

## Bundled engine runtime

The engine is pinned to public Claude SEO v2.2.7 plus public maintenance;
see `docs/UPSTREAM-SEO-AUDIT-2026-09-06.md`. Game/package versions follow the
bundled public Claude SEO release; Dungeon-only fixes are identified by commits.
From this repository, every upstream `claude-seo` invocation can be run as
`python scripts/runtime.py` with the same arguments. Use the absolute path to
this repository's `scripts/runtime.py` when auditing another working directory.
Use `doctor --json` to inspect readiness, `setup` for explicit installation, and
`run <script.py>` for isolated execution. Never fall back to global pip installs.
Keep the existing direct DataForSEO and Firecrawl adapters and delegation strength.

## EDR and Security Guardrails

- **No shell-wrapped or hidden subprocesses**: Never spawn `powershell.exe -Command`, `-EncodedCommand`, `-ExecutionPolicy Bypass`, `cmd.exe /c`, `WScript.Shell`, or `windowsHide: true`. Invoke `python scripts/runtime.py` or Node entrypoints directly with explicit argument arrays (`shell: false`).
- **Path and symlink safety**: Reject symlinks on credential files, `.env` inputs, cache files, and output targets, and never write batch outputs to Windows Controlled Folder Access protected folders (`Documents`, `Desktop`, `Pictures`).
- **Network and credential safety**: Route all external URL fetches through `scripts/url_safety.py` with response byte ceilings, and disable redirects and ambient proxies on authenticated endpoints.
