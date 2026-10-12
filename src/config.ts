/** Model configuration & constants — ported from Python config.py */

export interface Env {
  API_KEY: string;
  /** Upstream origin (any path is ignored). */
  UPSTREAM_URL: string;
  /** Optional proxy URL — route upstream requests through your own VPS to avoid shared CF egress IP rate limits. */
  PROXY_URL: string;
}

export interface ModelInfo {
  /** assistant-ui API identifier, e.g. "groq/openai/gpt-oss-20b" */
  id: string;
  disabled: boolean;
  contextWindow: number;
}

export interface ModelCatalog {
  /** short name -> info */
  map: Record<string, ModelInfo>;
  /** short name of the first active model */
  defaultModel: string;
}

/** Model-name suffix that routes to the docs assistant (/api/doc/chat) instead of /api/chat. */
export const DOCS_SUFFIX = "-docs";

/** Maximum length for system prompts (matches upstream validation). */
export const MAX_SYSTEM_LENGTH = 4000;

/** Upstream's own model list (single source of truth for the assistant-ui docs chat). */
const MODELS_SOURCE_URL =
  "https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/apps/docs/lib/model.ts";

/** Snapshot used when the source fetch fails. Refresh occasionally. */
const FALLBACK_SOURCE = `
  { value: "gpt-6-luna", disabled: false, contextWindow: 1_050_000 },
  { value: "google-ai-studio/gemini-3.5-flash-lite", disabled: false, contextWindow: 1_048_576 },
  { value: "grok/grok-4.3", disabled: false, contextWindow: 1_000_000 },
  { value: "deepseek/deepseek-flash", disabled: false, contextWindow: 1_048_576 },
  { value: "groq/openai/gpt-oss-20b", disabled: false, contextWindow: 131_072 },
  { value: "groq/openai/gpt-oss-120b", disabled: false, contextWindow: 131_072 },
`;

const MODEL_RE =
  /value:\s*"([^"]+)"[\s\S]{0,200}?disabled:\s*(true|false)[\s\S]{0,80}?contextWindow:\s*([\d_]+)/g;

/** "groq/openai/gpt-oss-20b" -> "gpt-oss-20b" */
function shortName(id: string): string {
  return id.split("/").pop()!;
}

export function parseCatalog(source: string): ModelCatalog {
  const map: Record<string, ModelInfo> = {};
  let defaultModel = "";
  for (const m of source.matchAll(MODEL_RE)) {
    const [, id, disabled, ctx] = m;
    const info = {
      id,
      disabled: disabled === "true",
      contextWindow: Number(ctx.replace(/_/g, "")),
    };
    map[shortName(id)] = info;
    if (!defaultModel && !info.disabled) defaultModel = shortName(id);
  }
  return { map, defaultModel };
}

const FALLBACK_CATALOG = parseCatalog(FALLBACK_SOURCE);
const TTL_MS = 60 * 60 * 1000;

let cached: ModelCatalog = FALLBACK_CATALOG;
let cachedAt = 0;

/** Fetch the live model list; falls back to the last good value (then the snapshot). */
export async function getCatalog(): Promise<ModelCatalog> {
  if (Date.now() - cachedAt < TTL_MS) return cached;
  try {
    const resp = await fetch(MODELS_SOURCE_URL, { cf: { cacheTtl: 3600 } } as RequestInit);
    if (resp.ok) {
      const catalog = parseCatalog(await resp.text());
      if (catalog.defaultModel) {
        cached = catalog;
        cachedAt = Date.now();
      }
    }
  } catch {
    // keep whatever we have
  }
  return cached;
}

/** Upstream only serves requests that look like same-origin browser fetches. */
export const UPSTREAM_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  "origin": "https://www.assistant-ui.com",
  "referer": "https://www.assistant-ui.com/",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};

/** Header carrying the signed anonymous session token (alternative to the aui_anon_session cookie). */
export const SESSION_HEADER = "x-assistant-ui-anonymous-session";
