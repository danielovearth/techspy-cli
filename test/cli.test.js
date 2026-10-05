import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { run, EXIT, parseArgs } from "../bin/techspy.js";

// A local stand-in for the TechSpy API: records requests, returns canned responses.
const requests = [];
let respond = () => [200, {}];
let server;
let baseUrl;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      const [status, json] = respond(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function sink() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  stream.text = () => chunks.join("");
  return stream;
}

async function cli(args, { env = {}, stdin = "" } = {}) {
  const stdout = sink();
  const stderr = sink();
  const home = env.HOME ?? mkdtempSync(join(tmpdir(), "techspy-cli-"));
  const code = await run(args, {
    env: { HOME: home, TECHSPY_BASE_URL: baseUrl, TECHSPY_API_KEY: "ts_" + "a".repeat(32), ...env },
    stdout, stderr, stdin: Readable.from([stdin]),
  });
  return { code, out: stdout.text(), err: stderr.text(), home };
}

test("scan sends the key and scan options, prints a summary", async () => {
  requests.length = 0;
  respond = () => [200, { url: "https://stripe.com", saved_scan_id: "scan_1", tech_stack: { Hosting: [{ name: "Cloudflare" }] }, dns: { scorecard: { grade: "A" } } }];
  const r = await cli(["scan", "stripe.com", "--dns", "--deep", "--no-save"]);
  assert.equal(r.code, EXIT.OK);
  const req = requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/analyze");
  assert.equal(req.headers.authorization, "Bearer ts_" + "a".repeat(32));
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(req.headers["x-techspy-client"], `cli/${version}`);
  assert.deepEqual(req.body, { url: "https://stripe.com", static_analysis: true, dns_scan: true, subdomain_analysis: false, sitemap_scan: false, deep_scan: true, interact: false, force: false, save: false });
  assert.match(r.out, /Hosting: Cloudflare/);
  assert.match(r.out, /DNS grade: A/);
  assert.match(r.out, /Saved scan: scan_1/);
});

test("scan saves to history by default (sends save:true)", async () => {
  requests.length = 0;
  respond = () => [200, { url: "https://stripe.com", tech_stack: {} }];
  await cli(["scan", "stripe.com"]);
  assert.equal(requests[0].body.save, true);
});

test("--json prints the raw API response", async () => {
  respond = () => [200, { tier: "plus", daily_scans: { limit: 30, used: 1, remaining: 29 }, credits: { deep_scan: 10, interact: 5 } }];
  const r = await cli(["account", "--json"]);
  assert.equal(r.code, EXIT.OK);
  assert.deepEqual(JSON.parse(r.out).credits, { deep_scan: 10, interact: 5 });
});

for (const [status, code] of [[401, EXIT.AUTH], [402, EXIT.PAYMENT], [429, EXIT.RATE_LIMIT], [404, EXIT.NOT_FOUND], [500, EXIT.ERROR]]) {
  test(`HTTP ${status} exits with ${code}`, async () => {
    respond = () => [status, { error: `boom ${status}` }];
    const r = await cli(["scan", "stripe.com", "--json"]);
    assert.equal(r.code, code);
    assert.deepEqual(JSON.parse(r.err), { error: `boom ${status}`, status, exit_code: code });
  });
}

test("usage errors exit 2 without calling the API", async () => {
  requests.length = 0;
  assert.equal((await cli(["scan"])).code, EXIT.USAGE);
  assert.equal((await cli(["bogus"])).code, EXIT.USAGE);
  assert.equal(requests.length, 0);
});

test("no key exits 3 without calling the API", async () => {
  requests.length = 0;
  const r = await cli(["account"], { env: { TECHSPY_API_KEY: "" } });
  assert.equal(r.code, EXIT.AUTH);
  assert.equal(requests.length, 0);
});

test("login stores the key with 0600 permissions and later commands use it", async () => {
  const key = "ts_" + "b".repeat(32);
  const login = await cli(["login"], { env: { TECHSPY_API_KEY: "" }, stdin: key + "\n" });
  assert.equal(login.code, EXIT.OK);
  const file = join(login.home, ".config", "techspy", "config.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).api_key, key);

  requests.length = 0;
  respond = () => [200, { scans: [], total: 0, hasMore: false }];
  const list = await cli(["scans", "list"], { env: { HOME: login.home, TECHSPY_API_KEY: "" } });
  assert.equal(list.code, EXIT.OK);
  assert.equal(requests[0].headers.authorization, `Bearer ${key}`);
  assert.equal(requests[0].url, "/api/scans/list?limit=10&offset=0");

  const logout = await cli(["logout"], { env: { HOME: login.home } });
  assert.equal(logout.code, EXIT.OK);
  assert.equal(existsSync(file), false);
});

test("login rejects things that aren't TechSpy keys", async () => {
  const r = await cli(["login"], { env: { TECHSPY_API_KEY: "" }, stdin: "sk_live_nope\n" });
  assert.equal(r.code, EXIT.USAGE);
});

test("analysis only generates with --generate", async () => {
  requests.length = 0;
  respond = () => [200, { url: "https://stripe.com", insights: null }];
  const r = await cli(["analysis", "scan_1"]);
  assert.equal(requests[0].method, "GET");
  assert.match(r.out, /--generate/);
  await cli(["analysis", "scan_1", "--generate"]);
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].url, "/api/scans/scan_1/analysis");
});

test("analysis says so when it is already being generated (202)", async () => {
  respond = () => [202, { url: "https://stripe.com", status: "generating", message: "…" }];
  const r = await cli(["analysis", "scan_1", "--generate"]);
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out, /already being generated/);
});

test("parseArgs handles --flag=value, --no-x and -h", () => {
  assert.deepEqual(parseArgs(["scans", "list", "--limit=5", "--offset", "10", "--no-save", "-h"]).flags, { limit: "5", offset: "10", save: false, help: true });
});

test("proxy errors with an object body print a readable message", async () => {
  respond = () => [401, { error: { code: "unauthorized", message: "Authentication Required" } }];
  const r = await cli(["account", "--json"]);
  assert.equal(r.code, EXIT.AUTH);
  assert.equal(JSON.parse(r.err).error, "Authentication Required");
});

test("package metadata: version matches --version, no third-party trademarks in keywords", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const r = await cli(["--version"]);
  assert.equal(r.out.trim(), pkg.version);
  for (const k of pkg.keywords) assert.doesNotMatch(k, /wappalyzer|builtwith/i);
  assert.equal(pkg.repository, undefined); // waits on Daniel making a public repo
});

test("README says a Plus or Max key is required up front and shows MCP early", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const head = readme.split("## Authenticate")[0];
  assert.match(head, /Plus or Max plan/);
  assert.match(head, /claude mcp add --transport http techspy/);
});
