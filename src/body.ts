// Body helpers: content-encoding decoding, and a pass-through tap that keeps the first N bytes of a stream.
import { pipeline, type Readable, Transform } from "node:stream";
import { brotliDecompressSync, constants, gunzipSync, inflateSync } from "node:zlib";

// Returns undefined for encodings we can't decode. By default the flush options let a truncated body (from a
// Capture) decode as far as it goes instead of throwing; strict throws on a truncated body, for serving.
export function decode(body: Buffer, encoding: string, { strict = false } = {}): Buffer | undefined {
  const zlib = strict ? {} : { finishFlush: constants.Z_SYNC_FLUSH };
  switch (encoding) {
    case "":
    case "identity":
      return body;
    case "gzip":
    case "x-gzip":
      return gunzipSync(body, zlib);
    case "deflate":
      return inflateSync(body, zlib);
    case "br":
      return brotliDecompressSync(body, strict ? {} : { finishFlush: constants.BROTLI_OPERATION_FLUSH });
    default:
      return undefined;
  }
}

export class Capture {
  readonly stream: Readable;
  readonly done: Promise<void>;
  size = 0;
  private chunks: Buffer[] = [];
  private kept = 0;

  constructor(src: Readable, max: number) {
    const tap = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        this.size += chunk.length;
        if (this.kept < max) {
          const part = chunk.subarray(0, max - this.kept);
          this.chunks.push(part);
          this.kept += part.length;
        }
        cb(null, chunk);
      },
    });
    this.stream = tap;
    // resolves when the source ends or fails (a client hanging up still leaves what was captured so far)
    this.done = new Promise((resolve) => pipeline(src, tap, () => resolve()));
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// Same shape as tools/dump_flows.py _body(): decoded UTF-8 text cut to max chars, {"binary": n} for anything that
// isn't text (or can't be decoded), null for an empty body.
export function bodyText(raw: Buffer, encoding: string, max: number): string | { binary: number } | null {
  if (!raw.length) return null;
  let plain: Buffer | undefined;
  try {
    plain = decode(raw, encoding);
  } catch {
    plain = undefined;
  }
  if (!plain) return { binary: raw.length };
  if (!plain.length) return null;
  try {
    // stream: true tolerates a character cut in half at the end of a truncated capture
    return new TextDecoder("utf-8", { fatal: true }).decode(plain, { stream: true }).slice(0, max);
  } catch {
    return { binary: plain.length };
  }
}
