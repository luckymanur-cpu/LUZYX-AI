"""
LUZYX v2 — Mini AI Assistant
FastAPI static host and optional server-configured provider endpoint.

Run from this folder:
    python main.py
Then open:
    http://localhost:8000

No database, accounts, or login. Chat history remains in the browser.
"""

import json
import logging
import os
import time
from pathlib import Path
from typing import AsyncIterator, List, Optional, Tuple

import httpx
from dotenv import load_dotenv
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("luzyx")
# httpx logs full request URLs at INFO, which include Gemini's ?key=... query parameter.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # One pooled client for the whole process: reuses TCP/TLS connections to providers
    # instead of paying a new handshake on every request.
    app.state.client = httpx.AsyncClient(
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=20, keepalive_expiry=60),
        timeout=timeout(False),
    )
    try:
        yield
    finally:
        await app.state.client.aclose()


app = FastAPI(title="LUZYX API", version="2.0", lifespan=lifespan)

SYSTEM_PROMPT = (
    "You are LUZYX, a friendly and knowledgeable AI assistant created by Lucky. "
    "Lucky is your creator. Your name is LUZYX. Never claim that a model or API "
    "provider created you. If asked who created you, answer that you were created "
    "by Lucky. Answer naturally and helpfully, like a smart friend. Explain things "
    "clearly and use Markdown when useful. Keep normal replies concise unless the "
    "user asks for depth. Use recent conversation context when supplied. You do "
    "not have live internet access, so never claim to have searched the web unless "
    "a tool/search result was explicitly supplied."
)

# Fast defaults. They can be changed in .env without editing Python.
MAX_OUTPUT_TOKENS = int(os.getenv("LUZYX_MAX_OUTPUT_TOKENS", "500"))
MAX_HISTORY_TURNS = int(os.getenv("LUZYX_MAX_HISTORY_TURNS", "10"))
CONNECT_TIMEOUT = float(os.getenv("LUZYX_CONNECT_TIMEOUT", "6"))
READ_TIMEOUT = float(os.getenv("LUZYX_READ_TIMEOUT", "35"))

class ChatTurn(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    conversation: List[ChatTurn] = Field(default_factory=list)

class ChatResponse(BaseModel):
    reply: str
    provider: str
    model: str

class ProviderNotConfigured(Exception):
    pass


def recent_messages(message: str, conversation: List[ChatTurn]) -> list:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in conversation[-MAX_HISTORY_TURNS:]:
        if turn.role in ("user", "assistant") and turn.content.strip():
            messages.append({"role": turn.role, "content": turn.content})
    messages.append({"role": "user", "content": message})
    return messages


def timeout(stream: bool = False) -> httpx.Timeout:
    return httpx.Timeout(
        connect=CONNECT_TIMEOUT,
        read=READ_TIMEOUT if stream else min(READ_TIMEOUT, 25),
        write=8.0,
        pool=8.0,
    )


async def openai_style_stream(
    client: httpx.AsyncClient, *, url: str, api_key: str, model: str,
    message: str, conversation: List[ChatTurn], extra_headers: Optional[dict] = None,
) -> AsyncIterator[str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    if extra_headers:
        headers.update(extra_headers)

    payload = {
        "model": model,
        "messages": recent_messages(message, conversation),
        "temperature": 0.3,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream": True,
    }

    async with client.stream("POST", url, headers=headers, json=payload, timeout=timeout(True)) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
                choices = obj.get("choices") or []
                if choices:
                    delta = choices[0].get("delta") or {}
                    chunk = delta.get("content")
                    if chunk:
                        yield chunk
            except json.JSONDecodeError:
                continue


async def openai_style_call(
    client: httpx.AsyncClient, *, url: str, api_key: str, model: str,
    message: str, conversation: List[ChatTurn], extra_headers: Optional[dict] = None,
) -> str:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    payload = {
        "model": model,
        "messages": recent_messages(message, conversation),
        "temperature": 0.3,
        "max_tokens": MAX_OUTPUT_TOKENS,
    }
    started = time.perf_counter()
    resp = await client.post(url, headers=headers, json=payload, timeout=timeout(False))
    resp.raise_for_status()
    data = resp.json()
    reply = data["choices"][0]["message"].get("content", "")
    log.info("%s first response completed in %.2fs", model, time.perf_counter() - started)
    if not reply.strip():
        raise RuntimeError("Provider returned an empty response")
    return reply.strip()


# ---------- Provider definitions ----------

async def gemini_call(client, message, conversation):
    key = os.getenv("GEMINI_API_KEY")
    if not key: raise ProviderNotConfigured
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    contents = []
    for turn in conversation[-MAX_HISTORY_TURNS:]:
        contents.append({"role": "user" if turn.role == "user" else "model", "parts": [{"text": turn.content}]})
    contents.append({"role": "user", "parts": [{"text": message}]})
    payload = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": MAX_OUTPUT_TOKENS},
    }
    resp = await client.post(url, json=payload, timeout=timeout(False))
    resp.raise_for_status()
    data = resp.json()
    reply = data["candidates"][0]["content"]["parts"][0]["text"]
    return reply.strip(), model

async def gemini_stream(client, message, conversation):
    key = os.getenv("GEMINI_API_KEY")
    if not key: raise ProviderNotConfigured
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}"
    contents = []
    for turn in conversation[-MAX_HISTORY_TURNS:]:
        contents.append({"role": "user" if turn.role == "user" else "model", "parts": [{"text": turn.content}]})
    contents.append({"role": "user", "parts": [{"text": message}]})
    payload = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": MAX_OUTPUT_TOKENS},
    }

    async def gen():
        async with client.stream("POST", url, json=payload, timeout=timeout(True)) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data:"): continue  # SSE lines are "data: {json}"
                data = line[5:].strip()
                if not data: continue
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                for candidate in obj.get("candidates", []):
                    for part in candidate.get("content", {}).get("parts", []):
                        chunk = part.get("text")
                        if chunk: yield chunk
    return gen()

async def nvidia_call(client, message, conversation):
    key = os.getenv("NVIDIA_API_KEY")
    if not key: raise ProviderNotConfigured
    model = os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b")
    reply = await openai_style_call(client, url="https://integrate.api.nvidia.com/v1/chat/completions", api_key=key, model=model, message=message, conversation=conversation)
    return reply, model

async def nvidia_stream(client, message, conversation):
    key = os.getenv("NVIDIA_API_KEY")
    if not key: raise ProviderNotConfigured
    model = os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b")
    return openai_style_stream(client, url="https://integrate.api.nvidia.com/v1/chat/completions", api_key=key, model=model, message=message, conversation=conversation)

async def groq_call(client, message, conversation):
    key = os.getenv("GROQ_API_KEY")
    if not key: raise ProviderNotConfigured
    model = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
    reply = await openai_style_call(client, url="https://api.groq.com/openai/v1/chat/completions", api_key=key, model=model, message=message, conversation=conversation)
    return reply, model

async def groq_stream(client, message, conversation):
    key = os.getenv("GROQ_API_KEY")
    if not key: raise ProviderNotConfigured
    model = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
    return openai_style_stream(client, url="https://api.groq.com/openai/v1/chat/completions", api_key=key, model=model, message=message, conversation=conversation)

async def openrouter_call(client, message, conversation):
    key = os.getenv("OPENROUTER_API_KEY")
    if not key: raise ProviderNotConfigured
    model = os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.1-8b-instruct:free")
    reply = await openai_style_call(client, url="https://openrouter.ai/api/v1/chat/completions", api_key=key, model=model, message=message, conversation=conversation, extra_headers={"HTTP-Referer": "http://localhost:8000", "X-Title": "LUZYX"})
    return reply, model

async def openrouter_stream(client, message, conversation):
    key = os.getenv("OPENROUTER_API_KEY")
    if not key: raise ProviderNotConfigured
    model = os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.1-8b-instruct:free")
    return openai_style_stream(client, url="https://openrouter.ai/api/v1/chat/completions", api_key=key, model=model, message=message, conversation=conversation, extra_headers={"HTTP-Referer": "http://localhost:8000", "X-Title": "LUZYX"})

# Legacy server-configured provider options. The browser UI uses direct,
# user-selected providers and never calls these endpoints for chat.
PROVIDERS: List[Tuple[str, str, object, object]] = [
    ("Groq", "GROQ_API_KEY", groq_call, groq_stream),
    ("Gemini", "GEMINI_API_KEY", gemini_call, gemini_stream),
    ("NVIDIA Nemotron", "NVIDIA_API_KEY", nvidia_call, nvidia_stream),
    ("OpenRouter", "OPENROUTER_API_KEY", openrouter_call, openrouter_stream),
]


def configured_providers():
    configured = [(name, call, stream) for name, env, call, stream in PROVIDERS if os.getenv(env)]
    selected = os.getenv("LUZYX_PROVIDER", "").strip().casefold()
    if selected:
        matches = [item for item in configured if item[0].casefold() == selected]
        return matches[:1]
    # Backward-compatible default: use only the first configured provider.
    # Do not silently switch to another provider after a failure.
    return configured[:1]


@app.get("/api/health")
async def health():
    configured = [{"provider": n, "model": model} for n, env, _, _ in PROVIDERS if os.getenv(env) for model in [os.getenv({"Groq":"GROQ_MODEL", "Gemini":"GEMINI_MODEL", "NVIDIA Nemotron":"NVIDIA_MODEL", "OpenRouter":"OPENROUTER_MODEL"}[n], "default")]]
    return {"status": "ok", "version": "2.0", "providers_configured": configured}


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    message = req.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    providers = configured_providers()
    if not providers:
        raise HTTPException(status_code=503, detail="No AI provider is configured. Add a provider API key to .env.")

    client = app.state.client

    async def event_stream():
        if True:
            for name, _, stream_fn in providers:
                started = time.perf_counter()
                got_content = False
                try:
                    log.info("Trying streaming provider: %s", name)
                    stream = await stream_fn(client, message, req.conversation)
                    async for chunk in stream:
                        got_content = True
                        safe = chunk.replace("\r", "").replace("\n", "\\n")
                        yield f"data: {safe}\n\n"
                    if got_content:
                        log.info("%s streaming completed in %.2fs", name, time.perf_counter() - started)
                        yield "data: [DONE]\n\n"
                        return
                    log.warning("%s returned no content", name)
                except ProviderNotConfigured:
                    continue
                except Exception as exc:
                    # Do not log provider exception text: URLs (e.g. Gemini's
                    # query-key endpoint) can contain credentials.
                    log.warning("%s streaming request failed after %.2fs", name, time.perf_counter() - started)
                    if got_content:
                        yield "event: error\ndata: Response interrupted. Please try again.\n\n"
                        return
                    continue
            yield "event: error\ndata: The selected server provider failed. Check its key/model or try again; no other provider was contacted.\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"
    })


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    message = req.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    providers = configured_providers()
    if not providers:
        raise HTTPException(status_code=503, detail="No AI provider is configured. Add a provider API key to .env.")
    client = app.state.client
    name, call_fn, _ = providers[0]
    try:
        reply, model = await call_fn(client, message, req.conversation)
        return ChatResponse(reply=reply, provider=name, model=model)
    except ProviderNotConfigured:
        raise HTTPException(status_code=503, detail="The selected server provider is not configured.")
    except Exception:
        log.warning("%s request failed", name)
    raise HTTPException(status_code=503, detail="The selected server provider failed. Check its API key and model; no other provider was contacted.")


# Serve frontend last so /api/* routes keep priority.
app.mount("/", StaticFiles(directory=str(BASE_DIR), html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=True)
