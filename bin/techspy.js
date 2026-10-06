#!/usr/bin/env node
// TechSpy CLI — tech stack intelligence from the terminal or a coding agent.
// Zero dependencies; Node 18+ (global fetch). Talks to the TechSpy REST API with
// an API key from TECHSPY_API_KEY or `techspy login`.

import { mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "0.1.2";
const DEFAULT_BASE = "https://techspy.hi-daniel.com";

// Exit codes: agents can branch on these without parsing text.
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, PAYMENT: 4, RATE_LIMIT: 5, NOT_FOUND: 6 };

const HELP = `techspy ${VERSION} — detect any website's tech stack

Usage
  techspy scan <domain> [--dns] [--subdomains] [--sitemap] [--deep] [--interact] [--force] [--no-save]
  techspy account
  techspy scans list [--limit N] [--offset N]
  techspy scans get <scan-id>
  techspy analysis <scan-id> [--generate] [--force]
  techspy login            Save an API key to ~/.config/techspy/config.json
  techspy logout           Remove the saved API key

Global options
  --json                   Machine-readable JSON on stdout (errors as JSON on stderr)
  --base-url <url>         API base (default ${DEFAULT_BASE}, or TECHSPY_BASE_URL)
  -h, --help               Show help
  -v, --version            Show version

Auth
  Set TECHSPY_API_KEY=ts_... or run \`techspy login\`. Create a key at
  ${DEFAULT_BASE}/dashboard/api (Plus or Max plan).

Credits
  Every scan uses 1 of your plan's daily scans (Plus: 30/day, Max: unlimited).
  --deep uses 1 Deep Scan credit; --interact uses 1 Interact + 1 Deep Scan credit.
  Check what's left with \`techspy account\`.

Exit codes
  0 ok · 1 error · 2 usage · 3 auth (401/403) · 4 out of scans/credits (402)
  5 rate limited (429) · 6 not found (404)

Examples
  npx techspy scan stripe.com
  npx techspy scan stripe.com --dns --subdomains --json
  techspy analysis <scan-id> --generate
`;

// ---------- args ----------

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (arg === "-h") { flags.help = true; continue; }
    if (arg === "-v") { flags.version = true; continue; }
    if (arg.startsWith("--")) {
      const [rawName, inline] = arg.slice(2).split("=", 2);
      const name = rawName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (["limit", "offset", "baseUrl"].includes(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw usage(`--${rawName} needs a value`);
        flags[name] = value;
      } else if (name.startsWith("no") && name.length > 2) {
        flags[name[2].toLowerCase() + name.slice(3)] = false;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

class CliError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const usage = (msg) => new CliError(msg, EXIT.USAGE);

// ---------- config ----------

function configDir(env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "techspy");
}
const configPath = (env) => join(configDir(env), "config.json");

function readConfig(env) {
  try { return JSON.parse(readFileSync(configPath(env), "utf8")); } catch { return {}; }
}

function resolveApiKey(env) {
  return env.TECHSPY_API_KEY || readConfig(env).api_key || null;
}

// ---------- http ----------

function exitCodeFor(status) {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 402) return EXIT.PAYMENT;
  if (status === 429) return EXIT.RATE_LIMIT;
  if (status === 404) return EXIT.NOT_FOUND;
  return EXIT.ERROR;
}

const HINTS = {
  401: "Check TECHSPY_API_KEY or run `techspy login`. Keys: " + DEFAULT_BASE + "/dashboard/api",
  402: "Out of daily scans or credits. See `techspy account`; upgrade at " + DEFAULT_BASE + "/pricing",
  429: "Rate limited. Wait and retry (analysis --force: once per scan per 24h).",
};

async function api(ctx, method, path, body) {
  if (!ctx.apiKey) {
    throw new CliError("No API key. Set TECHSPY_API_KEY or run `techspy login`.", EXIT.AUTH, 401);
  }
  let res;
  try {
    res = await ctx.fetch(new URL(path, ctx.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
        "user-agent": `techspy-cli/${VERSION}`,
        "x-techspy-client": `cli/${VERSION}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError(`Could not reach ${ctx.baseUrl}: ${err.message}`, EXIT.ERROR);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new CliError(errorMessage(data, res.status), exitCodeFor(res.status), res.status);
  }
  return data;
}

// TechSpy returns { error: "..." }; proxies such as Vercel's deployment
// protection return { error: { code, message } }.
function errorMessage(data, status) {
  const err = data && data.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") return err.message || err.code || JSON.stringify(err);
  return (data && data.message) || `HTTP ${status}`;
}



// ---------- formatting ----------

function techLines(techStack) {
  const lines = [];
  for (const [category, items] of Object.entries(techStack || {})) {
    if (!Array.isArray(items) || items.length === 0) continue;
    const names = items.filter((t) => t && t.name).map((t) => `${t.name}${t.version ? ` ${t.version}` : ""}`);
    lines.push(`  ${category}: ${names.join(", ")}`);
  }
  return lines;
}

function formatScan(data) {
  const out = [];
  const techCount = Object.values(data.tech_stack || {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
  out.push(`${data.url || ""} — ${techCount} technologies`);
  out.push(...techLines(data.tech_stack));
  const grade = data.dns && data.dns.scorecard && data.dns.scorecard.grade;
  if (grade) out.push(`  DNS grade: ${grade}`);
  if (Array.isArray(data.subdomains) && data.subdomains.length) {
    out.push(`  Subdomains (${data.subdomains.length}): ${data.subdomains.slice(0, 10).map((s) => (typeof s === "string" ? s : s.hostname || s.name)).join(", ")}`);
  }
  if (data.sitemap && data.sitemap.found) out.push(`  Sitemap: ${data.sitemap.total ?? "?"} URLs`);
  if (data.saved_scan_id) out.push(`  Saved scan: ${data.saved_scan_id}`);
  return out.join("\n");
}

function formatAccount(a) {
  const d = a.daily_scans || {};
  const c = a.credits || {};
  const scans = d.limit == null ? `${d.used ?? 0} used today (unlimited)` : `${d.remaining}/${d.limit} left today (resets ${d.resets_at})`;
  return [
    `${a.email || "TechSpy account"} — ${String(a.tier || "").toUpperCase()}`,
    `  Scans: ${scans}`,
    `  Deep Scan credits: ${c.deep_scan ?? 0}`,
    `  Interact credits: ${c.interact ?? 0}`,
  ].join("\n");
}

// ---------- commands ----------

async function cmdScan(ctx, [domain], flags) {
  if (!domain) throw usage("Usage: techspy scan <domain>");
  const url = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  const data = await api(ctx, "POST", "/api/analyze", {
    url,
    static_analysis: true,
    dns_scan: flags.dns === true,
    subdomain_analysis: flags.subdomains === true,
    sitemap_scan: flags.sitemap === true,
    deep_scan: flags.deep === true,
    interact: flags.interact === true,
    force: flags.force === true,
    save: flags.save !== false,
  });
  return { data, text: formatScan(data) };
}

async function cmdAccount(ctx) {
  const data = await api(ctx, "GET", "/api/account");
  return { data, text: formatAccount(data) };
}

async function cmdScans(ctx, [sub, id], flags) {
  if (sub === "get") {
    if (!id) throw usage("Usage: techspy scans get <scan-id>");
    const data = await api(ctx, "GET", `/api/scans/${encodeURIComponent(id)}`);
    const scan = data.scan || {};
    return { data, text: formatScan({ ...(scan.result || {}), url: scan.url, saved_scan_id: scan.id }) };
  }
  if (sub && sub !== "list") throw usage("Usage: techspy scans list | techspy scans get <scan-id>");
  const qs = new URLSearchParams({ limit: String(flags.limit ?? 10), offset: String(flags.offset ?? 0) });
  const data = await api(ctx, "GET", `/api/scans/list?${qs}`);
  const rows = (data.scans || []).map((s) => {
    const n = Object.values((s.result && s.result.tech_stack) || {}).reduce((k, a) => k + (Array.isArray(a) ? a.length : 0), 0);
    return `${s.id}  ${String(s.created_at || "").slice(0, 10)}  ${s.url}  (${n} tech)`;
  });
  return { data, text: rows.length ? rows.join("\n") + (data.hasMore ? `\n… ${data.total} total, use --offset` : "") : "No saved scans yet." };
}

async function cmdAnalysis(ctx, [id], flags) {
  if (!id) throw usage("Usage: techspy analysis <scan-id> [--generate] [--force]");
  const path = `/api/scans/${encodeURIComponent(id)}/analysis`;
  const data = flags.generate || flags.force
    ? await api(ctx, "POST", path, { force: flags.force === true })
    : await api(ctx, "GET", path);
  const text = data.insights
    ? JSON.stringify(data.insights, null, 2)
    : data.status === "generating"
      ? "This analysis is already being generated. Run `techspy analysis <scan-id>` again in a few minutes."
      : "No analysis yet. Run again with --generate (free; 10 per hour per IP).";
  return { data, text };
}

async function prompt(question, input, output) {
  const rl = createInterface({ input, output, terminal: false });
  output.write(question);
  for await (const line of rl) { rl.close(); return line.trim(); }
  return "";
}

async function cmdLogin(ctx) {
  const key = ctx.env.TECHSPY_API_KEY || await prompt("Paste your TechSpy API key (ts_...): ", ctx.stdin, ctx.stderr);
  if (!/^ts_[A-Za-z0-9]{16,}$/.test(key)) throw usage("That doesn't look like a TechSpy API key (ts_...).");
  const dir = configDir(ctx.env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath(ctx.env);
  writeFileSync(file, JSON.stringify({ api_key: key }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return { data: { ok: true, config: file }, text: `Saved to ${file}` };
}

async function cmdLogout(ctx) {
  const file = configPath(ctx.env);
  const existed = existsSync(file);
  if (existed) rmSync(file);
  return { data: { ok: true, removed: existed }, text: existed ? `Removed ${file}` : "No saved key." };
}

const COMMANDS = { scan: cmdScan, account: cmdAccount, scans: cmdScans, analysis: cmdAnalysis, login: cmdLogin, logout: cmdLogout };

// ---------- main ----------

export async function run(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let json = false;
  try {
    const { flags, positionals } = parseArgs(argv);
    json = flags.json === true;
    if (flags.version) { stdout.write(`${VERSION}\n`); return EXIT.OK; }
    const [command, ...rest] = positionals;
    if (flags.help || !command) { stdout.write(HELP); return command || flags.help ? EXIT.OK : EXIT.USAGE; }
    const handler = COMMANDS[command];
    if (!handler) throw usage(`Unknown command "${command}". Run \`techspy --help\`.`);

    const ctx = {
      env,
      stdin: io.stdin ?? process.stdin,
      stderr,
      fetch: io.fetch ?? globalThis.fetch,
      baseUrl: (flags.baseUrl || env.TECHSPY_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ""),
      apiKey: resolveApiKey(env),
    };
    const { data, text } = await handler(ctx, rest, flags);
    stdout.write((json ? JSON.stringify(data, null, 2) : text) + "\n");
    return EXIT.OK;
  } catch (err) {
    const code = err instanceof CliError ? err.code : EXIT.ERROR;
    const status = err instanceof CliError ? err.status : undefined;
    if (json) {
      stderr.write(JSON.stringify({ error: err.message, status: status ?? null, exit_code: code }) + "\n");
    } else {
      stderr.write(`Error: ${err.message}\n`);
      if (status && HINTS[status]) stderr.write(`${HINTS[status]}\n`);
    }
    return code;
  }
}

// Run when executed directly — including via npx / global-install symlinks —
// but not when imported by tests.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
