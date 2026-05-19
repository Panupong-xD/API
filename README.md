# SWU AI Gateway

Express.js gateway for the SWU AI backend with the existing legacy `/chat` route plus OpenAI-compatible `/v1` routes.

## Endpoints

- `POST /chat` keeps the existing multipart frontend contract: `message`, `model`, optional `image`.
- `POST /v1/chat/completions` accepts OpenAI-compatible chat completion requests.
- `GET /v1/models` returns the allowed SWU model list in OpenAI-compatible format.
- `POST /generate-image` keeps the existing image generation contract.
- `POST /v1/images/generations` returns an OpenAI-style image generation response.

## Environment

Required:

```bash
SWU_USER="your-swu-user"
SWU_PASSWORD="your-swu-password"
```

Optional:

```bash
PORT=8080
DEFAULT_MODEL="google/gemini-3-flash-preview"
API_KEY="sk-your-gateway-key"
CORS_ORIGIN="https://your-frontend.example"
UPLOAD_MAX_BYTES=5242880
JSON_BODY_LIMIT="12mb"
REQUEST_TIMEOUT_MS=70000
API_TIMEOUT_MS=60000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
TRUST_PROXY_HOPS=1
ALLOW_REMOTE_IMAGE_URLS=true
ALLOWED_IMAGE_MIME_TYPES="image/png,image/jpeg,image/webp,image/gif"
```

If `API_KEY` is set, every API route requires:

```http
Authorization: Bearer sk-your-gateway-key
```

If `API_KEY` is not set, requests are allowed without authentication.

## Models

Allowed models:

```text
openai/gpt-5
openai/gpt-5.2
openai/gpt-5.4-mini
openai/gpt-5.4-nano
google/gemini-3-flash-preview
google/gemini-3.1-pro-preview
google/gemini-2.5-flash-image
google/gemini-3-pro-image-preview
anthropic/claude-sonnet-4.6
anthropic/claude-opus-4.6
deepseek-v4-flash
deepseek-v4-pro
qwen/qwen3-max-thinking
meta-llama/llama-4-maverick
x-ai/grok-4.1-fast
z-ai/glm-5
```

Unknown models are rejected.

## Curl

List models:

```bash
curl "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

OpenAI-compatible chat:

```bash
curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-3-flash-preview",
    "messages": [
      { "role": "user", "content": "hello" }
    ]
  }'
```

OpenAI-compatible vision with a data URL:

```bash
curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash-image",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "describe image" },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,..."
            }
          }
        ]
      }
    ]
  }'
```

Legacy multipart `/chat`:

```bash
curl "$BASE_URL/chat" \
  -H "Authorization: Bearer $API_KEY" \
  -F "model=google/gemini-3-flash-preview" \
  -F "message=describe this image" \
  -F "image=@./image.png"
```

Streaming:

```bash
curl -N "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-5",
    "stream": true,
    "messages": [
      { "role": "user", "content": "write one sentence" }
    ]
  }'
```

## n8n AI Agent

Use an OpenAI Chat Model credential/node with:

- Base URL: `https://YOUR-CLOUD-RUN-URL/v1`
- API key: your `API_KEY`, or any placeholder if `API_KEY` is not configured
- Model: one of the allowed model IDs, for example `google/gemini-3-flash-preview`
- Chat endpoint: `/chat/completions`

## OpenAI SDK

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.API_KEY || "not-required",
  baseURL: "https://YOUR-CLOUD-RUN-URL/v1"
});

const response = await client.chat.completions.create({
  model: "google/gemini-3-flash-preview",
  messages: [
    { role: "user", content: "hello" }
  ]
});

console.log(response.choices[0].message.content);
```

## Open WebUI, LibreChat, Flowise, LangChain, Vercel AI SDK

Use OpenAI-compatible settings:

- Base URL: `https://YOUR-CLOUD-RUN-URL/v1`
- API key: your `API_KEY`, or a placeholder if auth is disabled
- Models endpoint: `/models`
- Chat completions endpoint: `/chat/completions`
- Model ID: select one from the allowlist above

## Run

```bash
npm install
npm start
```

