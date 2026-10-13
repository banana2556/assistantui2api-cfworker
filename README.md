# assistantui2api-cfworker

A Cloudflare Worker that converts the [assistant-ui.com](https://www.assistant-ui.com) free chat endpoints into an **OpenAI-compatible API** (`/v1/chat/completions`).

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
- Two upstream endpoints, picked by model name: general chat (your system prompt) or the assistant-ui docs assistant
- `reasoning_effort` passthrough, with reasoning summaries returned as `reasoning_content`
- Tool / function calling
- Vision — images via URL or base64 data URI
- Handles upstream's anonymous browser session automatically
- API key authentication (timing-safe)
- Automatic retry with exponential backoff on 429
- Optional proxy support for IP rotation
- Zero cold-start on Cloudflare Workers — no Docker needed

## Models

| Model name | Upstream model | Upstream endpoint | Use it for |
|---|---|---|---|
| `gpt-6-luna` (default) | OpenAI GPT-6 Luna | `/api/chat` | General chat; supports `reasoning_effort` |
| `grok-4.3` | xAI Grok 4.3 | `/api/chat` | General chat |
| `gpt-6-luna-docs` | OpenAI GPT-6 Luna | `/api/doc/chat` | assistant-ui questions, long inputs |
| `grok-4.3-docs` | xAI Grok 4.3 | `/api/doc/chat` | assistant-ui questions, long inputs |

Every model comes in two variants:

- **`name`** → `/api/chat`: general chat. Your `system` prompt is used as-is.
- **`name-docs`** → `/api/doc/chat`: upstream's assistant-ui docs assistant. Its own
  prompt always applies and your `system` is appended after it. It can browse the
  assistant-ui docs and source (and run commands in a sandbox) on its own, and it
  accepts much longer input (see [Limits](#limits)).

Both endpoints also inject upstream's own built-in tools; only calls to tools *you*
declared in `tools` are returned as `tool_calls`.

The list is **fetched at runtime** from upstream's
[`lib/model.ts`](https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/lib/model.ts)
(cached 1 hour; a snapshot in `src/config.ts` is used if the fetch fails). Models
upstream lists but that always fail there are dropped via `REMOVED_MODELS` in
`src/config.ts` (currently Gemini, DeepSeek and both GPT-OSS). Any name not in
`GET /v1/models` returns **404**. `node test-models.mjs` checks that the upstream
list still parses.

### Limits

Enforced by upstream (verified by probing; over-limit requests return **400**).
Input sizes are characters of the JSON-serialized messages, not tokens, so the
models' own ~1M-token windows are never reached.

| | `name` (`/api/chat`) | `name-docs` (`/api/doc/chat`) |
|---|---|---|
| Total input | 96,000 chars | 480,000 chars |
| Single message | 12,000 chars | 24,000 chars |
| Messages | 20 | unlimited |
| System prompt | 4,000 chars | 4,000 chars |
| Output | 4,096 tokens (16,384 for `gpt-6-luna` with `reasoning_effort`) | 8,192 tokens |

`GET /v1/models/all` reports these per model name (`context_window` is in chars;
the model's own window is `model_context_window`).

### Reasoning

`reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`; upstream
caps it at `medium`) is passed through. Only `gpt-6-luna` on `/api/chat` uses it:

| `reasoning_effort` | Behaviour |
|---|---|
| _(omitted)_ | Reasons at `low`, no summary, output cap 4,096 |
| any value | Reasons at that level (`none` = off), output cap 16,384, summary returned as `reasoning_content` |

The summary arrives in `delta.reasoning_content` when streaming and in
`message.reasoning_content` otherwise; it may be empty for light reasoning.
`-docs` models always reason at `low` and ignore `reasoning_effort`; `grok-4.3`
ignores it.

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | No | Health check |
| `GET` | `/health` | No | Health check |
| `GET` | `/ping` | No | Pong |
| `GET` | `/v1/models` | Yes | List models |
| `GET` | `/v1/models/all` | Yes | List models with limits (and any disabled upstream) |
| `POST` | `/v1/chat/completions` | Yes | Chat completions |

## Usage

Replace `<your-worker>` with your worker's subdomain. Omit the `Authorization`
header if `API_KEY` is not set.

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

# Non-streaming, with a system prompt
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.3",
    "messages": [
      {"role": "system", "content": "You are a pirate. Always start with Arr."},
      {"role": "user", "content": "Say hi in 5 words"}
    ]
  }'

# Reasoning (response includes message.reasoning_content)
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "reasoning_effort": "medium",
    "messages": [{"role": "user", "content": "How many n < 100 make n^2 + n + 41 composite?"}]
  }'

# Docs assistant (looks things up in the assistant-ui docs itself)
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna-docs",
    "messages": [{"role": "user", "content": "What does the Thread component do?"}]
  }'
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-worker>.workers.dev/v1",
    api_key="YOUR_API_KEY",  # any string if API_KEY is not set
)

# Basic
response = client.chat.completions.create(
    model="gpt-6-luna",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)

# Streaming with reasoning: reasoning_content is an extra field on the delta
stream = client.chat.completions.create(
    model="gpt-6-luna",
    reasoning_effort="medium",
    stream=True,
    messages=[{"role": "user", "content": "Is 1001 prime? Explain briefly."}],
)
for chunk in stream:
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta
    if getattr(delta, "reasoning_content", None):
        print(delta.reasoning_content, end="")  # thinking
    if delta.content:
        print(delta.content, end="")            # answer
```

### Tool calling

```python
import json

tools = [{
    "type": "function",
    "function": {
        "name": "lookup_stock",
        "description": "Get the current stock price",
        "parameters": {
            "type": "object",
            "properties": {"ticker": {"type": "string"}},
            "required": ["ticker"],
        },
    },
}]
messages = [{"role": "user", "content": "What is TSMC (TSM) trading at?"}]

first = client.chat.completions.create(model="gpt-6-luna", tools=tools, messages=messages)
call = first.choices[0].message.tool_calls[0]  # finish_reason == "tool_calls"

messages.append(first.choices[0].message)
messages.append({
    "role": "tool",
    "tool_call_id": call.id,
    "content": json.dumps({"price": 312.5, "currency": "USD"}),  # your tool's result
})
final = client.chat.completions.create(model="gpt-6-luna", tools=tools, messages=messages)
print(final.choices[0].message.content)
```

### Vision

```python
response = client.chat.completions.create(
    model="gpt-6-luna",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What is in this image?"},
            {"type": "image_url", "image_url": {"url": "https://example.com/photo.jpg"}},
            # or {"url": "data:image/png;base64,..."}
        ],
    }],
)
```

### Errors

Errors use the OpenAI shape `{"error": {"message": "...", "type": "..."}}`:

| Status | When | Example message |
|---|---|---|
| 401 | Missing or wrong API key | `Invalid API key` |
| 404 | Model not in `/v1/models` | ``The model `gemini-3.5-flash-lite` does not exist`` |
| 400 | Over an upstream [limit](#limits) | `Too many messages (max 20)`, `Input too long`, `Single message too long` |
| 429 | Upstream rate limit, after 3 retries | `Rate limited (attempt 4/4)` |
| 502 | Upstream model error | `Upstream error: An error occurred.` |

When streaming, an error after the stream has started arrives as a final chunk
with `finish_reason: "error"` and an `error` object.

### Open WebUI / ChatBox

Set the API base URL to `https://<your-worker>.workers.dev/v1` and enter your API key.
The models appear automatically from `/v1/models`.

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

Cloudflare Workers share egress IPs, which can trigger upstream rate limits. If you hit frequent 429 errors, deploy `proxy/proxy.js` on your own VPS and set `PROXY_URL`. The worker sends its requests (the session `GET` and the chat `POST`) to your proxy with the real upstream URL in the `X-Target-URL` header.

## License

MIT
