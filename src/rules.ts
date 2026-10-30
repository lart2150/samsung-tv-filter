// Loads rules.json (same format as tools/tv_block_rules.json) and re-reads it whenever its mtime changes.
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "./log.ts";

export type Action = "block" | "filter_groups" | "replace" | "log";

// Top-level "log" object in rules.json; applies to requests matched by "log" rules.
export interface LogSettings {
  file: string; // relative paths are relative to rules.json
  maxBody: number;
}

export interface RawRule {
  name: string;
  enabled?: boolean;
  host: string;
  path?: string;
  action: Action;
  // block
  status?: number;
  content_type?: string;
  body?: unknown;
  // filter_groups
  groups_path?: string;
  match_key?: string;
  drop?: string;
  keep?: string;
  max_items?: number;
  max_items_match?: string;
  // replace
  replace?: [string, string][];
}

export interface Rule extends RawRule {
  hostRe: RegExp;
  pathRe?: RegExp;
  dropRe?: RegExp;
  keepRe?: RegExp;
  trimRe?: RegExp;
  replaceRes: [RegExp, string][];
}

const re = (s: string | undefined) => (s ? new RegExp(s) : undefined);

export function compile(raw: RawRule): Rule {
  return {
    ...raw,
    hostRe: new RegExp(raw.host),
    pathRe: re(raw.path),
    dropRe: re(raw.drop),
    keepRe: re(raw.keep),
    trimRe: re(raw.max_items_match),
    // "g": Python's re.sub replaces every match
    replaceRes: (raw.replace ?? []).map(([p, s]) => [new RegExp(p, "g"), s]),
  };
}

export class Rules {
  private rules: Rule[] = [];
  private mtime?: number;
  private missing = false;

  readonly file: string;
  logSettings: LogSettings;

  constructor(file: string) {
    this.file = file;
    this.logSettings = this.parseLog({});
  }

  private parseLog(raw: { file?: string; max_body?: number }): LogSettings {
    return { file: resolve(dirname(this.file), raw.file ?? "flows.jsonl"), maxBody: raw.max_body ?? 2_000_000 };
  }

  // Called once per request, so every match() in that request sees the same rules.
  reload() {
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      if (!this.missing && this.mtime !== undefined) log.warn(`rules file ${this.file} disappeared; keeping old rules`);
      this.missing = true;
      return;
    }
    this.missing = false;
    if (mtime === this.mtime) return;
    let rules: Rule[];
    let logSettings: LogSettings;
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      rules = (doc.rules as RawRule[]).filter((r) => r.enabled ?? true).map(compile);
      logSettings = this.parseLog(doc.log ?? {});
    } catch (e) {
      log.warn(`could not load ${this.file}: ${e}; keeping old rules`);
      // don't retry a broken file on every request; wait for the next save
      this.mtime = mtime;
      return;
    }
    this.rules = rules;
    this.logSettings = logSettings;
    this.mtime = mtime;
    log.info(`loaded ${rules.length} enabled rules from ${this.file}`);
  }

  match(host: string, path: string, action: Action): Rule | undefined {
    return this.rules.find(
      (r) => r.action === action && r.hostRe.test(host) && (r.pathRe === undefined || r.pathRe.test(path)),
    );
  }
}
