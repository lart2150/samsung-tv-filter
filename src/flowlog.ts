// Full request/response logging for "log" rules, one JSON object per line in the same shape as
// tools/dump_flows.py, so tools/analyze.py (summary, endpoints, pii, find, ...) reads these files directly.
import { createWriteStream, type WriteStream } from "node:fs";
import type { OutgoingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import type { Context } from "koa";
import { bodyText, Capture } from "./body.ts";
import { log } from "./log.ts";
import type { LogSettings } from "./rules.ts";

// Headers nginx adds; they aren't part of what the TV sent (and index.ts doesn't forward them upstream).
export const NGINX_HEADERS = new Set([
  "connection",
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-tls-sni",
]);

class Writer {
  private file?: string;
  private out?: WriteStream;

  write(file: string, entry: object) {
    if (this.out === undefined || file !== this.file) {
      this.out?.end();
      const out = createWriteStream(file, { flags: "a" });
      out.on("error", (e) => log.error(`flow log ${file}: ${e}`));
      this.out = out;
      this.file = file;
      log.info(`logging flows to ${file}`);
    }
    this.out.write(`${JSON.stringify(entry)}\n`);
  }
}

const writer = new Writer();

// mitmproxy's dict(headers) joins repeated headers with ", "
function flat(headers: OutgoingHttpHeaders | NodeJS.Dict<string | string[]>, skip?: Set<string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && !skip?.has(k)) out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function firehose(body: string) {
  try {
    return (JSON.parse(body).Records as { Data: string }[]).map((r) =>
      JSON.parse(Buffer.from(r.Data, "base64").toString("utf8")),
    );
  } catch {
    return null;
  }
}

// One logged request. Call request()/response() to tap streamed bodies, or responseBody() for bodies built in
// memory (blocked or rewritten), then finish(); the entry is written when the client connection is done.
export class Flow {
  private readonly t = Date.now() / 1000;
  private readonly ctx: Context;
  private readonly url: string;
  private readonly host: string;
  private readonly settings: LogSettings;
  private req?: Capture;
  private res?: Capture;
  private sent?: Buffer;
  private original?: string;
  private written = false;

  constructor(ctx: Context, url: string, host: string, settings: LogSettings) {
    this.ctx = ctx;
    this.url = url;
    this.host = host;
    this.settings = settings;
  }

  request(src: Readable): Readable {
    this.req = new Capture(src, this.settings.maxBody);
    return this.req.stream;
  }

  // For blocked requests: read the body the TV sent so it can be logged, even though it goes nowhere.
  async drainRequest() {
    this.request(this.ctx.req).resume();
    await this.req?.done;
  }

  response(src: Readable): Readable {
    this.res = new Capture(src, this.settings.maxBody);
    return this.res.stream;
  }

  // `original` is the decoded upstream text when a rule rewrote the response.
  responseBody(sent: Buffer, original?: string) {
    this.sent = sent;
    this.original = original;
  }

  finish() {
    this.ctx.res.once("close", () => this.write());
  }

  error(e: unknown) {
    this.emit({
      t: this.t,
      kind: "http_error",
      method: this.ctx.method,
      url: this.url,
      host: this.host,
      sni: this.sni,
      err: String(e),
    });
  }

  private get sni() {
    return this.ctx.get("x-tls-sni") || null;
  }

  private write() {
    const { ctx, settings } = this;
    const max = settings.maxBody;
    const respHeaders = flat(ctx.res.getHeaders());
    const respRaw = this.sent ?? this.res?.buffer() ?? Buffer.alloc(0);
    const entry: Record<string, unknown> = {
      t: this.t,
      kind: "http",
      client: ctx.get("x-real-ip") || ctx.req.socket.remoteAddress || null,
      method: ctx.method,
      url: this.url,
      host: this.host,
      sni: this.sni,
      req_headers: flat(ctx.req.headers, NGINX_HEADERS),
      req_body: bodyText(this.req?.buffer() ?? Buffer.alloc(0), (ctx.get("content-encoding") || "").toLowerCase(), max),
      status: ctx.res.statusCode,
      resp_headers: respHeaders,
      resp_ct: respHeaders["content-type"] ?? null,
      resp_len: this.sent?.length ?? this.res?.size ?? 0,
      resp_body: bodyText(respRaw, (respHeaders["content-encoding"] ?? "").toLowerCase(), max),
    };
    if (this.original !== undefined) entry.orig_resp_body = this.original.slice(0, max);
    if (this.host.includes("firehose.") && typeof entry.req_body === "string")
      entry.firehose = firehose(entry.req_body);
    this.emit(entry);
  }

  private emit(entry: object) {
    if (this.written) return;
    this.written = true;
    writer.write(this.settings.file, entry);
  }
}
