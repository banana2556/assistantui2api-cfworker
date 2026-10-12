/**
 * Call the assistant-ui upstream LLM endpoint.
 * Supports retry with exponential backoff for 429 rate limits,
 * and optional proxy URL for IP rotation.
 */

import { SESSION_HEADER, UPSTREAM_HEADERS } from "./config";

export class UpstreamError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "UpstreamError";
  }
}

/** Max retries on 429 */
const MAX_RETRIES = 3;

/** Base delay in ms (will be multiplied by 2^attempt + jitter) */
const BASE_DELAY_MS = 2000;

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random jitter between 0 and max ms */
function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

/**
 * Build the actual target URL.
 *
 * If PROXY_URL is set (e.g. "https://my-vps.example.com/proxy"),
 * the request is sent there with the real upstream in X-Target-URL header.
 * Otherwise, directly hits the upstream.
 */
function getTargetUrl(upstreamUrl: string, proxyUrl?: string): string {
  return proxyUrl || upstreamUrl;
}

function getHeaders(upstreamUrl: string, proxyUrl?: string): Record<string, string> {
  const headers = { ...UPSTREAM_HEADERS };
  if (proxyUrl) {
    headers["X-Target-URL"] = upstreamUrl;
  }
  return headers;
}

/** Anonymous session token, cached per isolate. Upstream issues it for 24h. */
let session: { token: string; exp: number } | null = null;

/** Fetch (or reuse) the signed `aui_anon_session` token that /api/doc/chat requires. */
async function getSessionToken(upstreamUrl: string, proxyUrl?: string, force = false): Promise<string> {
  if (!force && session && session.exp > Date.now() + 60_000) return session.token;

  const sessionUrl = new URL("/api/anonymous-session", upstreamUrl).href;
  const resp = await fetch(getTargetUrl(sessionUrl, proxyUrl), {
    headers: getHeaders(sessionUrl, proxyUrl),
  });
  // Same origin -> 204 + Set-Cookie; other origins -> JSON { token }
  const text = await resp.text();
  const token =
    resp.headers.get("set-cookie")?.match(/aui_anon_session=([^;]+)/)?.[1] ??
    (text.startsWith("{") ? JSON.parse(text).token : undefined);
  if (!resp.ok || !token) {
    throw new UpstreamError(resp.status >= 400 ? resp.status : 502, `Anonymous session failed: ${text.slice(0, 200)}`);
  }

  const exp = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))).exp;
  session = { token, exp };
  return token;
}

/**
 * POST to assistant-ui with retry on 429.
 * Returns the raw Response (for streaming — caller reads response.body).
 */
export async function callUpstreamStream(
  payload: Record<string, any>,
  upstreamUrl: string,
  proxyUrl?: string,
): Promise<Response> {
  const targetUrl = getTargetUrl(upstreamUrl, proxyUrl);
  const headers = getHeaders(upstreamUrl, proxyUrl);
  headers[SESSION_HEADER] = await getSessionToken(upstreamUrl, proxyUrl);

  let lastError: UpstreamError | null = null;
  let refreshed = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 2s, 4s, 8s + random jitter (0-1s)
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + jitter(1000);
      await sleep(delay);
    }

    const resp = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (resp.status === 429) {
      lastError = new UpstreamError(
        429,
        `Rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
      );
      // Consume body to free connection
      await resp.text().catch(() => {});
      continue;
    }

    // Session expired/revoked: get a fresh one and retry once
    if (resp.status === 401 && !refreshed) {
      refreshed = true;
      await resp.text().catch(() => {});
      headers[SESSION_HEADER] = await getSessionToken(upstreamUrl, proxyUrl, true);
      attempt--;
      continue;
    }

    if (resp.status >= 400) {
      const body = await resp.text();
      throw new UpstreamError(resp.status, body.slice(0, 200));
    }

    return resp;
  }

  // All retries exhausted
  throw lastError || new UpstreamError(429, "Rate limit exceeded after all retries");
}

/**
 * POST to assistant-ui and collect the full response body (for non-stream mode).
 */
export async function callUpstreamFull(
  payload: Record<string, any>,
  upstreamUrl: string,
  proxyUrl?: string,
): Promise<string> {
  const resp = await callUpstreamStream(payload, upstreamUrl, proxyUrl);
  return await resp.text();
}
