/**
 * Check that oversized user messages are split losslessly and within limits.
 * Run: node test-split.mjs
 */
import assert from "node:assert";
import { splitLongUserMessages } from "./src/converter/split.ts";

const limits = { maxInputChars: 96_000, maxMessageChars: 12_000, maxMessages: 20 };
const user = (parts) => ({ role: "user", parts, metadata: { custom: {} }, id: "msg_abcdefghijkl" });
const text = (t) => ({ type: "text", text: t });
const textOf = (msgs) => msgs.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text)).join("");

// Mixed content: newlines/quotes escape to 2 chars, emoji are surrogate pairs, CJK is 1 char
const long = 'line "one"\n中文內容😀'.repeat(3000);
const out = splitLongUserMessages([user([text(long), { type: "file", mediaType: "image/png", url: "data:x" }])], limits);
assert.ok(out.length > 1, "not split");
assert.strictEqual(textOf(out), long, "text changed");
for (const m of out) assert.ok(JSON.stringify(m).length <= limits.maxMessageChars, "chunk too big");
assert.strictEqual(new Set(out.map((m) => m.id)).size, out.length, "duplicate ids");
assert.ok(out.at(-1).parts.some((p) => p.type === "file"), "image lost");

// Small messages and non-user messages are left alone
const small = [user([text("hi")]), { role: "assistant", parts: [text("x".repeat(20_000))], id: "a" }];
assert.strictEqual(splitLongUserMessages(small, limits), small);

// Over the total or the count limit after splitting: unchanged (upstream returns its own error)
const huge = [user([text("x".repeat(100_000))])];
assert.strictEqual(splitLongUserMessages(huge, limits), huge);
const many = Array.from({ length: 19 }, () => user([text("x".repeat(13_000 / 4))])).concat(user([text("x".repeat(13_000))]));
assert.strictEqual(splitLongUserMessages(many, limits), many);

console.log("ok:", out.length, "chunks");

// Over the count limit: oldest messages folded into one transcript, last message kept, images kept
const asst = (t) => ({ role: "assistant", parts: [text(t)], metadata: { custom: {} }, id: "msg_a" });
const chat = [];
for (let i = 1; i <= 30; i++) chat.push(user([text(`item ${i}`)]), asst(`ok ${i}`));
chat[0].parts.push({ type: "file", mediaType: "image/png", url: "https://x/img/1" });
chat.push(user([text("final question")]));
const folded = splitLongUserMessages(chat, limits);
assert.ok(folded.length <= limits.maxMessages, `still ${folded.length} msgs`);
assert.strictEqual(folded.at(-1).parts[0].text, "final question");
assert.ok(textOf(folded).includes("User: item 1\n") && textOf(folded).includes("Assistant: ok 1"), "history lost");
assert.ok(folded[0].parts.some((p) => p.type === "file"), "folded image lost");
// Long history: the folded transcript is itself split, and the total still fits the count
const big = Array.from({ length: 40 }, (_, i) => (i % 2 ? asst : user)([text("y".repeat(1500))]));
const bigOut = splitLongUserMessages(big, limits);
assert.ok(bigOut.length <= limits.maxMessages && bigOut.length > 1, `bad fold: ${bigOut.length}`);
for (const m of bigOut) assert.ok(JSON.stringify(m).length <= limits.maxMessageChars, "folded chunk too big");
console.log("ok: folded", chat.length, "->", folded.length, "and", big.length, "->", bigOut.length);
