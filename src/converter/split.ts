/**
 * Upstream rejects any message whose JSON is over a per-endpoint size ("Single message too long").
 * Oversized user messages are split into consecutive user messages that each fit.
 * No imports, so `node test-split.mjs` can load this file directly.
 */

interface Limits {
  maxInputChars: number;
  maxMessageChars: number;
  maxMessages: number | null;
}

const size = (v: unknown) => JSON.stringify(v).length;

/** Longest prefix of `text` whose JSON-escaped form fits in `room` chars. */
function fitPrefix(text: string, room: number): number {
  let n = Math.min(text.length, Math.max(room, 0));
  for (let over; n > 0 && (over = size(text.slice(0, n)) - 2 - room) > 0; ) n -= over;
  n = Math.max(n, 0);
  // Never cut a surrogate pair in half
  const c = text.charCodeAt(n - 1);
  if (n < text.length && c >= 0xd800 && c <= 0xdbff) n--;
  return n;
}

function splitMessage(msg: any, max: number): any[] {
  const chunks: any[] = [];
  let parts: any[] = [];
  const make = (p: any[]) => ({ ...msg, parts: p, id: `${msg.id}_${chunks.length}` });
  const flush = () => {
    if (parts.length) chunks.push(make(parts));
    parts = [];
  };

  for (const part of msg.parts) {
    if (part.type !== "text") {
      // Images can't be split; an oversized one still gets upstream's error
      if (size(make([...parts, part])) > max) flush();
      parts.push(part);
      continue;
    }
    let text: string = part.text ?? "";
    while (text) {
      const n = fitPrefix(text, max - size(make([...parts, { ...part, text: "" }])));
      if (n === 0 && parts.length) {
        flush();
        continue;
      }
      const take = n || text.length; // can't fit even alone: pass through for upstream to reject
      parts.push({ ...part, text: text.slice(0, take) });
      text = text.slice(take);
      if (text) flush();
    }
  }
  flush();
  return chunks;
}

/** Fold history over the count limit, then split oversized user messages, unless the result would break the total-size or count limits. */
export function splitLongUserMessages(input: any[], limits: Limits): any[] {
  const messages = foldHistory(input, limits);
  const out = messages.flatMap((m) =>
    m.role === "user" && size(m) > limits.maxMessageChars ? splitMessage(m, limits.maxMessageChars) : [m],
  );
  if (out.length === messages.length) return messages;
  if (limits.maxMessages !== null && out.length > limits.maxMessages) return messages;
  if (size(out) > limits.maxInputChars) return messages;
  return out;
}

const transcriptLine = (m: any): string => {
  const who = m.role === "assistant" ? "Assistant" : "User";
  const bits = m.parts.map((p: any) =>
    p.type === "text"
      ? p.text
      : p.type === "tool-invocation"
        ? `[called tool ${p.toolName}(${JSON.stringify(p.input)})${"output" in p ? ` -> ${JSON.stringify(p.output)}` : ""}]`
        : "",
  );
  return `${who}: ${bits.filter(Boolean).join("\n")}`;
};

/** How many messages `m` becomes after splitLongUserMessages. */
const splitCount = (m: any, max: number) => (m.role === "user" && size(m) > max ? splitMessage(m, max).length : 1);

/**
 * Over the message-count limit: fold the oldest messages into one user message holding a text
 * transcript (images kept as parts), folding just enough that the split result fits the count.
 * The last message is never folded. Unchanged if nothing fits (upstream returns its own error).
 */
export function foldHistory(messages: any[], limits: Limits): any[] {
  const max = limits.maxMessages;
  if (max === null || messages.length <= max) return messages;
  for (let k = messages.length - max + 1; k < messages.length; k++) {
    const old = messages.slice(0, k);
    const text = "Earlier conversation, folded into one message to fit the message limit:\n\n" + old.map(transcriptLine).join("\n\n");
    const files = old.flatMap((m) => m.parts.filter((p: any) => p.type === "file"));
    const folded = { role: "user", parts: [{ type: "text", text }, ...files], metadata: { custom: {} }, id: `${old[0].id}_fold` };
    const rest = messages.slice(k);
    const count = splitCount(folded, limits.maxMessageChars) + rest.reduce((n, m) => n + splitCount(m, limits.maxMessageChars), 0);
    if (count <= max) return [folded, ...rest];
  }
  return messages;
}
