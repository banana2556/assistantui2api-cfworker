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

/** Split oversized user messages, unless the result would break the total-size or count limits. */
export function splitLongUserMessages(messages: any[], limits: Limits): any[] {
  const out = messages.flatMap((m) =>
    m.role === "user" && size(m) > limits.maxMessageChars ? splitMessage(m, limits.maxMessageChars) : [m],
  );
  if (out.length === messages.length) return messages;
  if (limits.maxMessages !== null && out.length > limits.maxMessages) return messages;
  if (size(out) > limits.maxInputChars) return messages;
  return out;
}
