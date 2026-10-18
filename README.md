# LUZYX — Mini AI Assistant (V2)

LUZYX is the original single-page assistant UI and FastAPI static host, extended with browser-local provider settings, Ollama detection, and document attachments. It needs no account, database, or paid service to open; **Basic guided mode** works without an AI provider. Full AI use requires either a local Ollama model or an API key supplied by the user.

## Quick start

1. Install Python 3.10+.
2. (Optional) Create and activate a virtual environment.
3. Install dependencies: `python -m pip install -r requirements.txt`
4. Start the app: `python main.py`
5. Open `http://localhost:8000`.
6. For local Ollama or a remote API, open **Settings** and select/configure a provider. No key is needed for Basic guided mode.

The FastAPI process serves the existing frontend and retains legacy optional server-provider endpoints. The current browser chat uses the selected provider directly and does not send user API keys or document contents through the LUZYX backend.

## Provider modes

### Basic guided mode

The default, with no API key or model connection. It identifies Lucky as LUZYX’s creator, answers a small number of setup/help prompts, and explains how to connect a model. It is **not** a general-purpose language model, and does not claim otherwise.

### Ollama (local AI)

1. Install Ollama from [ollama.com](https://ollama.com) and start its service.
2. Download a model, for example: `ollama pull llama3.2`.
3. In LUZYX **Settings**, select **Ollama**, use `http://localhost:11434` for the usual service address, click **Retry detection**, and choose a detected model.

Detection is a browser request to the local Ollama API; a configured address alone is not treated as proof that Ollama is running. Browser CORS, private-network permission, and mixed-content protections can block a hosted HTTPS page from reaching a local HTTP service. If this happens, use LUZYX locally or review Ollama's `OLLAMA_ORIGINS` configuration and browser permissions. A public website cannot silently inspect installed software on a user's computer.

### User-configured remote API

- **OpenAI-compatible API:** in Settings choose the adapter, enter the provider's exact model ID, API key, and base URL. Common examples include OpenAI, Groq, OpenRouter, and compatible gateways; use the endpoint and model name supplied by that service. OpenRouter's base URL is commonly `https://openrouter.ai/api/v1`.
- **Google Gemini:** choose Gemini, add the key and a supported Gemini model ID.
- Use **Test connection**, then **Save settings**. Requests go directly from the browser to that selected provider. CORS failures, account restrictions, unsupported browser-direct APIs, rate limits, invalid keys, and model errors are reported; there is no automatic switch to a different provider.

Browser storage is a convenience, not a vault. A saved key in `localStorage` can be exposed by malicious scripts or anyone with access to the browser profile. Use a browser/device you control, remove keys when finished, and prefer a trusted backend for production secrets. LUZYX does not provide a backend proxy for personal browser keys.

## File attachments and PDF/DOCX

Use the paperclip in the composer to select up to **5 files**, each up to **15 MB**. Supported formats include PDF, TXT, Markdown, DOCX, CSV/TSV, JSON, common source files, HTML, CSS, and other listed text formats. Remove an attachment before sending with its × button.

Text extraction happens in the browser: PDF.js extracts selectable PDF text (including page labels), Mammoth extracts DOCX text, and text/code files are read as text. The document text is kept only in the current tab's memory, not in localStorage or on the LUZYX server. Requests include at most 60,000 document characters. Larger sources are divided into chunks: relevant chunks are retrieved for focused questions, and evenly spaced excerpts are sampled for broad summaries; LUZYX tells the model when only excerpts were supplied. This is not a substitute for a full-document, multi-pass synthesis. PDF extraction reads up to 200 pages. Scanned/image-only PDFs need OCR outside LUZYX; password-protected or corrupted files may fail. PDF.js and Mammoth are loaded from cdnjs, so those readers require that CDN to be reachable.

Basic mode does not transmit a document and cannot analyze it with an AI model. Before sending an attachment through Ollama or a remote provider, LUZYX asks for confirmation. For remote AI, the extracted text is sent directly to the selected provider under that provider's policies. Follow-up questions can use the current tab's in-memory document while the tab remains open; after reload, attach the file again.

## Chat and privacy

- Conversations are stored in this browser's localStorage, without cloud sync or a database. They include the user's typed text, assistant replies, and attachment filenames. Raw extracted files/text are not stored; Basic-mode previews are shown in the current view but replaced by a notice in the persisted transcript. Normal provider-generated assistant replies are stored as chat history and may include details or quotations.
- Chat messages sent to a configured remote provider go to that provider. LUZYX does not silently change providers if one fails.
- Local Ollama prompts are sent to the configured local Ollama service.
- Use the delete control beside a conversation to remove it from local history. **Remove saved credentials** clears the saved provider settings/key.
- Markdown is rendered using DOM text nodes and safe elements; uploaded source files are never executed.

## Optional server-side provider (legacy endpoint)

The backend still supports the original server-configured providers for deployments that intentionally call `/api/chat` or `/api/chat/stream`. Those endpoints use only one provider: `LUZYX_PROVIDER` if set to the matching name (`Groq`, `Gemini`, `NVIDIA Nemotron`, or `OpenRouter`), otherwise the first configured key in `.env.example` order. They **do not fail over**. The shipped browser chat does not use this endpoint for user-supplied keys.

1. Copy `.env.example` to `.env` only if you intentionally operate a trusted server-side provider.
2. Add a key for that provider and optionally set `LUZYX_PROVIDER`.
3. Never commit `.env` or expose server-side keys in frontend code. Hosting these endpoints publicly without authentication can allow others to consume your provider quota; add a trusted access-control/proxy design before exposing them.

## Deployment

Run `python main.py` or use an ASGI server such as `uvicorn main:app --host 0.0.0.0 --port 8000`. Keep frontend static files and `main.py` in the same directory. Set the platform's `PORT` environment variable when required. HTTPS is recommended for hosted sites, but it can make direct access from the hosted page to local Ollama more restrictive. Provider APIs must allow browser CORS for direct mode to work; if they do not, a separately operated backend proxy is required and must be secured appropriately.

## Files changed in this upgrade

- `index.html` — provider-status display, settings dialog, functional Stop control, and working attachment controls; retained the original landing page and layout. Removed a nonfunctional voice-input placeholder instead of leaving a dead button.
- `assistant.js` — provider settings and adapters, Ollama checks, basic guided mode, local file parsing and long-document chunk retrieval, destination-specific document consent, safe Markdown/copy controls, and conversation deletion.
- `style.css` — matching responsive styles for settings, files, status, history deletion, and Markdown.
- `script.js` — preserved the existing background, responsive layout, and chat history foundation; renders stored titles as text and no longer contains the obsolete backend chat/fallback caller. The About action now gives truthful project information.
- `main.py` — server endpoints no longer silently fail over; exception details that could contain credentials are not logged.
- `.env.example` — placeholders and legacy server setup details.

## Maintenance pass (bug fixes and performance)

- `style.css` — added the missing styles for controls the JS creates (`.copy-reply`, `.delete-conversation`, `.history-row`, `.attachment-chip`), which were rendering as default light-grey "white spots"; themed link colour; paragraph/list/heading spacing inside bubbles.
- `assistant.js` — removed the extra `<br>` the Markdown renderer added for blank lines (doubled the spacing); streaming replies now re-render at most once per animation frame instead of once per token; the Ollama model list is cached for 60 s instead of an extra `/api/tags` request before every message (Retry/Test still always re-check, and a stale list is refreshed automatically if the chosen model is missing).
- `script.js` — opening a saved conversation jumps to the end instead of smooth-scrolling from the top.
- `main.py` — one pooled HTTP client reused across requests; fixed legacy Gemini streaming (it raised a TypeError and mis-parsed SSE lines); httpx request logging silenced because it printed provider URLs containing the Gemini `?key=`.

## Actual verification and known limits

Verified in this build:

- `python -m py_compile main.py`, `node --check script.js`, and `node --check assistant.js` passed.
- FastAPI smoke tests passed: health route responds; no configured server provider returns 503; a synthetic provider failure did not invoke a second configured provider on either chat endpoint.
- The app served locally and through the sandbox HTTPS preview. Browser smoke tests confirmed the settings controls, no-key validation, conversation history after reload, and the deterministic Lucky creator response.
- Browser confirmed PDF.js 3.11.174 and Mammoth loaded. A generated one-page selectable-text PDF and a TXT fixture were extracted locally and shown in Basic mode without a model or service transmission. A 81,785-character text fixture was queried for a unique phrase at the end; bounded retrieval surfaced the matching tail excerpt. The browser stored the filename and a preview notice, not the extracted phrase, and the notice survived reload.
- The hosted HTTPS preview correctly reported Ollama unreachable; there was no Ollama installation/service available to test successful local-model selection or chat.

Not tested: successful remote-provider connection/chat (no API keys were supplied), DOCX extraction with a DOCX fixture, scanned-PDF OCR (not included), or physical-device mobile testing. Provider connectivity and Ollama availability depend on the user's local installation, API keys, provider policies, and browser CORS/private-network permissions. OCR, image understanding, arbitrary binary formats, and provider-independent server-side key storage are not included. The existing responsive layout and animated background were preserved.
