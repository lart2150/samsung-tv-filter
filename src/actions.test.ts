import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyFilterGroups, applyReplace } from "./actions.ts";
import { compile, type RawRule } from "./rules.ts";

const shipped = (name: string) => {
  const raw = (JSON.parse(readFileSync(new URL("../rules.json", import.meta.url), "utf8")).rules as RawRule[]).find(
    (r) => r.name === name,
  );
  assert.ok(raw, name);
  return compile(raw);
};

test("replace turns every ad flag off", () => {
  const r = shipped("samsung-ads-config-off");
  const out = applyReplace(r, '{"a":{"enableAd" : "on"},"b":{"enableAd":"on","realTimeAd":"on"}}');
  assert.equal(out?.text, '{"a":{"enableAd":"off"},"b":{"enableAd":"off","realTimeAd":"off"}}');
  assert.equal(out?.header, "samsung-ads-config-off");
});

test("replace with no match changes nothing", () => {
  assert.equal(applyReplace(shipped("samsung-ads-config-off"), '{"enableAd":"off"}'), undefined);
});

test("filter_groups keeps listed rows and trims top picks", () => {
  const r = shipped("home-rows");
  const items = [1, 2, 3];
  const doc = {
    rsp: {
      payload: {
        groups: [
          { group_tag: "continue_watching", items },
          { group_tag: "sponsored_row", items },
          { group_tag: "[foryou][curated]_top_picks_for_you", items, total_item_count: 3 },
        ],
      },
    },
  };
  const out = applyFilterGroups(r, JSON.stringify(doc));
  assert.ok(out);
  assert.deepEqual(JSON.parse(out.text).rsp.payload.groups, [
    { group_tag: "continue_watching", items },
    { group_tag: "[foryou][curated]_top_picks_for_you", items: [1], total_item_count: 1 },
  ]);
  assert.equal(out.header, "home-rows (1 of 3 removed, 1 trimmed)");
});

test("filter_groups ignores non-JSON and missing paths", () => {
  const r = shipped("home-rows");
  assert.equal(applyFilterGroups(r, "<html>"), undefined);
  assert.equal(applyFilterGroups(r, '{"rsp":{}}'), undefined);
});
