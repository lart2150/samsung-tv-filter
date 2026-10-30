# tv-filter

Koa reverse proxy that blocks and trims Samsung TV ads, home-screen rows and trackers. It's a port of the
mitmproxy addon `tools/tv_block.py`, meant to run full time without mitmproxy. nginx sits in front and
terminates TLS with eMudhra-signed certs.

```
IoT DNS (listed hosts -> Pi) --> nginx :443 (TLS, by SNI) --> koa :3000 --> real server
                             `--> nginx :80 ---------------> koa :3000 --> real server
```

## Rules

`rules.json` is local and not checked in; `rules.json.dist` is the template. Start from a copy:

```
cp rules.json.dist rules.json
```

The template ships with `log-all` disabled (`"enabled": false`), so nothing is logged until you turn it on. The
`firmware-no-update` rule answers the TV's update check with a canned "no update" for model `T-PTMAKUC`; change
`modelId` for another model, or disable the rule when you want to check for an update. When you change the template,
copy the same change into your `rules.json` (or re-copy it); the app only reads `rules.json`.

`rules.json` uses the same format as `tools/tv_block_rules.json` (it started as a copy), and the same three
actions: `block`, `replace` and `filter_groups`. See the docstring at the top of `tools/tv_block.py`. The file is
re-read when it changes, so you don't need a restart. Every response the app creates or changes carries
`X-TV-Block: <rule>`.

Differences from the Python version:
- Regexes are JavaScript regexes. The current rules work unchanged, but `replace` replacement strings use `$1`, not `\1`.
- A rules file that fails to parse is logged once per save, not on every request. The old rules stay active.
- Rewritten responses lose `Content-Encoding`, `Content-Length` and `ETag`. When a rule matches, the app asks upstream for
  `accept-encoding: identity`, and it can decode gzip, deflate and br. Bodies in any other encoding pass through unchanged.

### Logging

A `"log"` rule (`host`/`path` as usual; `"host": "."` for everything) appends each matching request and response
to a JSONL file, configured by the top-level `"log"` object in `rules.json`:

```json
"log": { "file": "flows.jsonl", "max_body": 2000000 },
"rules": [ { "name": "log-all", "enabled": true, "host": ".", "action": "log" }, ... ]
```

`file` is relative to `rules.json`. Lines use the same fields as `tools/dump_flows.py` (`t`, `kind`, `client`, `method`,
`url`, `host`, `sni`, `req_headers`, `req_body`, `status`, `resp_headers`, `resp_ct`, `resp_len`, `resp_body`, plus
`firehose`), so `python tools/analyze.py summary|endpoints|pii|find ... flows.jsonl` works on them. The logged response
is what the TV actually received. When a rule rewrote it, `orig_resp_body` holds the upstream version. Upstream
failures are logged as `"kind": "http_error"` with `err`. Bodies are decoded (gzip/deflate/br) and kept up to
`max_body` bytes (copied as they stream, so large bodies aren't buffered), and non-text bodies become
`{"binary": n}`. `log` rules combine with the other actions: a blocked or rewritten request is still logged.

Adding a host to an HTTPS rule takes three steps: add the rule to `rules.json`, add the name to the map in
`server_name` in `nginx/tv-filter.conf`, add it to the IoT DNS rewrites, and add it to the SANs of the tv-filter cert.

## Run

Node 22.18 or newer (it runs `.ts` directly in dev).

```
npm install
cp rules.json.dist rules.json   # first time only; see Rules
npm run dev                     # node --watch src/index.ts
npm run build && npm start      # node dist/index.js
npm test                        # node:test on src/**/*.test.ts
npm run lint / npm run fix      # biome
```

| env                   | default                        |                                                           |
| --------------------- | ------------------------------ | --------------------------------------------------------- |
| `PORT` / `HOST`       | `3000` / `127.0.0.1`           | where nginx reaches the app                               |
| `TV_BLOCK_RULES`      | `rules.json` (relative to cwd) | rules file                                                |
| `UPSTREAM_INSECURE`   | off                            | `1` = don't verify upstream certs (like `--ssl-insecure`) |
| `UPSTREAM_TIMEOUT_MS` | `30000`                        | upstream header and body timeout                          |

The app resolves each upstream host itself through the Pi's normal DNS. Only the IoT devices get the rewritten
names, so it reaches the real servers rather than looping back into nginx.

## nginx (Pi)

- `nginx/tv-filter.conf` goes inside `http {}` (`/etc/nginx/sites-available/tv-filter`, linked into `sites-enabled/`).
  It shares 80/443 with the other sites and isn't `default_server`, so nginx only sends the listed names to it.
- Cert: one multi-SAN cert covering every name in `server_name`, at `/etc/ssl/certs/tv-filter.crt` (leaf + eMudhra
  intermediate) and `/etc/ssl/private/tv-filter.key`. Use a P-384 key, as with mitmproxy.
- 443 is forwarded from the internet, so the server only allows private (LAN) addresses.
- Point the IoT devices' DNS for each listed name at the Pi. Nothing else is redirected, so SmartThings, the
  Chromecast and pinned apps go straight to their real servers.
