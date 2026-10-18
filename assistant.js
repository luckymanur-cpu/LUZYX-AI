/* LUZYX provider and document layer. Runs in the browser; credentials and extracted
   documents are never sent to this app's backend. */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const settingsKey = "luzyx.settings.v1";
  const SETTINGS_DEFAULT = { provider: "basic", apiKey: "", model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", ollamaUrl: "http://localhost:11434", ollamaModel: "", geminiModel: "gemini-2.5-flash" };
  let settings = readSettings();
  let pendingFiles = [];
  const liveDocs = new Map(); // Deliberately memory-only; never put extracted text in chat history.
  const documentConsent = new Map(); // Per-conversation and destination; never persisted.
  let busy = false;
  let activeController = null;
  const MAX_FILES = 5, MAX_FILE_BYTES = 15 * 1024 * 1024, MAX_CONTEXT_CHARS = 60000;
  const ALLOWED = new Set(["pdf","txt","md","markdown","docx","csv","tsv","json","py","js","jsx","ts","tsx","html","htm","css","c","h","cpp","hpp","java","go","rs","sh","xml","yaml","yml","toml","ini","sql","log","xml"]);

  function readSettings() {
    try { return { ...SETTINGS_DEFAULT, ...JSON.parse(localStorage.getItem(settingsKey) || "{}") }; }
    catch (_) { return { ...SETTINGS_DEFAULT }; }
  }
  function persistSettings() {
    try { localStorage.setItem(settingsKey, JSON.stringify(settings)); return true; }
    catch (_) { setSettingsStatus("Could not save settings in this browser.", true); return false; }
  }
  function modeLabel() {
    if (settings.provider === "ollama") return settings.ollamaModel ? `Ollama · ${settings.ollamaModel}` : "Ollama · choose a model";
    if (settings.provider === "openai") return `OpenAI-compatible · ${settings.model || "model not set"}`;
    if (settings.provider === "gemini") return `Gemini · ${settings.geminiModel || "model not set"}`;
    return "Basic guided mode";
  }
  function setHeaderStatus(text, kind = "neutral") {
    const el = $("#connectionStatus"); if (!el) return;
    const label = $("#connectionStatusText"); if (label) label.textContent = text; el.dataset.state = kind;
    const dot = el.querySelector(".dot"); if (dot) dot.style.background = kind === "ok" ? "#28e0b8" : kind === "error" ? "#ff6b84" : "#a5b3d8";
  }
  function updateModeUI() {
    const el = $("#providerIndicator"); if (el) el.textContent = modeLabel();
    const status = $("#connectionStatus");
    if (settings.provider === "basic") setHeaderStatus("Basic mode", "neutral");
    else if (settings.provider === "ollama") setHeaderStatus(settings.ollamaModel ? "Local AI selected" : "Choose local model", "neutral");
    else setHeaderStatus(settings.apiKey ? "Provider selected" : "API key needed", settings.apiKey ? "neutral" : "error");
    const hint = $("#composerHint");
    if (hint) hint.textContent = `${modeLabel()} · Enter to send · Shift + Enter for a new line`;
  }
  function setSettingsStatus(text, error = false) {
    const el = $("#settingsStatus"); if (el) { el.textContent = text; el.classList.toggle("error", error); }
  }
  function syncSettingsForm() {
    $("#providerSelect").value = settings.provider;
    $("#apiKeyInput").value = settings.apiKey || "";
    $("#modelInput").value = settings.model || "";
    $("#baseUrlInput").value = settings.baseUrl || "";
    $("#ollamaUrlInput").value = settings.ollamaUrl || "http://localhost:11434";
    $("#geminiModelInput").value = settings.geminiModel || "gemini-2.5-flash";
    updateProviderFields();
    renderOllamaModels();
  }
  function updateProviderFields() {
    const p = $("#providerSelect").value;
    document.querySelectorAll("[data-provider-field]").forEach(el => { el.hidden = el.dataset.providerField !== p; });
    $("#remoteKeyField").hidden = !(p === "openai" || p === "gemini");
    const hint = $("#providerHelp");
    if (p === "ollama") hint.textContent = "The browser contacts Ollama on this device. A public HTTPS site may be blocked by browser private-network or mixed-content rules; local hosting is the most reliable setup.";
    else if (p === "openai") hint.textContent = "OpenAI-compatible endpoint. The key and chat go directly from this browser to the base URL you choose. Providers may block browser CORS requests or require a backend.";
    else if (p === "gemini") hint.textContent = "Gemini requests go directly from this browser to Google. The API key is sent only to Google; browser CORS and provider policies still apply.";
    else hint.textContent = "Basic guided mode works without a model or API key. It gives setup help and a few built-in responses, not open-ended AI.";
  }
  function openSettings() { syncSettingsForm(); setSettingsStatus(""); $("#settingsDialog").showModal(); }

  function normalizeBase(base) {
    let value = (base || "").trim().replace(/\/+$/, "");
    if (!value) throw new Error("Enter the provider base URL.");
    if (!/^https?:\/\//i.test(value)) throw new Error("The base URL must start with http:// or https://.");
    if (value.endsWith("/chat/completions")) return value;
    if (value.endsWith("/v1")) return value + "/chat/completions";
    return value + "/v1/chat/completions";
  }
  function timeoutSignal(ms = 45000) {
    const c = new AbortController(); const timer = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, abort: () => c.abort(), clear: () => clearTimeout(timer) };
  }
  function safeHttpError(status) {
    if (status === 401 || status === 403) return "The provider rejected the API key or access permission (401/403). Check the key and account access.";
    if (status === 404) return "The endpoint or model was not found (404). Check the base URL and exact model ID.";
    if (status === 429) return "The provider rate limit or quota was reached (429). Wait and try again, or check your provider account.";
    if (status >= 500) return `The provider returned a server error (${status}). Try again later.`;
    return `The provider returned HTTP ${status}. Check the provider settings.`;
  }
  async function checkedFetch(url, options, ms = 45000) {
    const t = timeoutSignal(ms);
    try { return await fetch(url, { ...options, signal: activeController?.signal || t.signal, mode: "cors", cache: "no-store" }); }
    catch (e) {
      if (e.name === "AbortError") throw new Error("The request timed out or was cancelled.");
      throw new Error("Could not reach the selected service. Check the URL, internet connection, CORS/private-network permissions, and whether the service is running.");
    } finally { t.clear(); }
  }
  function currentMessages(message, documentText) {
    const convo = typeof getCurrentConversation === "function" ? getCurrentConversation() : null;
    const history = convo ? convo.messages.slice(0, -1).slice(-12).map(m => ({ role: m.who === "user" ? "user" : "assistant", content: m.text })) : [];
    const system = `You are LUZYX, a helpful mini AI assistant created by Lucky. If asked who created or developed you, truthfully say Lucky created LUZYX; do not claim Lucky trained the underlying model. Be clear and friendly. If document text is provided, base document answers on it and cite page numbers when included. The supplied text may be excerpts or samples; clearly say when an answer is limited to the supplied excerpts, and never claim to have reviewed missing pages or content. Do not claim to have read anything not present in the supplied text.\n\n${documentText ? "ATTACHED DOCUMENT TEXT/EXCERPTS (private content is being sent to the user's selected provider):\\n" + documentText : ""}`;
    return [{ role: "system", content: system }, ...history, { role: "user", content: message }];
  }
  async function streamOpenAI(message, docs, onChunk) {
    if (!settings.apiKey.trim()) throw new Error("Add your API key in Settings, or choose Basic guided mode.");
    const url = normalizeBase(settings.baseUrl);
    const messages = currentMessages(message, docs);
    const response = await checkedFetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.apiKey.trim()}` }, body: JSON.stringify({ model: settings.model.trim(), messages, temperature: 0.3, stream: true }) });
    if (!response.ok) throw new Error(safeHttpError(response.status));
    if (!response.body) throw new Error("This browser could not read the provider's streaming response.");
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buf = "", full = "";
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split(/\r?\n\r?\n/); buf = events.pop() || "";
        for (const event of events) {
          const data = event.split(/\r?\n/).filter(x => x.startsWith("data:")).map(x => x.slice(5).trim()).join("\n");
          if (!data || data === "[DONE]") continue;
          let obj; try { obj = JSON.parse(data); } catch (_) { continue; }
          const chunk = obj.choices?.[0]?.delta?.content;
          if (typeof chunk === "string") { full += chunk; onChunk?.(chunk, full); }
          if (obj.error) throw new Error("The selected provider reported an error. Check the model, key, and provider account.");
        }
      }
    } catch (e) { try { await reader.cancel(); } catch (_) {} throw e; }
    if (!full.trim()) throw new Error("The selected provider returned an empty response.");
    return full.trim();
  }
  async function geminiCall(message, docs) {
    if (!settings.apiKey.trim()) throw new Error("Add your Gemini API key in Settings, or choose Basic guided mode.");
    const model = encodeURIComponent(settings.geminiModel.trim());
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(settings.apiKey.trim())}`;
    const turns = currentMessages(message, docs);
    const sys = turns[0].content;
    const contents = turns.slice(1).map(t => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] }));
    const r = await checkedFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } }) });
    if (!r.ok) throw new Error(safeHttpError(r.status));
    let data; try { data = await r.json(); } catch (_) { throw new Error("Gemini returned an unreadable response."); }
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    if (!text.trim()) throw new Error("Gemini returned no text. The request may have been blocked or the response filtered.");
    return text.trim();
  }
  // Model list is cached briefly per URL so each chat message does not pay for an extra
  // /api/tags round trip. Explicit detection (Retry/Test) always bypasses the cache.
  const MODEL_CACHE_MS = 60000; let modelCache = null;
  async function ollamaModels(force = true) {
    const base = (settings.ollamaUrl || "http://localhost:11434").trim().replace(/\/+$/, "");
    if (!force && modelCache && modelCache.base === base && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
    const r = await checkedFetch(`${base}/api/tags`, { method: "GET" }, 6000);
    if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status} while listing models.`);
    const data = await r.json(); const models = (data.models || []).map(m => m.name).filter(Boolean);
    modelCache = { base, models, at: Date.now() }; return models;
  }
  async function streamOllama(message, docs, onChunk) {
    let models = await ollamaModels(false);
    const model = settings.ollamaModel.trim();
    if (model && models.length && !models.includes(model)) { modelCache = null; models = await ollamaModels(true); } // list may be stale (model just pulled)
    if (!models.length) throw new Error("Ollama is reachable, but no local models were found. In a terminal, run: ollama pull llama3.2");
    if (!model || !models.includes(model)) throw new Error("The selected Ollama model is not available. Choose a listed model or download it with `ollama pull MODEL`.");
    const base = settings.ollamaUrl.trim().replace(/\/+$/, "");
    const messages = currentMessages(message, docs).map(m => ({ role: m.role, content: m.content }));
    const r = await checkedFetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, stream: true, options: { temperature: 0.3 } }) }, 120000);
    if (!r.ok) { if (r.status === 404) modelCache = null; } if (!r.ok) throw new Error(r.status === 404 ? "Ollama could not find this model. Download it with `ollama pull MODEL`." : `Ollama returned HTTP ${r.status}. Check its service and model.`);
    const reader = r.body.getReader(), decoder = new TextDecoder(); let buf = "", full = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop() || "";
      for (const line of lines) { if (!line.trim()) continue; let d; try { d = JSON.parse(line); } catch (_) { continue; } const chunk = d.message?.content || ""; if (chunk) { full += chunk; onChunk?.(chunk, full); } if (d.error) throw new Error("Ollama reported an error. Check the model and service logs."); }
    }
    if (!full.trim()) throw new Error("Ollama returned an empty response."); return full.trim();
  }

  function creatorReply() { return "My creator is Lucky! 😊 I'm LUZYX, a mini AI assistant built by Lucky to help people learn, solve problems, understand documents, write code, and explore ideas."; }
  function basicReply(message) {
    const q = message.toLowerCase();
    if (/\b(who (created|built|made|developed) (you|luzyx)|who('?s| is) your creator|your creator|who made you)\b/.test(q)) return creatorReply();
    if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(q)) return "Hello! I'm LUZYX, a mini AI assistant built by Lucky. I can guide you around the app, help set up a local Ollama model or API provider, and answer a few built-in questions. To use a full AI model, open Settings and connect Ollama or your own provider.";
    if (/\b(help|what can you do|how do i use|capabilit)/.test(q)) return "I can help explain how to configure LUZYX and answer a few basic questions in this mode. For open-ended chat or document explanations, choose Ollama in Settings or add your own provider key. Your key remains in this browser; attaching a document to a remote provider requires a separate confirmation.";
    if (/\b(ollama|local model|local ai)\b/.test(q)) return "To use local AI: install Ollama from https://ollama.com, start the Ollama service, then run `ollama pull llama3.2`. In Settings choose Ollama, enter the service URL (usually http://localhost:11434), and retry detection. A public HTTPS page can be blocked from reaching localhost by browser security; run LUZYX locally for the most reliable connection.";
    if (/\b(api key|provider|openai|gemini|groq|openrouter|nvidia)\b/.test(q)) return "Open Settings to choose an OpenAI-compatible provider or Gemini, enter its API key and model, test the connection, then save. Keys stay in this browser and are sent only to the provider you selected. Browser CORS restrictions may prevent some providers from accepting direct browser requests.";
    return "I'm in Basic guided mode, so no AI model is currently connected and I can't generate a full answer to that yet. Open Settings to connect Ollama or configure your own API provider. Your selected provider won't be changed automatically if a request fails.";
  }

  function escapeText(text) { return document.createTextNode(text); }
  function appendInline(parent, text) {
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)]+\))/g; let pos = 0, m;
    while ((m = re.exec(text))) {
      parent.appendChild(escapeText(text.slice(pos, m.index)));
      const token = m[0]; let el;
      if (token.startsWith("`")) { el = document.createElement("code"); el.textContent = token.slice(1, -1); }
      else if (token.startsWith("**")) { el = document.createElement("strong"); el.textContent = token.slice(2, -2); }
      else if (token.startsWith("*")) { el = document.createElement("em"); el.textContent = token.slice(1, -1); }
      else { const mm = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(token); el = document.createElement("a"); el.textContent = mm[1]; el.href = mm[2]; el.rel = "noopener noreferrer"; el.target = "_blank"; }
      parent.appendChild(el); pos = re.lastIndex;
    }
    parent.appendChild(escapeText(text.slice(pos)));
  }
  function makeCodeBlock(text) {
    const pre=document.createElement("pre"),code=document.createElement("code"),button=document.createElement("button");
    code.textContent=text;button.type="button";button.className="copy-code";button.textContent="Copy code";button.setAttribute("aria-label","Copy code block");
    button.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(text);button.textContent="Copied";setTimeout(()=>button.textContent="Copy code",1200);}catch(_){button.textContent="Copy unavailable";setTimeout(()=>button.textContent="Copy code",1500);}});
    pre.append(code,button);return pre;
  }
  function renderMarkdownSafe(container, text) {
    container.replaceChildren();
    const lines = String(text).split("\n"); let list = null, code = null, codeText = [];
    for (const line of lines) {
      if (line.startsWith("```")) {
        if (!code) { code = true; codeText = []; list = null; }
        else { container.appendChild(makeCodeBlock(codeText.join("\n"))); code = false; }
        continue;
      }
      if (code) { codeText.push(line); continue; }
      const li = /^\s*[-*]\s+(.+)$/.exec(line);
      if (li) { if (!list) { list = document.createElement("ul"); container.appendChild(list); } const item = document.createElement("li"); appendInline(item, li[1]); list.appendChild(item); continue; }
      list = null;
      if (!line.trim()) continue;
      const h = /^(#{1,3})\s+(.+)$/.exec(line); const p = document.createElement(h ? `h${h[1].length + 1}` : "p"); appendInline(p, h ? h[2] : line); container.appendChild(p);
    }
    if (code) container.appendChild(makeCodeBlock(codeText.join("\n")));
  }
  const originalRenderMessage = window.renderMessage;
  window.renderMessage = function(text, who, time) {
    const row = originalRenderMessage(text, who, time);
    const bubble = row.querySelector(".bubble"); renderMarkdownSafe(bubble, text);
    const timestamp = document.createElement("span"); timestamp.className = "time"; timestamp.textContent = time || timeNow(); bubble.appendChild(timestamp);
    if (who === "bot") {
      const copy = document.createElement("button"); copy.type = "button"; copy.className = "copy-reply"; copy.textContent = "Copy"; copy.setAttribute("aria-label", "Copy response");
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; setTimeout(() => copy.textContent = "Copy", 1200); } catch (_) { copy.textContent = "Copy unavailable"; setTimeout(() => copy.textContent = "Copy", 1500); } }); bubble.appendChild(copy);
    }
    return row;
  };
  // Render conversation titles only as text and add a working delete control.
  window.renderHistory = function() {
    const historyEl = $("#history"); if (!historyEl) return; historyEl.replaceChildren();
    if (!conversations.length) { const p = document.createElement("p"); p.className = "history-empty"; p.textContent = "Your conversations will appear here."; historyEl.appendChild(p); return; }
    const sorted = [...conversations].sort((a,b) => b.updatedAt-a.updatedAt); const groups = new Map();
    for (const c of sorted) { const d = new Date(c.updatedAt), now = new Date(), y = new Date(); y.setDate(now.getDate()-1); const label = d.toDateString() === now.toDateString() ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString(undefined,{month:"short",day:"numeric"}); if (!groups.has(label)) groups.set(label,[]); groups.get(label).push(c); }
    for (const [label, items] of groups) { const group=document.createElement("div");group.className="history-group";const heading=document.createElement("p");heading.className="history-label";heading.textContent=label;group.appendChild(heading);
      for (const c of items) { const wrap=document.createElement("div");wrap.className="history-row";const btn=document.createElement("button");btn.type="button";btn.className="history-item"+(c.id===currentId?" active":"");btn.setAttribute("aria-current",c.id===currentId?"true":"false");const title=document.createElement("span");title.textContent=c.title||"New conversation";btn.appendChild(title);btn.addEventListener("click",()=>{openConversation(c.id);closeSidebarOnMobile();});
        const del=document.createElement("button");del.type="button";del.className="delete-conversation";del.textContent="×";del.title="Delete conversation";del.setAttribute("aria-label",`Delete ${c.title||"conversation"}`);del.addEventListener("click",e=>{e.stopPropagation();if(!confirm("Delete this conversation from this browser?"))return;conversations=conversations.filter(x=>x.id!==c.id);if(currentId===c.id)showWelcomeView();saveConversations();renderHistory();});wrap.append(btn,del);group.appendChild(wrap); }
      historyEl.appendChild(group);
    }
  };

  async function extractFile(file) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!ALLOWED.has(ext)) throw new Error(`${file.name}: unsupported file type.`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: file exceeds the 15 MB per-file limit.`);
    if (!file.size) throw new Error(`${file.name}: file is empty.`);
    if (ext === "pdf") {
      if (!window.pdfjsLib) throw new Error("PDF reader did not load. Check your internet connection, then reload LUZYX and try again.");
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        if (!doc.numPages) throw new Error("The PDF has no pages.");
        const pages=[]; const total=Math.min(doc.numPages,200);
        for(let n=1;n<=total;n++){const page=await doc.getPage(n);const text=await page.getTextContent();const str=text.items.map(i=>i.str).join(" ").replace(/\s+/g," ").trim();if(str)pages.push(`[Page ${n}] ${str}`);}
        if(!pages.length) throw new Error("No selectable text was found. This may be a scanned PDF; OCR is not built in, so run OCR first or use a text-based PDF.");
        return { name:file.name, text:pages.join("\n\n"), pages:doc.numPages, warning:doc.numPages>total?`Only first ${total} pages extracted from ${doc.numPages}.`:"" };
      } catch(e) { if(String(e.message).includes("No selectable text"))throw e; throw new Error(`${file.name}: could not read this PDF. It may be corrupted, password-protected, or scanned without selectable text.`); }
    }
    if (ext === "docx") {
      if (!window.mammoth) throw new Error("DOCX reader did not load. Check your internet connection and try again.");
      try { const result=await window.mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()}); if(!result.value.trim())throw new Error("This DOCX contains no readable text."); return {name:file.name,text:result.value}; }
      catch(e){throw new Error(`${file.name}: could not extract DOCX text. The document may be corrupted.`);}
    }
    const text=await file.text(); if(!text.trim()) throw new Error(`${file.name}: no readable text was found.`);
    return {name:file.name,text};
  }
  function formatBytes(bytes) { return bytes < 1024*1024 ? `${Math.max(1,Math.round(bytes/1024))} KB` : `${(bytes/1024/1024).toFixed(1)} MB`; }
  function renderFiles() {
    const list=$("#attachmentList"); if(!list)return;list.replaceChildren();
    pendingFiles.forEach((file,i)=>{const item=document.createElement("div");item.className="attachment-chip";const label=document.createElement("span");label.textContent=`${file.name} · ${formatBytes(file.size)}`;const del=document.createElement("button");del.type="button";del.textContent="×";del.setAttribute("aria-label",`Remove ${file.name}`);del.addEventListener("click",()=>{pendingFiles.splice(i,1);renderFiles();});item.append(label,del);list.appendChild(item);});
    if(pendingFiles.length){const actions=document.createElement("div");actions.className="attachment-actions";for(const [label,prompt] of [["Summarize","Summarize the attached document(s), covering the key ideas and conclusions."],["Explain","Explain the attached document(s) in clear, simple language."],["Study notes","Create concise study notes and key definitions from the attached document(s)."],["Quiz","Create 5 question-and-answer practice questions from the attached document(s)."]]){const b=document.createElement("button");b.type="button";b.className="attachment-action";b.textContent=label;b.addEventListener("click",()=>{const input=$("#input");input.value=prompt;autoGrow();window.sendMessage(prompt);});actions.appendChild(b);}list.appendChild(actions);}
  }
  function documentChunks(doc) {
    const chunks=[];
    const pushSlices=(text,prefix="")=>{for(let i=0;i<text.length;i+=1800){const part=text.slice(i,i+1800).trim();if(part)chunks.push(`${prefix}${part}`);}};
    if(doc.pages){
      const pages=doc.text.split(/(?=\[Page \d+\]\s*)/g).filter(Boolean);
      for(const page of pages){const match=/^\[Page (\d+)\]\s*/.exec(page);const marker=match?`[Page ${match[1]}] `:"";pushSlices(page.replace(/^\[Page \d+\]\s*/,""),marker);}
    } else {
      const paragraphs=doc.text.split(/\n{2,}/);
      for(const para of paragraphs)pushSlices(para," ");
    }
    return chunks;
  }
  function selectDocumentContext(docs, question="") {
    if(!docs?.length)return {text:"",notice:""};
    const fullLength=docs.reduce((sum,d)=>sum+d.text.length,0);
    if(fullLength<=MAX_CONTEXT_CHARS)return {text:docs.map(d=>`--- ${d.name} ---\n${d.text}`).join("\n\n"),notice:""};
    const broad=/\b(summar(y|ize|ise)|overview|study notes|revision|quiz|entire|whole document|key points)\b/i.test(question);
    const stop=new Set(["the","and","for","that","this","with","from","what","when","where","which","who","does","about","explain","summarize","summarise","summary","document","attached","file","please","could","would","into","have","does","make","create","notes","study","quiz"]);
    const terms=[...new Set((question.toLowerCase().match(/[a-z0-9]{3,}/g)||[]).filter(t=>!stop.has(t)))];
    const quota=Math.floor(MAX_CONTEXT_CHARS/docs.length);const output=[];
    docs.forEach(doc=>{
      const chunks=documentChunks(doc);let chosen=[];
      if(broad||!terms.length){
        let used=0;const target=Math.min(chunks.length,Math.max(1,Math.floor(quota/1800)));
        for(let i=0;i<target;i++){const index=target===1?Math.floor((chunks.length-1)/2):Math.round(i*(chunks.length-1)/(target-1));const c=chunks[index];if(c&&used+c.length<=quota){chosen.push(c);used+=c.length;}}
      } else {
        const ranked=chunks.map((text,index)=>({text,index,score:terms.reduce((s,t)=>s+(text.toLowerCase().match(new RegExp(`\\b${t}\\b`,"g"))||[]).length,0)})).sort((a,b)=>b.score-a.score||a.index-b.index);
        let used=0;const selected=[];for(const c of ranked){if(c.score<=0)break;if(used+c.text.length<=quota){selected.push(c);used+=c.text.length;}}
        chosen=selected.sort((a,b)=>a.index-b.index).map(c=>c.text);if(!chosen.length&&chunks[0])chosen=[chunks[0]];
      }
      if(chosen.length)output.push(`--- ${doc.name} (selected excerpts; source ${doc.text.length.toLocaleString()} characters) ---\n${chosen.join("\n[…]\n")}`);
    });
    return {text:`[The source document(s) exceed the context limit. Only relevant chunks or evenly spaced excerpts are supplied; not all content is included.]\n\n${output.join("\n\n")}`,notice:"Long file(s): only selected chunks/excerpts are sent for this question; not all content is included."};
  }
  function historyWithDocuments(question="") {
    const convo=typeof getCurrentConversation==="function"?getCurrentConversation():null;
    const docs=convo?liveDocs.get(convo.id):null;
    return docs?.length?selectDocumentContext(docs,question).text:"";
  }
  function providerDestination() {
    if(settings.provider==="ollama")return `ollama:${settings.ollamaUrl.trim()}`;
    if(settings.provider==="gemini")return `gemini:${settings.geminiModel.trim()}`;
    if(settings.provider==="openai")return `openai:${settings.baseUrl.trim()}`;
    return "basic";
  }
  function basicWithDocs(message, docs) {
    if(docs) {
      const chunks = [...docs.matchAll(/--- ([^\n]+) ---\n([\s\S]*?)(?=\n--- [^\n]+ ---\n|$)/g)];
      const entries = chunks.length ? chunks : [{1:"Attached file",2:docs}];
      const previews = entries.map(item => {
        const body = String(item[2]).replace(/\[Page (\d+)\]\s*/g,"(page $1) ").replace(/\s+/g," ").trim();
        const sentences = body.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [body];
        const excerpt = sentences.slice(0,3).join(" ").trim().slice(0,520);
        return `**${item[1]}** (${body.length.toLocaleString()} extracted characters)\n${excerpt}${body.length>excerpt.length?"…":""}`;
      }).join("\n\n");
      return `I extracted the attachment text locally. Here's a quick text preview (not an AI-generated summary):\n\n${previews}\n\nBasic guided mode does not send this document anywhere and cannot reason over the full file. Connect Ollama or a provider in Settings for detailed explanations, questions, notes, or quizzes. The extracted text stays in this tab's memory.`;
    }
    return basicReply(message);
  }

  window.getBotResponse = async function(message, onChunk, documentText = "") {
    if(settings.provider==="basic") return basicWithDocs(message,documentText||historyWithDocuments(message));
    if(settings.provider==="ollama") { setHeaderStatus("Using local Ollama","neutral"); return await streamOllama(message,documentText||historyWithDocuments(message),onChunk); }
    if(settings.provider==="openai") { setHeaderStatus("Using selected provider","neutral"); return await streamOpenAI(message,documentText||historyWithDocuments(message),onChunk); }
    if(settings.provider==="gemini") { setHeaderStatus("Using Gemini","neutral"); return await geminiCall(message,documentText||historyWithDocuments(message)); }
    throw new Error("Unknown provider selection. Open Settings and choose a provider.");
  };

  window.sendMessage = async function(text) {
    if(busy)return;
    const message=(text??$("#input").value).trim(); if(!message && !pendingFiles.length)return;
    if(settings.provider==="basic" && pendingFiles.length) { /* local extraction is still useful in guided mode, without transmission */ }
    // Creator attribution stays deterministic even if a remote model ignores its system instructions.
    if(!pendingFiles.length && /\b(who (created|built|made|developed) (you|luzyx)|who('?s| is) your creator|your creator|who made you)\b/i.test(message)) {
      addMessage(message,"user"); $("#input").value=""; autoGrow(); addMessage(creatorReply(),"bot"); return;
    }
    const cachedDocs = !pendingFiles.length ? historyWithDocuments(message) : "";
    const hasRemoteDocs = settings.provider!=="basic" && (pendingFiles.length>0 || Boolean(cachedDocs));
    if(hasRemoteDocs) {
      if(pendingFiles.length>MAX_FILES){setHeaderStatus(`Attach up to ${MAX_FILES} files at once`,"error");return;}
      const consentKey=`${currentId||"new"}|${providerDestination()}`;
      const alreadyConsented=!pendingFiles.length&&documentConsent.get(consentKey);
      if(!alreadyConsented) {
        const names=pendingFiles.length?pendingFiles.map(f=>f.name).join(", "):"the attached document text from this conversation";
        if(!confirm(`Text from ${names} will be sent directly to ${settings.provider==="ollama"?"your selected local Ollama service":settings.provider==="gemini"?"Google Gemini":"the provider endpoint you selected"} so it can answer. The file itself is not uploaded to LUZYX's backend. Continue?`))return;
      }
    }
    busy=true; activeController=new AbortController(); const wholeRequestTimer=setTimeout(()=>activeController?.abort(),120000); const send=$("#send");send.disabled=true; const cancel=$("#cancelSend");if(cancel)cancel.hidden=false; const input=$("#input");
    let userText=message || (pendingFiles.length?"Please review the attached file(s).":"");
    if(pendingFiles.length) userText += `${userText?"\n":""}[Attached: ${pendingFiles.map(f=>f.name).join(", ")}]`;
    addMessage(userText,"user"); input.value="";autoGrow();
    if(hasRemoteDocs)documentConsent.set(`${currentId||"new"}|${providerDestination()}`,true);
    const files=[...pendingFiles];pendingFiles=[];renderFiles();
    const typing=showTyping();let streamRow=null,streamBubble=null,latestFull="",renderQueued=false;
    try {
      const docs=files.length?await (async()=>{const out=[];for(let i=0;i<files.length;i++){setHeaderStatus(`Reading file ${i+1} of ${files.length}…`,`neutral`);out.push(await extractFile(files[i]));}const selected=selectDocumentContext(out,message);const warnings=out.map(d=>d.warning).filter(Boolean);if(selected.notice)setHeaderStatus(selected.notice,"neutral");else if(warnings.length)setHeaderStatus(warnings.join(" "),"neutral");if(currentId)liveDocs.set(currentId,out);return selected.text;})():historyWithDocuments(message);
      const reply=await getBotResponse(message||"Please review the attached file(s).",(chunk,full)=>{if(!streamRow){typing.remove();streamRow=document.createElement("div");streamRow.className="msg bot";streamRow.innerHTML='<div class="avatar">LZ</div><div class="bubble streaming"></div>';streamBubble=streamRow.querySelector(".bubble");chat.appendChild(streamRow);}latestFull=full;if(!renderQueued){renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;if(latestFull!==null&&streamBubble&&streamBubble.isConnected){const wasNear=isNearBottom();renderMarkdownSafe(streamBubble,latestFull);maybeScroll(wasNear);}});}},docs);
      latestFull=null;if(streamRow){renderMarkdownSafe(streamBubble,reply);streamBubble.classList.remove("streaming");const t=document.createElement("span");t.className="time";t.textContent=timeNow();streamBubble.appendChild(t);const copy=document.createElement("button");copy.type="button";copy.className="copy-reply";copy.textContent="Copy";copy.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(reply);copy.textContent="Copied";setTimeout(()=>copy.textContent="Copy",1200);}catch(_){copy.textContent="Copy unavailable";}});streamBubble.appendChild(copy);const convo=getCurrentConversation();if(convo){convo.messages.push({who:"bot",text:reply,time:t.textContent});convo.updatedAt=Date.now();saveConversations();renderHistory();}}
      else {typing.remove();const storedReply=settings.provider==="basic"&&docs?"I extracted a local document preview. The preview itself was not saved to chat history; Basic mode sent no file content to a service.":reply;addMessage(reply,"bot",storedReply);}
      if(settings.provider==="basic")setHeaderStatus("Basic mode · local reply","neutral");
      else setHeaderStatus(settings.provider==="ollama"?"Ollama connected":"Connected for this request","ok");
    } catch(err) {
      typing.remove();streamRow?.remove();const detail=err.name==="AbortError"?"Request cancelled or timed out. You can try again.":(err.message||"Request failed. Check the selected provider and try again.");addMessage(detail,"bot");setHeaderStatus("Connection or request failed","error");
    } finally {clearTimeout(wholeRequestTimer);activeController=null;busy=false;send.disabled=false;if(cancel)cancel.hidden=true;input.focus();}
  };

  async function testConnection() {
    const p=$("#providerSelect").value;
    settings.provider=p; settings.apiKey=$("#apiKeyInput").value.trim(); settings.model=$("#modelInput").value.trim(); settings.baseUrl=$("#baseUrlInput").value.trim(); settings.ollamaUrl=$("#ollamaUrlInput").value.trim(); settings.ollamaModel=$("#ollamaModelSelect").value || settings.ollamaModel; settings.geminiModel=$("#geminiModelInput").value.trim();
    setSettingsStatus("Testing selected service…"); const btn=$("#testProviderBtn");btn.disabled=true;
    try {
      if(p==="basic"){setSettingsStatus("Basic guided mode is ready; it does not connect to an AI model.");setHeaderStatus("Basic mode","neutral");return;}
      if(p==="ollama") {const models=await ollamaModels();renderOllamaModels(models);if(!models.length){setSettingsStatus("Ollama connected, but no local models found. Run: ollama pull llama3.2",true);setHeaderStatus("No local models found","neutral");return;}if(!settings.ollamaModel)settings.ollamaModel=models[0];setSettingsStatus(`Ollama connected. ${models.length} model(s) detected; selected: ${settings.ollamaModel}.`);setHeaderStatus("Ollama connected","ok");return;}
      if(p==="openai") {
        if(!settings.apiKey)throw new Error("Enter an API key first.");if(!settings.model)throw new Error("Enter an exact model ID first.");
        const r=await checkedFetch(normalizeBase(settings.baseUrl),{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${settings.apiKey}`},body:JSON.stringify({model:settings.model,messages:[{role:"user",content:"Reply only: connected"}],max_tokens:8,stream:false})},20000);if(!r.ok)throw new Error(safeHttpError(r.status));const d=await r.json();if(!d.choices?.[0]?.message?.content)throw new Error("The endpoint responded, but its response was not a supported chat-completions response.");setSettingsStatus("Connection test succeeded for the selected endpoint and model.");setHeaderStatus("Connection test passed","ok");return;
      }
      if(p==="gemini") {if(!settings.apiKey)throw new Error("Enter a Gemini API key first.");if(!settings.geminiModel)throw new Error("Enter a Gemini model ID first.");await geminiCall("Reply only with the word connected.","");setSettingsStatus("Connection test succeeded for the selected Gemini model.");setHeaderStatus("Connection test passed","ok");return;}
    } catch(e) { setSettingsStatus(e.message||"Connection test failed.",true);setHeaderStatus("Connection test failed","error"); }
    finally {btn.disabled=false;}
  }
  async function retryOllama() {
    const button=$("#retryOllamaBtn");button.disabled=true;setSettingsStatus("Checking local AI…");
    settings.ollamaUrl=$("#ollamaUrlInput").value.trim()||"http://localhost:11434";
    try {const models=await ollamaModels();renderOllamaModels(models);if(!models.length){setSettingsStatus("Ollama connected. No local models found; run: ollama pull llama3.2",true);setHeaderStatus("No local models found","neutral");}else{setSettingsStatus(`Ollama connected. Found ${models.length} model(s). Choose one below.`);setHeaderStatus("Ollama connected","ok");}}
    catch(e){setSettingsStatus(`${e.message} Please start Ollama and try again. For a public HTTPS page, browser local-network restrictions may prevent detection.`,true);setHeaderStatus("Ollama is not reachable","error");}
    finally{button.disabled=false;}
  }
  function renderOllamaModels(models) {
    const select=$("#ollamaModelSelect");if(!select)return;
    const opts=models||[];const keep=settings.ollamaModel;select.replaceChildren();
    if(!opts.length){const o=document.createElement("option");o.value="";o.textContent=keep||"No model detected yet";select.appendChild(o);select.value="";return;}
    for(const name of opts){const o=document.createElement("option");o.value=name;o.textContent=name;select.appendChild(o);}if(opts.includes(keep))select.value=keep;else{select.value=opts[0];settings.ollamaModel=opts[0];}
  }

  const picker=$("#filePicker"), attach=$("#attachBtn");
  $("#cancelSend")?.addEventListener("click",()=>{if(activeController){activeController.abort();setHeaderStatus("Cancelling request…","neutral");}});
  attach?.addEventListener("click",()=>picker.click());
  picker?.addEventListener("change",()=>{const incoming=[...picker.files];for(const f of incoming){if(pendingFiles.length>=MAX_FILES){setHeaderStatus(`Maximum ${MAX_FILES} attachments per message`,"error");break;}if(!ALLOWED.has(f.name.split(".").pop().toLowerCase())){setHeaderStatus(`Unsupported file: ${f.name}`,"error");continue;}if(f.size>MAX_FILE_BYTES){setHeaderStatus(`${f.name} exceeds the 15 MB limit`,"error");continue;}if(pendingFiles.some(x=>x.name===f.name&&x.size===f.size)){setHeaderStatus(`${f.name} is already attached`,"neutral");continue;}pendingFiles.push(f);}picker.value="";renderFiles();if(pendingFiles.length)setHeaderStatus("Files ready · contents processed locally","neutral");});
  $("#openSettingsBtn")?.addEventListener("click",openSettings);
  $("#closeSettingsBtn")?.addEventListener("click",()=>$("#settingsDialog").close());
  $("#providerSelect")?.addEventListener("change",()=>{updateProviderFields();if($("#providerSelect").value==="ollama"){settings.ollamaUrl=$("#ollamaUrlInput").value.trim()||settings.ollamaUrl;retryOllama();}});
  $("#testProviderBtn")?.addEventListener("click",testConnection);
  $("#retryOllamaBtn")?.addEventListener("click",retryOllama);
  $("#ollamaModelSelect")?.addEventListener("change",e=>settings.ollamaModel=e.target.value);
  $("#saveSettingsBtn")?.addEventListener("click",()=>{
    settings.provider=$("#providerSelect").value;settings.apiKey=$("#apiKeyInput").value.trim();settings.model=$("#modelInput").value.trim();settings.baseUrl=$("#baseUrlInput").value.trim();settings.ollamaUrl=$("#ollamaUrlInput").value.trim()||"http://localhost:11434";settings.ollamaModel=$("#ollamaModelSelect").value||settings.ollamaModel;settings.geminiModel=$("#geminiModelInput").value.trim()||"gemini-2.5-flash";
    if(settings.provider==="openai"&&settings.apiKey&&(!settings.model||!settings.baseUrl)){setSettingsStatus("Enter both the exact model ID and base URL before saving.",true);return;}
    if(settings.provider==="gemini"&&settings.apiKey&&!settings.geminiModel){setSettingsStatus("Enter a Gemini model ID before saving.",true);return;}
    if(persistSettings()){updateModeUI();setSettingsStatus("Settings saved in this browser. API keys in localStorage are not completely secure and may be exposed by malicious scripts or anyone with access to this browser profile.");}
  });
  $("#removeSettingsBtn")?.addEventListener("click",()=>{settings={...SETTINGS_DEFAULT};try{localStorage.removeItem(settingsKey);}catch(_){}syncSettingsForm();updateModeUI();setSettingsStatus("Saved credentials and provider settings were removed from this browser.");});
  $("#infoBtn")?.addEventListener("click",()=>{addMessage("LUZYX is a mini AI assistant created by Lucky. It can run in Basic guided mode without a model, use a local Ollama model, or use a provider you configure in Settings. Basic mode is not a connected remote AI model.","bot");});
  window.addEventListener("beforeunload",()=>{activeController?.abort();});
  syncSettingsForm();updateModeUI();renderFiles();renderHistory();if(currentId)openConversation(currentId);
  if(settings.provider==="ollama")setTimeout(retryOllama,0);
  // Ollama detection is non-blocking and begins only after the user selected that mode.
})();
