# SWU AI Gateway

Express.js gateway for the SWU AI backend with legacy `/chat`, OpenAI-compatible chat completions, tool/function calling, streaming, vision, image generation, and a lightweight Responses API compatibility layer.

## Endpoints

- `POST /chat` legacy multipart frontend route: `message`, `model`, optional `image`.
- `GET /v1/models` OpenAI-compatible model list.
- `POST /v1/chat/completions` OpenAI-compatible chat, vision, streaming, and tool calls.
- `POST /v1/responses` OpenAI Responses-style text and function-call output.
- `POST /generate-image` legacy image generation.
- `POST /v1/images/generations` OpenAI-style image generation response.

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
TOOLS_COMPAT_MODE=true
TOOLS_RETRY_MAX=1
```

If `API_KEY` is set, requests require:

```http
Authorization: Bearer sk-your-gateway-key
```

If `API_KEY` is not set, requests are allowed without authentication.

`TOOLS_COMPAT_MODE=true` is recommended for SWU backends that do not natively implement OpenAI tool calls. The gateway injects a structured tool-use prompt, parses JSON safely, validates arguments against the provided function schema, and retries malformed tool JSON.

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

Chat:

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

Tool calling:

```bash
curl "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-3-flash-preview",
    "messages": [
      { "role": "user", "content": "What is the weather in Bangkok?" }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get weather for a city",
          "parameters": {
            "type": "object",
            "properties": {
              "city": { "type": "string" }
            },
            "required": ["city"]
          }
        }
      }
    ],
    "tool_choice": "auto"
  }'
```

Expected tool response shape:

```json
{
  "object": "chat.completion",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_...",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"Bangkok\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

Streaming tool calls:

```bash
curl -N "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-3-flash-preview",
    "stream": true,
    "messages": [
      { "role": "user", "content": "What is the weather in Bangkok?" }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "parameters": {
            "type": "object",
            "properties": {
              "city": { "type": "string" }
            },
            "required": ["city"]
          }
        }
      }
    ]
  }'
```

Responses API function call:

```bash
curl "$BASE_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-3-flash-preview",
    "input": "What is the weather in Bangkok?",
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string" }
          },
          "required": ["city"]
        }
      }
    ]
  }'
```

After executing a Responses API function call, send the tool result back as `function_call_output`:

```json
{
  "model": "google/gemini-3-flash-preview",
  "input": [
    {
      "type": "function_call",
      "call_id": "call_...",
      "name": "get_weather",
      "arguments": "{\"city\":\"Bangkok\"}"
    },
    {
      "type": "function_call_output",
      "call_id": "call_...",
      "output": "32C and clear"
    }
  ]
}
```

Vision with a data URL:

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
            "image_url": { "url": "data:image/png;base64,..." }
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

## n8n AI Agent

Use the AI Agent node with an OpenAI Chat Model:

- Credential type: OpenAI API
- Base URL: `https://YOUR-CLOUD-RUN-URL/v1`
- API key: your `API_KEY`, or any placeholder when `API_KEY` is not configured
- Model: `google/gemini-3-flash-preview`
- Enable tools on the AI Agent node and connect tool nodes normally

For best tool compatibility set:

```bash
TOOLS_COMPAT_MODE=true
TOOLS_RETRY_MAX=1
```

n8n will send OpenAI-style `tools`; the gateway returns OpenAI-style `tool_calls` with `finish_reason: "tool_calls"`.

## OpenAI SDK Tools

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.API_KEY || "not-required",
  baseURL: "https://YOUR-CLOUD-RUN-URL/v1"
});

const response = await client.chat.completions.create({
  model: "google/gemini-3-flash-preview",
  messages: [
    { role: "user", content: "What is the weather in Bangkok?" }
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" }
          },
          required: ["city"]
        }
      }
    }
  ],
  tool_choice: "auto"
});

const message = response.choices[0].message;

if (message.tool_calls) {
  for (const toolCall of message.tool_calls) {
    const args = JSON.parse(toolCall.function.arguments);
    console.log(toolCall.function.name, args);
  }
} else {
  console.log(message.content);
}
```

## LangChain Tools

```js
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(
  async ({ city }) => `Weather in ${city}: 32C`,
  {
    name: "get_weather",
    description: "Get weather for a city",
    schema: z.object({
      city: z.string()
    })
  }
);

const model = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  apiKey: process.env.API_KEY || "not-required",
  configuration: {
    baseURL: "https://YOUR-CLOUD-RUN-URL/v1"
  }
}).bindTools([getWeather]);

const result = await model.invoke("What is the weather in Bangkok?");
console.log(result.tool_calls || result.content);
```

## Open WebUI, LibreChat, Flowise, Vercel AI SDK

Use OpenAI-compatible settings:

- Base URL: `https://YOUR-CLOUD-RUN-URL/v1`
- API key: your `API_KEY`, or a placeholder if auth is disabled
- Models endpoint: `/models`
- Chat completions endpoint: `/chat/completions`
- Responses endpoint: `/responses`
- Model ID: select one from the allowlist above

## Cloud Run Notes

- Uploads use `multer.memoryStorage()`.
- No local disk writes, temp files, or GCS writes are used.
- Image uploads are validated by declared MIME and file signature.
- Request, body, upload, and rate limits are configurable by env vars.
- Set `CORS_ORIGIN` to exact frontend origins in production.

## Run

```bash
npm install
npm start
```
