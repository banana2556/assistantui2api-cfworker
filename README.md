# assistantui2api-cfworker

A Cloudflare Worker that converts the [assistant-ui.com](https://www.assistant-ui.com) free chat endpoint into an **OpenAI-compatible API** (`/v1/chat/completions`).

Use it as a drop-in backend for any tool that speaks the OpenAI format — [Open WebUI](https://github.com/open-webui/open-webui), ChatBox, IDE extensions, CLI clients, etc.

> Ported from the Python/FastAPI version: [XXXxx7258/assistant-2api](https://github.com/XXXxx7258/assistant-2api)

## One-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/banana2556/assistantui2api-cfworker)

After deploying, **set an API key** to protect your endpoint:

```bash
npx wrangler secret put API_KEY
```

## Features

- OpenAI-compatible `/v1/chat/completions` (streaming & non-streaming)
- Tool / function calling support
- Vision — images via URL or base64 data URI
- System prompt passthrough
- API key authentication (timing-safe)
- Automatic retry with exponential backoff on 429
- Optional proxy support for IP rotation
- Zero cold-start on Cloudflare Workers — no Docker needed

## Available Models

The model list is **not hardcoded** — it is fetched at runtime from upstream's own
[`lib/model.ts`](https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/lib/model.ts)
and cached for 1 hour (a snapshot in `src/config.ts` is used if that fetch fails).
Model names are the last path segment of the upstream id, and the first active
model is the default.

Models that upstream lists but that always fail there are dropped
(`REMOVED_MODELS` in `src/config.ts`: Gemini, DeepSeek and both GPT-OSS).

As of writing:

| Model | Provider |
|---|---|
| `gpt-6-luna` (default) | OpenAI |
| `grok-4.3` | xAI |

Every model is exposed under two names, one per upstream endpoint:

| Name | Upstream | Behaviour |
|---|---|---|
| `gpt-6-luna` | `/api/chat` | General chat — your `system` prompt is used as-is. |
| `gpt-6-luna-docs` | `/api/doc/chat` | assistant-ui docs assistant — upstream's fixed prompt, your `system` is appended as page context; it can read the docs/source itself. |

Both endpoints also carry upstream's own built-in tools; only calls to tools
*you* declared in `tools` are returned as `tool_calls`.

### Limits

Upstream enforces these (verified by probing; over-limit requests return 400).
Input sizes are characters of the JSON-serialized messages, not tokens — the
models' own ~1M-token windows are never reached.

| | `name` (`/api/chat`) | `name-docs` (`/api/doc/chat`) |
|---|---|---|
| Total input | 96,000 chars | 480,000 chars |
| Single message | 12,000 chars | 24,000 chars |
| Messages | 20 | unlimited |
| System prompt | 4,000 chars | 4,000 chars |
| Output | 4,096 tokens (16,384 for `gpt-6-luna` with `reasoning_effort`) | 8,192 tokens |

`reasoning_effort` (`none`…`xhigh`, capped at `medium` upstream) is passed through;
only reasoning models (`gpt-6-luna`) use it. `GET /v1/models/all` reports these
limits per model name.

Use `GET /v1/models` for the live list. `node test-models.mjs` verifies the
upstream list still parses.

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | No | Health check |
| `GET` | `/health` | No | Health check |
| `GET` | `/ping` | No | Pong |
| `GET` | `/v1/models` | Yes | List active models |
| `GET` | `/v1/models/all` | Yes | List all models (including disabled) |
| `POST` | `/v1/chat/completions` | Yes | Chat completions |

## Usage

### curl

```bash
# Streaming
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Non-streaming
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-worker>.workers.dev/v1",
    api_key="YOUR_API_KEY",
)

response = client.chat.completions.create(
    model="gpt-6-luna",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### Open WebUI / ChatBox

Set the API base URL to `https://<your-worker>.workers.dev/v1` and enter your API key.

## Manual Deploy

```bash
git clone https://github.com/banana2556/assistantui2api-cfworker.git
cd assistantui2api-cfworker
npm install
npx wrangler login
npx wrangler deploy
```

## Local Development

```bash
npm run dev
```

Create `.dev.vars` for local secrets (this file is gitignored):

```
API_KEY=test-key
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_KEY` | No | _(empty = open access)_ | Bearer token. **Set via `wrangler secret put`**, not in `wrangler.toml`. |
| `UPSTREAM_URL` | No | `https://www.assistant-ui.com` | Upstream origin (path ignored; picked per model). |
| `PROXY_URL` | No | _(empty)_ | Reverse-proxy URL for IP rotation (see below). |

### Proxy Mode

Cloudflare Workers share egress IPs, which can trigger upstream rate limits. If you hit frequent 429 errors, deploy a reverse proxy on your own VPS and set `PROXY_URL`. The worker sends requests to your proxy with the real upstream URL in the `X-Target-URL` header.

## License

MIT
