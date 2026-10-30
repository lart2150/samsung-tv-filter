// Response rewriting for the "replace" and "filter_groups" actions. Pure functions so they can be tested
// without a server. Each returns the new text and an X-TV-Block value, or undefined when nothing changed.
import type { Rule } from "./rules.ts";

export interface Rewrite {
  text: string;
  header: string;
}

export function applyReplace(rule: Rule, text: string): Rewrite | undefined {
  let out = text;
  for (const [pat, sub] of rule.replaceRes) out = out.replace(pat, sub);
  return out === text ? undefined : { text: out, header: rule.name };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function applyFilterGroups(rule: Rule, text: string): Rewrite | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const keys = (rule.groups_path ?? "").split(".");
  const last = keys.pop() as string;
  let parent: unknown = doc;
  for (const k of keys) {
    parent = isObj(parent) ? parent[k] : undefined;
    if (parent === undefined || parent === null) return undefined;
  }
  if (!isObj(parent)) return undefined;
  const groups = parent[last];
  if (!Array.isArray(groups)) return undefined;
  const key = rule.match_key ?? "group_tag";
  const tag = (g: unknown) => (isObj(g) && g[key] != null ? String(g[key]) : "");

  const kept = groups.filter((g) => {
    const v = tag(g);
    if (rule.dropRe?.test(v)) return false;
    if (rule.keepRe && !rule.keepRe.test(v)) return false;
    return true;
  });

  let trimmed = 0;
  const n = rule.max_items;
  if (n !== undefined) {
    for (const g of kept) {
      const items = isObj(g) ? g.items : undefined;
      if (!isObj(g) || !Array.isArray(items) || items.length <= n) continue;
      if (rule.trimRe && !rule.trimRe.test(tag(g))) continue;
      g.items = items.slice(0, n);
      if ("total_item_count" in g) g.total_item_count = n;
      trimmed++;
    }
  }
  if (kept.length === groups.length && !trimmed) return undefined;
  parent[last] = kept;
  return {
    text: JSON.stringify(doc),
    header: `${rule.name} (${groups.length - kept.length} of ${groups.length} removed, ${trimmed} trimmed)`,
  };
}
