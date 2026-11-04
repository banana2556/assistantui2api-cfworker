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
- `reasoning_effort` passthrough, with reasoning summaries returned as `reasoning_content` (no current model returns one, see [Reasoning](#reasoning))
- Tool / function calling
- Vision — images via URL or base64 data URI (large base64 images need the optional [KV binding](#images))
- Long chats: history over upstream's 20-message cap is folded automatically
- Handles upstream's anonymous browser session automatically
- API key authentication (timing-safe)
- Automatic retry with exponential backoff on 429
- Optional proxy support for IP rotation
- Zero cold-start on Cloudflare Workers — no Docker needed

## Models

| Model name | Upstream model | Vision |
|---|---|---|
| `deepseek-flash` (default) | DeepSeek V4.1 Flash | Yes |
| `gpt-6-luna` | OpenAI GPT-6 Luna (reasoning) | Yes |
| `claude-haiku-5-5` | Anthropic Claude Haiku 5.5 | Yes |
| `glm-5.3-flash` | Z.ai GLM-5.3-Flash | Yes |

> **Note (probed 2026-11-04):** `deepseek-flash`, `gpt-6-luna` and `claude-haiku-5-5`
> all call themselves Claude and report byte-identical token counts for the same
> input, so upstream appears to serve all three with the same model for anonymous
> sessions (upstream marks `gpt-6-luna` and `claude-haiku-5-5` as `signInRequired`).
> `glm-5.3-flash` is a distinct model. Upstream also adds ~11k tokens of its own
> system prompt and tools to every request.

Every model comes in two variants, e.g. `glm-5.3-flash` and `glm-5.3-flash-docs`:

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
`src/config.ts` (currently none). Any name not in `GET /v1/models` returns **404**,
including models upstream has since dropped (e.g. `kimi-k3`, `mimo-v2.6-pro`).
`node test-models.mjs` checks that the upstream list still parses.

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
| Output | 4,096 tokens (16,384 for reasoning models with `reasoning_effort`) | 8,192 tokens |

A user message over the single-message limit is **split automatically** into
consecutive user messages that each fit, as long as the result stays within the
total and message-count limits; otherwise it is sent as-is and upstream's 400 is
returned. Other roles are never split.

A conversation over the **20-message** cap of `name` models is **folded**: the oldest
messages are merged into one leading user message holding a plain-text transcript
(`User: …` / `Assistant: …`, tool calls and results included, images kept), folding
just enough to fit. The latest message is never folded. Tested with 101 messages:
both the first and the last items of the history were still recalled. The total
input limit still applies, so for very long chats use a `-docs` model (no message
cap, 5× the input). `node test-split.mjs` checks the splitting and folding.

`GET /v1/models/all` reports these per model name (`context_window` is in chars;
the model's own window is `model_context_window`).

### Reasoning

`reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`; upstream
caps it at `medium`) is passed through, and any reasoning summary comes back in
`delta.reasoning_content` when streaming and in `message.reasoning_content` otherwise.
On `/api/chat` it also raises a reasoning model's output cap to 16,384 tokens.

Upstream marks `gpt-6-luna` as reasoning-capable (shown in `GET /v1/models/all` as
`max_output_tokens: 16384` with `max_output_tokens_note`), but with an anonymous
session it currently returns no `reasoning_content` (see the note under [Models](#models)).

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | No | Health check |
| `GET` | `/health` | No | Health check |
| `GET` | `/ping` | No | Pong |
| `GET` | `/img/:key` | No | Serves a base64 image moved to KV (random key, expires after 1 hour) |
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
    "model": "deepseek-flash",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Non-streaming, with a system prompt
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.3-flash",
    "messages": [
      {"role": "system", "content": "You are a pirate. Always start with Arr."},
      {"role": "user", "content": "Say hi in 5 words"}
    ]
  }'

# Docs assistant (looks things up in the assistant-ui docs itself)
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash-docs",
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
    model="deepseek-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="glm-5.3-flash",
    stream=True,
    messages=[{"role": "user", "content": "Is 1001 prime? Explain briefly."}],
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
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

first = client.chat.completions.create(model="deepseek-flash", tools=tools, messages=messages)
call = first.choices[0].message.tool_calls[0]  # finish_reason == "tool_calls"

messages.append(first.choices[0].message)
messages.append({
    "role": "tool",
    "tool_call_id": call.id,
    "content": json.dumps({"price": 312.5, "currency": "USD"}),  # your tool's result
})
final = client.chat.completions.create(model="deepseek-flash", tools=tools, messages=messages)
print(final.choices[0].message.content)
```

### Vision

All current models accept images, several per message.

```python
response = client.chat.completions.create(
    model="deepseek-flash",
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

#### Images

Upstream has no upload endpoint and counts a base64 data URI as message text, so
inline images only fit while the whole message stays under the per-message limit:
roughly **12 KB** of base64 on `name` models (about a 60×60 photo) and **24 KB** on
`-docs`. Anything bigger fails with `Single message too long` / `Input too long`.

- **Image URLs** always fit. Upstream downloads them itself, so the host must allow
  that (GitHub avatars work; Wikimedia returns 502).
- **Large base64 images** work once you bind a KV namespace named `IMAGES`. The worker
  then stores any data URI over 2,000 chars in KV for 1 hour and sends upstream a
  `https://<your-worker>/img/<random key>` URL instead:

  ```bash
  npx wrangler kv namespace create IMAGES
  # paste the printed id into the [[kv_namespaces]] block in wrangler.toml, uncomment it, then
  npx wrangler deploy
  ```

  The `/img/` route is public (upstream has to fetch it); keys are 32 random characters.
  KV's free tier allows 1,000 writes a day, i.e. 1,000 large images. This doesn't work
  under `wrangler dev`, because upstream can't reach localhost.

### Errors

Errors use the OpenAI shape `{"error": {"message": "...", "type": "..."}}`:

| Status | When | Example message |
|---|---|---|
| 401 | Missing or wrong API key | `Invalid API key` |
| 404 | Model not in `/v1/models` | ``The model `kimi-k3` does not exist`` |
| 400 | Over an upstream [limit](#limits) (after splitting and folding), or a large base64 image without [KV](#images) | `Input too long`, `Single message too long`, `Too many messages (max 20)` |
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
| `IMAGES` (KV binding) | No | _(unbound)_ | Hosts large base64 images; see [Images](#images). |

### Proxy Mode

Cloudflare Workers share egress IPs, which can trigger upstream rate limits. If you hit frequent 429 errors, deploy `proxy/proxy.js` on your own VPS and set `PROXY_URL`. The worker sends its requests (the session `GET` and the chat `POST`) to your proxy with the real upstream URL in the `X-Target-URL` header.

## License

MIT
