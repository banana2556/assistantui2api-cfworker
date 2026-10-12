/**
 * assistant-2api Cloudflare Worker
 *
 * Converts the free chat endpoint from assistant-ui.com
 * into an OpenAI-compatible API format.
 *
 * Ported from: https://github.com/XXXxx7258/assistant-2api (Python/FastAPI)
 */

import { type Env, DOCS_SUFFIX, getCatalog, isModelFailing, markModelFailed } from "./config";
import { openaiToAiSdk, genId } from "./converter/messages";
import {
  convertStreamToOpenAI,
  parseFullResponse,
  ModelError,
  buildNonStreamResponse,
} from "./converter/stream";
import { callUpstreamStream, callUpstreamFull, UpstreamError } from "./provider";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function jsonResponse(data: any, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });
}

function errorResponse(message: string, type: string, status = 400): Response {
  return jsonResponse({ error: { message, type } }, status);
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

/* ------------------------------------------------------------------ */
/*  Auth                                                              */
/* ------------------------------------------------------------------ */

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.API_KEY) return true;
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const encoder = new TextEncoder();
  const a = encoder.encode(token);
  const b = encoder.encode(env.API_KEY);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/*  Route handlers                                                    */
/* ------------------------------------------------------------------ */

/** GET / — health check */
function handleRoot(): Response {
  return jsonResponse({ status: "ok", service: "assistant-2api (CF Worker)" });
}

/** GET /health */
function handleHealth(): Response {
  return jsonResponse({ status: "ok" });
}

/**
 * GET /v1/models — active models (GET /v1/models/all includes disabled ones).
 * Each model is listed twice: `name` -> /api/chat (your system prompt),
 * `name-docs` -> /api/doc/chat (upstream's docs assistant).
 */
async function handleModels(all: boolean): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const { map } = await getCatalog();
  const data = Object.entries(map)
    .filter(([shortName, info]) => all || (!info.disabled && !isModelFailing(shortName)))
    .flatMap(([shortName, info]) =>
      ["", DOCS_SUFFIX].map((suffix) => ({
        id: shortName + suffix,
        object: "model",
        created: now,
        owned_by: info.id.includes("/") ? info.id.split("/")[0] : "openai",
        ...(all
          ? { disabled: info.disabled, failing: isModelFailing(shortName), context_window: info.contextWindow }
          : {}),
      })),
    );
  return jsonResponse({ object: "list", data });
}

/** POST /v1/chat/completions — OpenAI-compatible chat */
async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", "invalid_request_error");
  }

  const catalog = await getCatalog();
  const requestId = `chatcmpl-${genId("", 24)}`;
  const model = body.model || catalog.defaultModel;
  const docs = model.endsWith(DOCS_SUFFIX);
  const upstreamModel = docs ? model.slice(0, -DOCS_SUFFIX.length) : model;
  const stream = body.stream === true;
  const tools = body.tools || null;
  // Upstream injects its own tools on both endpoints; only forward calls to tools the client declared.
  const clientTools = new Set<string>((tools || []).map((t: any) => t?.function?.name));

  // Convert OpenAI format to AI SDK v6 format
  let payload: Record<string, any>;
  try {
    payload = openaiToAiSdk(body.messages || [], upstreamModel, catalog, tools);
  } catch (e: any) {
    return errorResponse(`Invalid request: ${e.message}`, "invalid_request_error");
  }

  // Only the origin of UPSTREAM_URL is used; the path is picked per model.
  const origin = new URL(env.UPSTREAM_URL || "https://www.assistant-ui.com").origin;
  const upstreamUrl = origin + (docs ? "/api/doc/chat" : "/api/chat");
  const proxyUrl = env.PROXY_URL || undefined;

  if (stream) {
    // Streaming mode
    try {
      const upstreamResp = await callUpstreamStream(payload, upstreamUrl, proxyUrl);
      if (!upstreamResp.body) {
        return errorResponse("No response body from upstream", "upstream_error", 502);
      }
      const openaiStream = convertStreamToOpenAI(upstreamResp.body, model, requestId, clientTools, () =>
        markModelFailed(upstreamModel),
      );
      return new Response(openaiStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (e: any) {
      if (e instanceof UpstreamError) {
        return errorResponse(e.message, "upstream_error", e.statusCode);
      }
      return errorResponse(`Upstream error: ${e.message}`, "upstream_error", 502);
    }
  }

  // Non-streaming mode
  try {
    const fullBody = await callUpstreamFull(payload, upstreamUrl, proxyUrl);
    const parsed = parseFullResponse(fullBody, clientTools);
    return jsonResponse(
      buildNonStreamResponse(
        requestId,
        model,
        parsed.content,
        parsed.finishReason,
        parsed.usage,
        parsed.toolCalls.length > 0 ? parsed.toolCalls : null,
      ),
    );
  } catch (e: any) {
    if (e instanceof UpstreamError) {
      return errorResponse(e.message, "upstream_error", e.statusCode);
    }
    if (e instanceof ModelError) markModelFailed(upstreamModel);
    return errorResponse(`Upstream error: ${e.message}`, "upstream_error", 502);
  }
}

/* ------------------------------------------------------------------ */
/*  Main Worker Entry                                                 */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Public endpoints (no auth)
    if (path === "/" || path === "") return handleRoot();
    if (path === "/health") return handleHealth();
    if (path === "/ping") return jsonResponse({ message: "pong" });

    // Auth check for API endpoints
    if (!isAuthorized(request, env)) {
      return errorResponse("Invalid API key", "auth_error", 401);
    }

    // Route dispatch
    if (request.method === "GET" && path === "/v1/models") {
      return handleModels(false);
    }
    if (request.method === "GET" && path === "/v1/models/all") {
      return handleModels(true);
    }
    if (request.method === "POST" && path === "/v1/chat/completions") {
      return handleChatCompletions(request, env);
    }

    return errorResponse("Not Found", "not_found", 404);
  },
};
