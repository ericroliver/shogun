# Enigma OpenAI-Compatible Endpoints — Developer Manual

## Overview

Enigma exposes two endpoints that implement the [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat) wire format. This lets you use any OpenAI SDK (Python, JavaScript/TypeScript, Go, etc.) or any tool that speaks the OpenAI protocol (LangChain, LlamaIndex, Continue, etc.) to talk to **running Enigma agents** without writing custom integration code.

The core idea is simple: **the `model` field in every request maps to a running Enigma agent name.** Instead of choosing between `gpt-4o` or `claude-3-opus`, you choose which Enigma agent you want to talk to — `enigma-prime`, `shogun-sword`, `ab-sword`, or any other agent you've started.

### Endpoints at a Glance

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/v1/models` | List all running agents as OpenAI model objects |
| `POST` | `/v1/chat/completions` | Send a chat turn to a named agent |

---

## How It Works

### The Model → Agent Mapping

In the standard OpenAI API, the `model` field selects a language model (`gpt-4o`, `text-davinci-003`, etc.). In Enigma, the `model` field selects **which running agent session to route the request to**.

```
POST /v1/chat/completions
{
  "model": "enigma-prime",      ← must match a running agent name
  "messages": [
    { "role": "user", "content": "Refactor the empty catch blocks in HomeController.vb" }
  ]
}
```

The agent must already be running (status = `Ready`). If the agent isn't running or doesn't exist, you'll get an HTTP 404 error.

### Message Handling

Only the **last `user` role message** in the `messages` array is forwarded to the agent as work. All other messages are accepted but silently ignored:

- `system` messages — agents manage their own personas through their configuration; system prompts have no effect.
- `assistant` messages — accepted for SDK compatibility but ignored.
- Prior `user` messages — ignored; only the last user message is sent.

If your use case requires conversation history or multi-turn context, include it within the content of the last user message.

### Streaming vs Non-Streaming

| Mode | `stream` field | Behavior |
|------|----------------|----------|
| Non-streaming | `false` (default) | Waits for the agent to finish, returns a single `ChatCompletion` JSON object. Timeout: 5 minutes. |
| Streaming | `true` | Returns Server-Sent Events (SSE) chunks in OpenAI streaming format as the agent produces output. |

Streaming uses the standard OpenAI SSE wire format:
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}\n\n
data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...}\n\n
data: [DONE]\n\n
```

The first chunk includes `"role":"assistant"` in the delta. Subsequent chunks carry only `content`. The final chunk includes `"finish_reason":"stop"`.

---

## Prerequisites

### 1. Enigma API Server Running

The Enigma API server must be running and accessible. By default, it listens on **port 3080**.

```bash
# From source
cd src/Enigma.Api && dotnet run

# Or via Docker
./docker-run.sh /path/to/enigma-home /path/to/your/codebase
```

### 2. Authentication (If Enabled)

If the Enigma server has `Authentication:Enabled` set to `true` in its configuration, most endpoints require a Bearer token or API key. The exceptions are:

- `GET /v1/models` — always public (no auth required)
- `POST /v1/chat/completions` — **requires authentication** when auth is enabled

To authenticate, include an `Authorization` header:

```
Authorization: Bearer <your-token>
```

> **Note:** If authentication is disabled (the default for development), no header is needed.

### 3. Agent Must Be Running

The agent you want to talk to must be spawned and in the `Ready` status before you can send chat completions to it.

**Start a persisted agent** (defined in `workspace.json`):
```bash
curl -X POST http://localhost:3080/api/agents/enigma-prime/start
```

**Spawn an ephemeral agent:**
```bash
curl -X POST http://localhost:3080/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "binary": "/usr/local/bin/my-agent",
    "args": ["--verbose"]
  }'
```

**Check which agents are running:**
```bash
curl http://localhost:3080/api/agents
```

Or use the OpenAI-compatible models endpoint:
```bash
curl http://localhost:3080/v1/models
```

---

## Endpoint Reference

### GET /v1/models

Lists all running agents as OpenAI model objects. This endpoint is designed for SDK discovery — tools that call `client.models.list()` will see all running Enigma agents.

**Request:**
```bash
curl http://localhost:3080/v1/models
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "enigma-prime",
      "object": "model",
      "created": 1723836420,
      "owned_by": "enigma"
    },
    {
      "id": "shogun-sword",
      "object": "model",
      "created": 1723836420,
      "owned_by": "enigma"
    }
  ]
}
```

Only **running** agents appear in this list. Stopped agents are not included.

---

### POST /v1/chat/completions

Sends a chat turn to a named agent. This is the primary endpoint — it mirrors the OpenAI Chat Completions API.

#### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | Yes | The name of a running Enigma agent |
| `messages` | array | Yes | Chat messages (only the last `user` message is forwarded) |
| `stream` | boolean | No | If `true`, stream response as SSE. Default: `false` |

#### Message Format

Each message object supports the standard OpenAI shape:

```json
{
  "role": "user",
  "content": "Hello, agent!"
}
```

The `content` field accepts two formats:

**Plain string:**
```json
{ "role": "user", "content": "Analyze the structure of HomeController.vb" }
```

**Content block array** (for multimodal input):
```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What's in this image?" },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,iVBORw0KGgo..."
      }
    }
  ]
}
```

---

#### Non-Streaming Example (curl)

```bash
curl -X POST http://localhost:3080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "enigma-prime",
    "messages": [
      { "role": "user", "content": "List all empty catch blocks in the project" }
    ]
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-a1b2c3d4e5f6...",
  "object": "chat.completion",
  "created": 1723836420,
  "model": "enigma-prime",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "I found 12 empty catch blocks across 4 files..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

> **Note:** Enigma does not track token usage. All `usage` values are `0`. The field is included for SDK compatibility.

---

#### Streaming Example (curl)

```bash
curl -N -X POST http://localhost:3080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "enigma-prime",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Explain the AST query engine architecture" }
    ]
  }'
```

**Response (SSE stream):**
```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1723836420,"model":"enigma-prime","choices":[{"index":0,"delta":{"role":"assistant","content":"The"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1723836420,"model":"enigma-prime","choices":[{"index":0,"delta":{"content":" AST"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1723836420,"model":"enigma-prime","choices":[{"index":0,"delta":{"content":" query"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1723836420,"model":"enigma-prime","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

## Using the OpenAI Python SDK

Install the SDK:
```bash
pip install openai
```

### Basic Usage

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3080/v1",
    api_key="anything"  # Required by SDK, but ignored if auth is disabled
)

# List available agents (running models)
models = client.models.list()
for m in models.data:
    print(f"  {m.id}")

# Non-streaming completion
response = client.chat.completions.create(
    model="enigma-prime",
    messages=[
        {"role": "user", "content": "List all VB.NET files under 5000 lines"}
    ]
)
print(response.choices[0].message.content)
```

### Streaming

```python
stream = client.chat.completions.create(
    model="enigma-prime",
    stream=True,
    messages=[
        {"role": "user", "content": "Explain the compilation validation pipeline"}
    ]
)

for chunk in stream:
    if chunk.choices[0].delta.content is not None:
        print(chunk.choices[0].delta.content, end="")
```

### With Authentication

```python
client = OpenAI(
    base_url="http://localhost:3080/v1",
    api_key="your-bearer-token"
)
```

### Vision / Image Input

```python
response = client.chat.completions.create(
    model="enigma-prime",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "What's shown in this screenshot?"},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "data:image/png;base64,iVBORw0KGgo..."
                    }
                }
            ]
        }
    ]
)
print(response.choices[0].message.content)
```

You can also pass an HTTP URL to an image:
```python
{
    "type": "image_url",
    "image_url": {
        "url": "https://example.com/screenshot.png"
    }
}
```

---

## Using the OpenAI JavaScript/TypeScript SDK

Install the SDK:
```bash
npm install openai
```

### Basic Usage

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3080/v1",
  apiKey: "anything",  // Required by SDK, ignored if auth is disabled
});

// Non-streaming
const response = await client.chat.completions.create({
  model: "enigma-prime",
  messages: [
    { role: "user", content: "Find all empty catch blocks in the project" }
  ],
});
console.log(response.choices[0].message.content);
```

### Streaming

```typescript
const stream = await client.chat.completions.create({
  model: "enigma-prime",
  stream: true,
  messages: [
    { role: "user", content: "Explain the pattern matching engine" }
  ],
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
```

---

## Using with LangChain (Python)

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://localhost:3080/v1",
    api_key="anything",
    model="enigma-prime",
)

response = llm.invoke("List all empty catch blocks in the project")
print(response.content)
```

### Streaming with LangChain

```python
for chunk in llm.stream("Explain the AST edit engine"):
    print(chunk.content, end="")
```

---

## Using with LangChain (JavaScript/TypeScript)

```typescript
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({
  baseURL: "http://localhost:3080/v1",
  apiKey: "anything",
  model: "enigma-prime",
});

const response = await llm.invoke("List all empty catch blocks in the project");
console.log(response.content);
```

---

## Using with curl (No SDK)

### Simple text request

```bash
curl -X POST http://localhost:3080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "enigma-prime",
    "messages": [
      { "role": "user", "content": "Get the structure of Controllers/HomeController.vb" }
    ]
  }'
```

### With authentication

```bash
curl -X POST http://localhost:3080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token-here" \
  -d '{
    "model": "enigma-prime",
    "messages": [
      { "role": "user", "content": "Compile the workspace and return diagnostics" }
    ]
  }'
```

### Streaming with curl

The `-N` flag disables curl's output buffering, which is essential for seeing streamed chunks in real time:

```bash
curl -N -X POST http://localhost:3080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "enigma-prime",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Explain the checkpoint and rollback system" }
    ]
  }'
```

---

## Image / Vision Support

Enigma's OpenAI-compatible endpoint accepts images in OpenAI's `image_url` content block format. Two URL schemes are supported:

| URL Scheme | Example | Internal Conversion |
|------------|---------|---------------------|
| Data URL | `data:image/png;base64,iVBORw0KGgo...` | Converted to an ACP `image` block (base64 inline) |
| HTTP/HTTPS | `https://example.com/screenshot.png` | Converted to an ACP `resource_link` block |

### Supported Image MIME Types

The MIME type is inferred from the file extension in the URL (for HTTP URLs) or parsed from the data URL prefix:

| Extension | MIME Type |
|-----------|-----------|
| `.png` | `image/png` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.svg` | `image/svg+xml` |
| `.bmp` | `image/bmp` |
| `.ico` | `image/x-icon` |
| `.tif`, `.tiff` | `image/tiff` |
| `.jpg`, `.jpeg` (or unknown) | `image/jpeg` |

### Example: Send an Image from a File

```python
import base64

with open("screenshot.png", "rb") as f:
    b64 = base64.b64encode(f.read()).decode("utf-8")

response = client.chat.completions.create(
    model="enigma-prime",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Analyze this screenshot of the code"},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/png;base64,{b64}"
                    }
                }
            ]
        }
    ]
)
```

> The `detail` field (`"low"`, `"high"`, `"auto"`) in `image_url` objects is accepted but ignored — it is an OpenAI rendering hint with no equivalent in the ACP protocol.

---

## Error Handling

All errors follow the OpenAI error response format:

```json
{
  "error": {
    "message": "Human-readable error message",
    "type": "error_type",
    "code": null
  }
}
```

### Error Codes

| HTTP Status | Error Type | When It Happens |
|------------|------------|-----------------|
| `400` | `invalid_request_error` | Missing `model` field, or no `user` role message in the request |
| `401` | — (auth error) | Authentication is enabled and no valid token was provided |
| `404` | `invalid_request_error` | The agent specified in `model` was not found. Start the agent first via `POST /api/agents/{name}/start` |
| `409` | `server_error` | The agent could not accept work (e.g., `SendWorkAsync` threw) |
| `429` | `rate_limit_error` | The agent is already processing a request (`status: Working`). Wait for it to finish or use a different agent |
| `503` | `server_error` | The agent exists but is not in `Ready` status (e.g., `Starting`, `Suspended`, `Error`) |
| `504` | `server_error` | The agent did not respond within the 5-minute timeout (non-streaming only) |

### Handling Errors in Python

```python
from openai import OpenAI, NotFoundError, RateLimitError, APITimeoutError

try:
    response = client.chat.completions.create(
        model="enigma-prime",
        messages=[{"role": "user", "content": "Hello"}]
    )
except NotFoundError:
    print("Agent not found — start it first via POST /api/agents/{name}/start")
except RateLimitError:
    print("Agent is busy — wait for it to finish or try another agent")
except APITimeoutError:
    print("Agent did not respond within 5 minutes")
```

---

## Differences from Standard OpenAI API

### What Works the Same

- ✅ `POST /v1/chat/completions` request and response shape
- ✅ `GET /v1/models` for model discovery
- ✅ Streaming via SSE (`data: {...}\n\n` + `data: [DONE]\n\n`)
- ✅ `image_url` content blocks (data URLs and HTTP URLs)
- ✅ `Authorization: Bearer` header for authentication
- ✅ Standard error response format

### What's Different

| Aspect | Standard OpenAI | Enigma |
|--------|----------------|--------|
| `model` field | Selects a language model (e.g., `gpt-4o`) | Selects a running agent by name |
| System messages | Used to set the system prompt | Accepted but ignored — agents manage their own personas |
| Conversation history | Full message array is processed | Only the last `user` message is forwarded |
| Token usage | Real token counts | All values are `0` (Enigma doesn't track tokens) |
| Temperature, top_p, etc. | Controls generation parameters | Accepted in the request body but ignored — agent behavior is configured per-agent |
| Function calling | Supported | Not supported through this endpoint |
| Tool calls | Supported | Not supported through this endpoint |
| Non-streaming timeout | N/A | 5 minutes |
| Max output tokens | Configurable | Determined by the agent, not the request |

### What's NOT Supported

The following OpenAI API features are **not available** through the Enigma compat endpoint:

- **Function calling / tool calls** — agents use their own tool integration (AST queries, file operations, etc.)
- **Logprobs** — not applicable to agent responses
- **`n` (multiple choices)** — each request produces one response
- **Token counting** — the `usage` object is always zero
- **Moderation endpoint** — not exposed
- **Embeddings endpoint** — Enigma has its own embedding system at `/api/search/*`
- **Fine-tuning** — not applicable

---

## Architecture: How Requests Flow

```
Client (OpenAI SDK)
  │
  ▼
POST /v1/chat/completions
  │
  ▼
OpenAiCompatEndpoints.ChatCompletions()
  │
  ├─ Validate: model field present?
  ├─ Lookup: AgentSessionManager.GetSession(model)
  ├─ Check status: Ready? Working? Stopped?
  ├─ Extract: last user message from messages[]
  ├─ Normalize: ContentBlockNormalizer (image_url → ACP image/resource_link)
  │
  ├─ If stream=true:
  │    ├─ Set SSE headers (text/event-stream, no-cache, keep-alive)
  │    ├─ Subscribe to session.Harness.OutputReceived
  │    ├─ AgentSessionManager.SendWorkAsync(name, content)
  │    ├─ Stream chunks as OpenAI chat.completion.chunk SSE events
  │    └─ Send terminal `data: [DONE]\n\n`
  │
  └─ If stream=false:
       ├─ Subscribe to session.Harness.OutputReceived
       ├─ AgentSessionManager.SendWorkAsync(name, content)
       ├─ Accumulate all chunks until IsFinal
       ├─ Build OpenAiChatCompletion response object
       └─ Return JSON response
```

---

## Tips and Best Practices

### 1. Always Start Your Agent First

The most common error is forgetting to start the agent before sending a chat completion. Agents are not auto-started:

```bash
# Start the agent
curl -X POST http://localhost:3080/api/agents/enigma-prime/start

# Verify it's ready
curl http://localhost:3080/v1/models | python -m json.tool

# Now send your request
curl -X POST http://localhost:3080/v1/chat/completions ...
```

### 2. Handle 429 (Agent Busy)

Each agent processes one request at a time. If you send a second request while the first is still running, you'll get a 429. Either:
- Wait for the first request to complete
- Start a second instance of the agent with a different name

### 3. Use Streaming for Long-Running Tasks

Agents may take minutes to complete complex work. For non-streaming requests, the timeout is 5 minutes. If your agent might take longer, use streaming — the connection stays open as long as the agent is producing output.

### 4. Include Context in the Last User Message

Since only the last user message is forwarded, include any conversation context or prior results directly in that message:

```python
# ❌ This won't work — the first user message is ignored
messages = [
    {"role": "user", "content": "Find all empty catch blocks"},
    {"role": "user", "content": "Now fix them"}  # ← only this is sent
]

# ✅ Combine context into one message
messages = [
    {"role": "user", "content": "Find all empty catch blocks in the project and inject logging into each one"}
]
```

### 5. Use the Correct Base URL

Most OpenAI SDKs append `/chat/completions` to the base URL. Set the base URL to include `/v1`:

```python
# ✅ Correct
client = OpenAI(base_url="http://localhost:3080/v1", api_key="...")

# ❌ Wrong — will hit /chat/completions without the /v1 prefix
client = OpenAI(base_url="http://localhost:3080", api_key="...")
```

---

## Complete Working Example: Python Script

```python
#!/usr/bin/env python3
"""
Complete example: use an Enigma agent through the OpenAI-compatible endpoint.
"""

import sys
import requests
from openai import OpenAI

ENIGMA_URL = "http://localhost:3080"
AGENT_NAME = "enigma-prime"

def ensure_agent_running():
    """Check if the agent is running; start it if not."""
    resp = requests.get(f"{ENIGMA_URL}/v1/models")
    models = resp.json().get("data", [])
    running = [m["id"] for m in models]

    if AGENT_NAME not in running:
        print(f"Agent '{AGENT_NAME}' is not running. Starting it...")
        resp = requests.post(f"{ENIGMA_URL}/api/agents/{AGENT_NAME}/start")
        if resp.status_code == 201:
            print("Agent started successfully.")
        else:
            print(f"Failed to start agent: {resp.text}")
            sys.exit(1)
    else:
        print(f"Agent '{AGENT_NAME}' is already running.")

def chat(prompt: str, stream: bool = False) -> str:
    """Send a chat completion request to the Enigma agent."""
    client = OpenAI(
        base_url=f"{ENIGMA_URL}/v1",
        api_key="anything",  # Ignored if auth is disabled
    )

    if stream:
        result = []
        response = client.chat.completions.create(
            model=AGENT_NAME,
            stream=True,
            messages=[{"role": "user", "content": prompt}],
        )
        for chunk in response:
            content = chunk.choices[0].delta.content
            if content:
                print(content, end="", flush=True)
                result.append(content)
        print()  # newline after streaming
        return "".join(result)
    else:
        response = client.chat.completions.create(
            model=AGENT_NAME,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.choices[0].message.content

if __name__ == "__main__":
    ensure_agent_running()

    # Non-streaming
    print("\n--- Non-streaming response ---")
    result = chat("List all VB.NET files under 5000 lines")
    print(result)

    # Streaming
    print("\n--- Streaming response ---")
    chat("Explain the checkpoint and rollback system", stream=True)
```

---

## Troubleshooting

### "Agent not found" (404)

The agent name in your `model` field doesn't match any running agent. Check running agents:
```bash
curl http://localhost:3080/v1/models
```

If the agent isn't listed, start it:
```bash
curl -X POST http://localhost:3080/api/agents/{name}/start
```

### "Agent is already processing a request" (429)

The agent is busy with a previous request. Wait for it to finish, or check the agent status:
```bash
curl http://localhost:3080/api/agents/{name}
```

### "Agent is not ready" (503)

The agent exists but isn't in the `Ready` state. It might be `Starting`, `Suspended`, or in `Error`. Check the status:
```bash
curl http://localhost:3080/api/agents/{name}
```

### Authentication error (401)

If authentication is enabled on the server, include a valid Bearer token:
```bash
curl -H "Authorization: Bearer your-token" http://localhost:3080/v1/chat/completions ...
```

### Timeout (504)

The agent didn't respond within 5 minutes (non-streaming only). Try streaming mode instead, or check if the agent is stuck.

### SDK "base_url" issues

Some SDKs use `base_url`, others use `baseURL`. Make sure the path includes `/v1`:

| SDK | Property | Value |
|-----|----------|-------|
| Python `openai` | `base_url` | `http://localhost:3080/v1` |
| JavaScript `openai` | `baseURL` | `http://localhost:3080/v1` |
| LangChain Python | `base_url` | `http://localhost:3080/v1` |
| LangChain JS | `baseURL` | `http://localhost:3080/v1` |

---

## See Also

- [Enigma README](../../README.md) — Project overview and quick start
- [AGENTS.md](../../AGENTS.md) — Agent development guide
- [Agent Control Protocol docs](../agent-control-protocol/) — ACP protocol reference
- OpenAI API Reference: <https://platform.openai.com/docs/api-reference/chat>