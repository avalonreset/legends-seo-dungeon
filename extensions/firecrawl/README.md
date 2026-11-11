# Firecrawl Extension for Legends SEO Dungeon

Full-site crawling, scraping, and site mapping powered by [Firecrawl](https://www.firecrawl.dev/). Enables comprehensive site-wide SEO analysis with JavaScript rendering support.

Legends SEO Dungeon should use `FIRECRAWL_API_KEY` from the selected project `.env` and
direct API scripts first. The Firecrawl MCP server is an optional adapter for
users who already prefer MCP.

## Prerequisites

- Firecrawl API key ([sign up](https://www.firecrawl.dev/signup) -- free tier: 500 credits/month)

Add credentials to the selected project `.env`:

```bash
FIRECRAWL_API_KEY=fc-your-api-key
```

## Installation

### macOS / Linux

```bash
./extensions/firecrawl/install.sh
```

### Cross-Platform (Windows / macOS / Linux)

```bash
claude-seo install-extension firecrawl
```

The optional installer will prompt for your Firecrawl API key and configure the
MCP adapter automatically.

## Commands

| Command | Purpose | Credits |
|---------|---------|---------|
| `/seo firecrawl crawl <url>` | Full-site crawl with content extraction | 1 per page |
| `/seo firecrawl map <url>` | Discover site structure (URLs only) | 0.5 per URL |
| `/seo firecrawl scrape <url>` | Single-page deep scrape with JS rendering | 1 |
| `/seo firecrawl search <query> <url>` | Search within a site | 1 per result |

## Integration with Legends SEO Dungeon

When project `.env` credentials are present, Legends SEO Dungeon skills can leverage
Firecrawl directly:

- **`/seo audit`**: Uses `map` to discover all pages, then `crawl` for deep analysis
- **`/seo technical`**: Broken link detection across entire site
- **`/seo sitemap`**: Compare XML sitemap vs actual crawlable pages
- **`/seo content`**: Thin content detection at scale

## Cost

| Plan | Credits/month | Price |
|------|--------------|-------|
| Free | 500 | $0 |
| Hobby | 3,000 | $16/mo |
| Standard | 100,000 | $83/mo |
| Growth | 500,000 | $333/mo |

1 credit = 1 page crawled or scraped. Map operations use 0.5 credits per URL.

## Troubleshooting

**Optional MCP adapter not connecting?**
- Normal Legends SEO Dungeon audits do not require MCP.
- If you intentionally use the adapter, check: `cat ~/.claude/settings.json | python3 -m json.tool | grep firecrawl`
- Manual config: See [FIRECRAWL-SETUP.md](docs/FIRECRAWL-SETUP.md)

**Credits exhausted?**
- Check usage: https://www.firecrawl.dev/app
- Upgrade plan or wait for monthly reset

**Site blocking crawls?**
- Some sites block automated crawling via robots.txt or Cloudflare
- Try `scrape` (single page) instead of `crawl` (full site)
- Fall back to `fetch_page.py` for basic HTML retrieval

## Uninstall

```bash
./extensions/firecrawl/uninstall.sh      # macOS/Linux
claude-seo uninstall-extension firecrawl  # Cross-platform
```

## Links

- [Firecrawl Documentation](https://docs.firecrawl.dev/)
- [Firecrawl MCP Server](https://www.npmjs.com/package/firecrawl-mcp)
- [Legends SEO Dungeon](https://github.com/avalonreset/legends-seo-dungeon)
