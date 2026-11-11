# Release verification - 2026-09-06

This candidate adds the official Grok CLI to the existing Codex, Claude Code,
and Gemini game runtimes. It also prepares a generic source download.

## Checks completed

- Python suite: 428 passed, 9 platform-specific skips. Focused installer and
  privacy checks passed again after the installer corrections.
- Full game suite: startup, CLI transports, text-runtime adapters, prompt
  policy, dialogue, remote control, live bridge, hall, UX, assets, and links
  passed. The asset/game smoke section contains 232 passing assertions.
- Strict skill portability check: zero errors or warnings.
- Real Codex and Grok account smoke prompts completed through the bridge.
- Claude's local smoke reached the CLI but was blocked by a revoked OAuth token.
  Gemini's local smoke was blocked by its configured authentication method.
  Their process fixtures and UI selection passed; those account failures do
  not establish successful end-to-end provider operation.
- ZIP-style launcher fixture passed with spaces in its path, occupied/equal
  requested ports, runtime configuration, and shutdown cleanup.
- Five replacement game screenshots were generated from fictional example.com
  fixtures and visually inspected. No live audit was used to generate them.

## Source sanitation

Removed the unrelated injected agent configuration, maintainer filesystem
defaults, site-specific demo fixtures, real audit screenshots, a real analytics
image, and private comparison details. Public-source provenance, MIT notices,
FLOW attribution, and contributor credits remain intact.

The release privacy check examines tracked inputs without echoing potential
credential values. It rejects local state and common credential patterns;
additional private markers can be supplied with `--deny`. Media also received
visual and metadata review. These checks are evidence within their scope,
not a guarantee that every possible sensitive pattern can be detected.

## Distribution boundary

Distribute a source ZIP produced by `git archive` from this reviewed commit.
It contains neither `.git` history nor ignored local environments, credentials,
logs, reports, or installed dependencies. Users install dependencies and sign
in to their own supported CLI as described in `INSTALLATION.md`.

The existing repository history still contains deleted site-audit and operational
files. A read-only review covered 9,910 historical blobs; credential-pattern
matches were examples/placeholders, but the old operational content remains.
Do not treat this history as a sanitized generic public clone. Public Git
distribution requires a separately prepared clean history or reviewed history
cleanup. Repository visibility and historical commits were not changed here.
