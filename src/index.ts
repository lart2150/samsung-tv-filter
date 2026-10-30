// Koa reverse proxy that blocks / trims Samsung TV ads, home-screen rows and trackers. Port of tools/tv_block.py.
//
// nginx terminates TLS (eMudhra-signed certs) and forwards here with the original Host header and
// X-Forwarded-Proto; this app answers "block" rules locally and forwards everything else to the real host,
// rewriting the response for "replace" / "filter_groups" rules, and writes full request/response JSONL for "log"
// rules (src/flowlog.ts). See README.md and nginx/tv-filter.conf.
//
// Env:
//   PORT=3000  HOST=127.0.0.1
//   TV_BLOCK_RULES=./rules.json
//   UPSTREAM_INSECURE=1    don't verify upstream TLS certs (like mitmproxy --ssl-insecure)
//   UPSTREAM_TIMEOUT_MS=30000
import Koa, { type Context } from "koa";
import { Agent, request } from "undici";
import { applyFilterGroups, applyReplace } from "./actions.ts";
import { decode } from "./body.ts";
import { Flow, NGINX_HEADERS } from "./flowlog.ts";
import { log } from "./log.ts";
import { Rules } from "./rules.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30000);
const rules = new Rules(process.env.TV_BLOCK_RULES ?? "rules.json");
const dispatcher = new Agent({
  connect: { rejectUnauthorized: !["1", "true"].includes(process.env.UPSTREAM_INSECURE ?? "") },
  headersTimeout: TIMEOUT,
  bodyTimeout: TIMEOUT,
});

// Hop-by-hop headers, plus the ones nginx adds, which the real server shouldn't see.
const DROP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  ...NGINX_HEADERS,
]);
const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const short = (url: string, n: number) => (url.length > n ? url.slice(0, n) : url);

// Koa fills in a Content-Type when ctx.body is set; pass through upstream's lack of one.
function setBody(ctx: Context, body: Context["body"], upstreamType: unknown) {
  ctx.body = body;
  if (upstreamType === undefined) ctx.remove("Content-Type");
}

async function handle(ctx: Context) {
  // Host as the TV sent it (may carry a port); rules match without the port, like mitmproxy's pretty_host.
  // Only Host: nginx has already matched it against server_name, while X-Forwarded-* would come from the client.
  const authority = ctx.get("host");
  const host = authority
    .replace(/:\d+$/, "")
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();
  rules.reload();
  const scheme = ctx.get("x-forwarded-proto") === "https" ? "https" : "http";
  const path = ctx.url;
  const url = `${scheme}://${authority}${path}`;
  const flow = rules.match(host, path, "log") ? new Flow(ctx, url, host, rules.logSettings) : undefined;
  ctx.state.flow = flow;
  flow?.finish();

  const block = rules.match(host, path, "block");
  if (block) {
    const body = block.body ?? "";
    ctx.status = block.status ?? 204;
    ctx.set("Content-Type", block.content_type ?? "text/plain");
    ctx.set("X-TV-Block", block.name);
    const empty = ctx.status === 204 || ctx.status === 304;
    const text = empty ? "" : typeof body === "string" ? body : JSON.stringify(body);
    if (!empty) ctx.body = text;
    await flow?.drainRequest();
    flow?.responseBody(Buffer.from(text));
    log.info(`blocked ${ctx.method} ${short(url, 120)} (${block.name})`);
    return;
  }

  const rewrite = rules.match(host, path, "replace") ?? rules.match(host, path, "filter_groups");

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(ctx.req.headers)) {
    if (v !== undefined && !DROP_REQUEST.has(k)) headers[k] = v;
  }
  // Ask for an uncompressed body when we're going to rewrite it (decode() still handles servers that ignore this).
  if (rewrite) headers["accept-encoding"] = "identity";
  const hasBody = !["GET", "HEAD"].includes(ctx.method) && (ctx.req.headers["content-length"] ?? "0") !== "0";
  const sendBody = hasBody || ctx.req.headers["transfer-encoding"] !== undefined;

  const res = await request(url, {
    method: ctx.method as "GET",
    headers,
    body: sendBody ? (flow?.request(ctx.req) ?? ctx.req) : undefined,
    dispatcher,
  });
  // Koa destroys the body when the client hangs up, and undici then emits "aborted" with no listener left
  // (Koa's pipeline has already finished), which would crash the process.
  res.body.on("error", () => {});

  ctx.status = res.statusCode;
  for (const [k, v] of Object.entries(res.headers)) {
    if (v !== undefined && !DROP_RESPONSE.has(k)) ctx.set(k, v);
  }

  const upstreamType = res.headers["content-type"];

  if (!rewrite || ctx.method === "HEAD" || [204, 304].includes(res.statusCode)) {
    setBody(ctx, flow ? flow.response(res.body) : res.body, upstreamType);
    return;
  }

  const raw = Buffer.from(await res.body.arrayBuffer());
  const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
  let plain: Buffer | undefined;
  try {
    // strict: a truncated or corrupt body is passed through as-is rather than rewritten as if complete
    plain = decode(raw, encoding, { strict: true });
  } catch (e) {
    log.warn(`${rewrite.name}: could not decode ${encoding} body of ${short(url, 100)}: ${e}`);
  }
  const out =
    plain && (rewrite.action === "replace" ? applyReplace : applyFilterGroups)(rewrite, plain.toString("utf8"));
  if (!out) {
    setBody(ctx, raw, upstreamType);
    flow?.responseBody(raw);
    return;
  }
  ctx.remove("Content-Encoding");
  ctx.remove("Content-Length");
  ctx.remove("ETag");
  ctx.set("X-TV-Block", out.header);
  setBody(ctx, out.text, upstreamType);
  flow?.responseBody(Buffer.from(out.text), plain?.toString("utf8"));
  log.info(`${out.header} ${ctx.method} ${short(url, 100)}`);
}

const app = new Koa();
app.use(async (ctx) => {
  try {
    await handle(ctx);
  } catch (e) {
    log.error(`${ctx.method} ${ctx.get("host")}${short(ctx.url, 100)}: ${e}`);
    (ctx.state.flow as Flow | undefined)?.error(e);
    if (!ctx.headerSent) {
      // drop anything copied from upstream (Content-Encoding, Cache-Control, Set-Cookie, ...) before the error body
      for (const name of ctx.res.getHeaderNames()) ctx.res.removeHeader(name);
      ctx.status = 502;
      ctx.type = "text/plain";
      ctx.body = "tv-filter: upstream error\n";
    }
  }
});

app.listen(PORT, HOST, () => log.info(`listening on http://${HOST}:${PORT}, rules ${rules.file}`));
