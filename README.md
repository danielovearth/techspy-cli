# techspy

Detect any website's tech stack — frameworks, hosting/CDN, analytics, payments, marketing tools, DNS and email security — from your terminal or a coding agent. CLI for the [TechSpy](https://techspy.hi-daniel.com) API.

```bash
npx techspy scan stripe.com
```

Requires Node 18+ (no dependencies) and a TechSpy API key from the **Plus or Max plan** — create one at https://techspy.hi-daniel.com/dashboard/api.

**Using an AI agent?** TechSpy is also a remote MCP server with the same operations as native tools:

```bash
claude mcp add --transport http techspy https://techspy.hi-daniel.com/api/mcp \
  --header "Authorization: Bearer ts_YOUR_API_KEY"
```

Docs: https://techspy.hi-daniel.com/api-docs#cli · MCP: https://techspy.hi-daniel.com/api-docs#mcp

## Authenticate

Create an API key at **https://techspy.hi-daniel.com/dashboard/api** (Plus or Max plan), then either:

```bash
export TECHSPY_API_KEY=ts_...
```

or save it once (stored in `~/.config/techspy/config.json`, mode 600):

```bash
npx techspy login
```

`TECHSPY_API_KEY` takes precedence over the saved key. The key is never accepted as a command-line flag, so it doesn't end up in shell history.

## Commands

| Command | What it does |
|---|---|
| `techspy scan <domain>` | Detect the tech stack. Add `--dns`, `--subdomains`, `--sitemap`, `--deep`, `--interact`, `--force`, `--no-save` |
| `techspy account` | Plan, scans left today, Deep Scan / Interact credits |
| `techspy scans list [--limit N] [--offset N]` | Your saved scans, newest first |
| `techspy scans get <scan-id>` | One saved scan |
| `techspy analysis <scan-id> [--generate] [--force]` | Five-pillar strategy analysis of a saved scan |
| `techspy login` / `techspy logout` | Save / remove your API key |

Global options: `--json`, `--base-url <url>` (or `TECHSPY_BASE_URL`), `--help`, `--version`.

## Credits

Scans share your plan's limits — there is no separate API quota:

- Every `scan` uses 1 daily scan (Plus: 30/day, Max: unlimited), including when a recent result is reused.
- `--deep` uses 1 Deep Scan credit. `--interact` uses 1 Interact credit **and** 1 Deep Scan credit.
- Failed scans are refunded. `techspy account` shows what's left.
- Scans are saved to your history (see them in the dashboard); pass `--no-save` to skip.
- `analysis --generate` doesn't use credits (the first analysis of each scan is cached; 10 generations per hour per IP). `--force` regenerates your own scans, once per scan per 24h.

## For agents and scripts

Use `--json` for machine-readable output on stdout; errors are printed as JSON on stderr:

```bash
npx techspy scan stripe.com --dns --json | jq '.tech_stack'
```

Exit codes let you branch without parsing text:

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Other error (network, 5xx) |
| 2 | Usage error |
| 3 | Missing / invalid API key (401, 403) |
| 4 | Out of daily scans or credits (402) |
| 5 | Rate limited (429) |
| 6 | Not found (404) |

