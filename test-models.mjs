/**
 * Check that the live upstream model list still parses.
 * Run: node test-models.mjs
 */
import assert from "node:assert";
import { parseCatalog } from "./src/config.ts";

const url =
  "https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/apps/docs/lib/model.ts";
const { map, defaultModel } = parseCatalog(await (await fetch(url)).text());

assert.ok(Object.keys(map).length >= 3, "too few models parsed");
assert.ok(map[defaultModel] && !map[defaultModel].disabled, "bad default model");
for (const [short, info] of Object.entries(map)) {
  assert.ok(info.contextWindow > 1000, `bad contextWindow for ${short}`);
  assert.ok(info.id.endsWith(short), `short name mismatch: ${short} / ${info.id}`);
}
console.log("ok:", Object.keys(map).join(", "), "| default:", defaultModel);
