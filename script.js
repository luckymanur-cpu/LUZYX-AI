/* =====================================================
   LUZYX — Mini AI Assistant
   script.js

   Sections:
     CHAT STATE
     CHAT HISTORY
     MESSAGE RENDERING
     SIDEBAR
     COMPOSER
     BACKGROUND ENGINE
     PARTICLE SYSTEM
     CURSOR INTERACTION
     ANIMATION LOOP
     RESPONSIVE BEHAVIOR
     ACCESSIBILITY
   ===================================================== */

/* =====================================================
   CHAT STATE
   ===================================================== */
const chat           = document.getElementById("chat");
const welcome        = document.getElementById("welcome");
const main           = document.getElementById("main");
const form           = document.getElementById("composer");
const input          = document.getElementById("input");
const sendBtn        = document.getElementById("send");
const scrollBtn      = document.getElementById("scrollBottomBtn");

const shell           = document.querySelector(".shell");
const sidebar         = document.getElementById("sidebar");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const historyEl       = document.getElementById("history");
const menuBtn         = document.getElementById("menuBtn");
const sidebarCloseBtn = document.getElementById("sidebarClose");
const newChatBtn      = document.getElementById("newChatBtn");
const backBtn         = document.getElementById("backBtn");

let started = false;

// Shared capability flags — read once, used by several sections below
// so every part of the animation system agrees on what's allowed.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isTouch      = window.matchMedia("(hover: none), (pointer: coarse)").matches;

/* =====================================================
   CHAT HISTORY (persisted to localStorage)
   Each conversation: { id, title, messages: [{who,text,time}], createdAt, updatedAt }
   ===================================================== */
const STORAGE_KEY = "luzyx.conversations.v1";

let conversations = loadConversations();
let currentId = null; // null = no active conversation (welcome view)

function loadConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("LUZYX: could not read chat history", err);
    return [];
  }
}

function saveConversations() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  } catch (err) {
    console.error("LUZYX: could not save chat history", err);
  }
}

function getCurrentConversation() {
  return conversations.find(c => c.id === currentId) || null;
}

function makeTitle(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? clean.slice(0, 42).trim() + "…" : clean;
}

function createConversation() {
  const convo = {
    id: (crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now() + Math.random().toString(16).slice(2)),
    title: null, // generated from first user message
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  conversations.unshift(convo);
  currentId = convo.id;
  return convo;
}

/* ---------------- Sidebar rendering ---------------- */
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderHistory() {
  historyEl.innerHTML = "";

  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Your conversations will appear here.";
    historyEl.appendChild(empty);
    return;
  }

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map();
  sorted.forEach(c => {
    const label = dayLabel(c.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(c);
  });

  groups.forEach((items, label) => {
    const group = document.createElement("div");
    group.className = "history-group";
    const heading = document.createElement("p");
    heading.className = "history-label";
    heading.textContent = label;
    group.appendChild(heading);

    items.forEach(c => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item" + (c.id === currentId ? " active" : "");
      btn.setAttribute("aria-current", c.id === currentId ? "true" : "false");
      btn.innerHTML = `
        <svg class="h-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.4 8.5 8.5 0 0 1-4-1L3 20l1.1-5.5a8.4 8.4 0 0 1-1-4A8.38 8.38 0 0 1 11.5 2h.5a8.4 8.4 0 0 1 9 8.4z"/>
        </svg>
        <span></span>`;
      btn.querySelector("span").textContent = c.title || "New conversation";
      btn.addEventListener("click", () => {
        openConversation(c.id);
        closeSidebarOnMobile();
      });
      group.appendChild(btn);
    });

    historyEl.appendChild(group);
  });
}

/* ---------------- View switching ---------------- */
function showWelcomeView() {
  started = false;
  currentId = null;
  chat.innerHTML = "";
  chat.hidden = true;
  welcome.hidden = false;
  backBtn.hidden = true;
  hideScrollButton();
  renderHistory();
}

function openConversation(id) {
  const convo = conversations.find(c => c.id === id);
  if (!convo) return;
  currentId = id;
  started = true;
  welcome.hidden = true;
  chat.hidden = false;
  backBtn.hidden = false;
  chat.innerHTML = "";
  convo.messages.forEach(m => renderMessage(m.text, m.who, m.time));

  // Short cross-fade rather than an instant swap of the transcript.
  chat.classList.remove("switching");
  void chat.offsetWidth; // restart the animation
  chat.classList.add("switching");

  scrollToEnd(true);
  hideScrollButton();
  renderHistory();
}

/* New Chat: don't create an empty duplicate conversation up front —
   the conversation is created lazily on the first message sent. */
newChatBtn.addEventListener("click", () => {
  const current = getCurrentConversation();
  if (current && current.messages.length === 0) {
    // already on an empty conversation — nothing to duplicate
  } else {
    showWelcomeView();
  }
  closeSidebarOnMobile();
  input.focus();
});

/* Back: leave the open conversation without deleting it. It stays
   fully intact in history and can be reopened from the sidebar. */
backBtn.addEventListener("click", () => {
  showWelcomeView();
  if (window.matchMedia("(max-width:960px)").matches) openSidebar();
});

/* ---------------- Sidebar open/close (mobile drawer) ---------------- */
function openSidebar() {
  shell.classList.add("sidebar-open");
  menuBtn.setAttribute("aria-expanded", "true");
}
function closeSidebar() {
  shell.classList.remove("sidebar-open");
  menuBtn.setAttribute("aria-expanded", "false");
}
function closeSidebarOnMobile() {
  if (window.matchMedia("(max-width:960px)").matches) closeSidebar();
}

menuBtn.addEventListener("click", () => {
  shell.classList.contains("sidebar-open") ? closeSidebar() : openSidebar();
});
sidebarCloseBtn.addEventListener("click", closeSidebar);
sidebarBackdrop.addEventListener("click", closeSidebar);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && shell.classList.contains("sidebar-open")) closeSidebar();
});

/* =====================================================
   MESSAGE RENDERING
   ===================================================== */
function timeNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMessage(text, who, time) {
  const row = document.createElement("div");
  row.className = `msg ${who}`;
  row.innerHTML = `
    <div class="avatar">${who === "bot" ? "LZ" : "You"}</div>
    <div class="bubble"></div>`;
  const bubble = row.querySelector(".bubble");
  bubble.textContent = text;
  const t = document.createElement("span");
  t.className = "time";
  t.textContent = time || timeNow();
  bubble.appendChild(t);
  chat.appendChild(row);
  return row;
}

/* ---------------- Scroll behaviour ---------------- */
// The user should never be yanked back to the bottom while reading
// older messages — only auto-follow new content when they were
// already close to the bottom, and offer a floating button otherwise.
const NEAR_BOTTOM_PX = 140;

function isNearBottom() {
  return main.scrollHeight - main.scrollTop - main.clientHeight < NEAR_BOTTOM_PX;
}

function scrollToEnd(instant = false) {
  requestAnimationFrame(() => {
    if (instant) main.scrollTo({ top: main.scrollHeight, behavior: "instant" });
    else main.scrollTop = main.scrollHeight;
  });
}

function showScrollButton() {
  scrollBtn.classList.add("show");
}
function hideScrollButton() {
  scrollBtn.classList.remove("show");
}

// Auto-scroll if the message is the user's own, or if the reader was
// already near the bottom before this message arrived; otherwise
// surface the "New messages" button instead of forcing a jump.
function maybeScroll(force) {
  if (force || isNearBottom()) {
    scrollToEnd();
    hideScrollButton();
  } else {
    showScrollButton();
  }
}

scrollBtn.addEventListener("click", () => {
  scrollToEnd();
  hideScrollButton();
});

let scrollTicking = false;
main.addEventListener("scroll", () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    if (isNearBottom()) hideScrollButton();
    scrollTicking = false;
  });
}, { passive: true });

function addMessage(text, who /* "bot" | "user" */, persistedText = text) {
  startChat();

  const wasNearBottom = isNearBottom();

  let convo = getCurrentConversation();
  if (!convo) convo = createConversation();

  const time = timeNow();
  convo.messages.push({ who, text: persistedText, time });
  convo.updatedAt = Date.now();
  if (who === "user" && !convo.title) convo.title = makeTitle(text);

  saveConversations();
  renderHistory();

  const row = renderMessage(text, who, time);
  maybeScroll(who === "user" || wasNearBottom);
  return row;
}

function showTyping() {
  const row = document.createElement("div");
  row.className = "msg bot";
  row.id = "typing";
  row.innerHTML = `
    <div class="avatar">LZ</div>
    <div class="bubble typing"><i></i><i></i><i></i></div>`;
  chat.appendChild(row);
  maybeScroll(false);
  return row;
}

function startChat() {
  if (started) return;
  started = true;
  welcome.hidden = true;
  chat.hidden = false;
  backBtn.hidden = false;
}

/* ---------------- Send flow ---------------- */
async function sendMessage(text) {
  const message = (text ?? input.value).trim();
  if (!message) return;

  addMessage(message, "user");
  input.value = "";
  autoGrow();
  sendBtn.disabled = true;

  sendBtn.classList.remove("sent");
  void sendBtn.offsetWidth;
  sendBtn.classList.add("sent");

  const typing = showTyping();
  let streamRow = null;
  let streamBubble = null;
  let streamedText = "";

  try {
    const reply = await getBotResponse(message, (chunk, fullText) => {
      streamedText = fullText;

      // Replace the typing dots as soon as the first real token arrives.
      if (!streamRow) {
        typing.remove();
        streamRow = document.createElement("div");
        streamRow.className = "msg bot";
        streamRow.innerHTML = '<div class="avatar">LZ</div><div class="bubble streaming"></div>';
        streamBubble = streamRow.querySelector(".bubble");
        chat.appendChild(streamRow);
      }

      if (streamBubble) {
        streamBubble.textContent = fullText;
        maybeScroll(false);
      }
    });

    if (streamRow) {
      // Add the timestamp after streaming completes.
      const t = document.createElement("span");
      t.className = "time";
      t.textContent = timeNow();
      streamBubble.appendChild(t);

      const convo = getCurrentConversation();
      if (convo) {
        convo.messages.push({ who: "bot", text: reply, time: t.textContent });
        convo.updatedAt = Date.now();
        saveConversations();
        renderHistory();
      }
    } else {
      typing.remove();
      addMessage(reply, "bot");
    }
  } catch (err) {
    typing.remove();
    if (streamRow) streamRow.remove();

    addMessage(
      err.message || "LUZYX is having trouble connecting right now. Please try again.",
      "bot"
    );
    console.error(err);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}
/* Provider-specific chat and request handling live in assistant.js.
   This core file retains shared conversation rendering and UI behavior only. */
/* =====================================================
   COMPOSER
   ===================================================== */
function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}
input.addEventListener("input", autoGrow);

input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

form.addEventListener("submit", e => { e.preventDefault(); sendMessage(); });

document.querySelectorAll("[data-prompt]").forEach(el => {
  el.addEventListener("click", () => sendMessage(el.dataset.prompt));
});

// Suggestion cards: a soft radial highlight that tracks the cursor
// position within each card (--mx/--my consumed by .card::after in CSS).
if (!isTouch) {
  document.querySelectorAll(".card").forEach(card => {
    card.addEventListener("mousemove", e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
      card.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
    }, { passive: true });
  });
}

/* =====================================================
   BACKGROUND ENGINE
   PARTICLE SYSTEM
   CURSOR INTERACTION
   ANIMATION LOOP
   -----------------------------------------------------
   A single requestAnimationFrame loop drives everything visual:
   canvas particles (with gentle mouse reactivity + faint neural-net
   style connections), the multi-layer cursor light, the parallax
   depth layers, and the four "magnetic" buttons. Keeping it one loop
   (rather than one per effect) keeps the per-frame cost predictable
   and easy to pause as a single unit.
   ===================================================== */
(function backgroundEngine() {
  const canvas      = document.getElementById("particles");
  const ctx         = canvas.getContext("2d");
  const cursorLight = document.getElementById("cursorLight");
  const cursorAura  = document.getElementById("cursorAura");
  const cursorGlow  = document.getElementById("cursorGlow");
  const cursorPoint = document.getElementById("cursorPoint");
  const docEl       = document.documentElement;

  const MAGNETIC = [newChatBtn, sendBtn, menuBtn, backBtn].filter(Boolean);
  const MAG_RADIUS = 70; // px — how close the cursor needs to be to start pulling
  const MAG_MAX    = 3;  // px — maximum nudge toward the cursor

  let dots = [], linkable = [], w = 0, h = 0, dpr = 1;
  let tabVisible = true;
  let rafId = null;

  // Raw cursor position in viewport (CSS px) coordinates — the single
  // source of truth that every lerped tracker below eases toward.
  const cursor = { x: innerWidth / 2, y: innerHeight / 2, active: false };

  // Canvas-space pointer used by the particle system (kept separate
  // from `cursor` since it's scaled by devicePixelRatio).
  const pointer = { targetX: -9999, targetY: -9999, x: -9999, y: -9999, active: false };
  const REACT_RADIUS = 140;

  // Independently-lerped cursor-light trackers: point (fast, almost no
  // lag), glow (medium), aura (slow, large trailing field).
  const lightPoint = { x: cursor.x, y: cursor.y };
  const lightGlow  = { x: cursor.x, y: cursor.y };
  const lightAura  = { x: cursor.x, y: cursor.y };

  // Per-button lerped magnetic offset, keyed by element.
  const magState = MAGNETIC.map(el => ({ el, x: 0, y: 0 }));

  /* ---------------- PARTICLE SYSTEM: layout ---------------- */
  // Three depth "layers" of particles — distant (small, slow, faint),
  // mid, and foreground (bigger, faster, more reactive) — so the field
  // reads with some depth rather than one flat plane of dots.
  const LAYERS = [
    { share: .50, rMin: .5, rMax: 1.2, speed: .09, aMin: .12, aMax: .32, react: .55 },
    { share: .35, rMin: .9, rMax: 1.7, speed: .16, aMin: .22, aMax: .5,  react: 1   },
    { share: .15, rMin: 1.5, rMax: 2.4, speed: .25, aMin: .35, aMax: .75, react: 1.6 },
  ];
  const CONNECT_DIST = 108; // px (before dpr scaling) — kept short: faint, sparse, not a spiderweb

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = innerWidth * dpr;
    h = canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";

    const total = Math.round(Math.min(70, innerWidth / 18));
    dots = [];
    LAYERS.forEach((layer, layerIndex) => {
      const count = Math.round(total * layer.share);
      for (let i = 0; i < count; i++) {
        dots.push({
          x: Math.random() * w, y: Math.random() * h,
          r: (layer.rMin + Math.random() * (layer.rMax - layer.rMin)) * dpr,
          vx: (Math.random() - .5) * layer.speed * dpr,
          vy: (Math.random() - .5) * layer.speed * dpr,
          o: layer.aMin + Math.random() * (layer.aMax - layer.aMin),
          react: layer.react,
          layer: layerIndex,
        });
      }
    });
    // Only mid + foreground particles connect — keeps the O(n²) check
    // cheap and avoids a dense web from the many faint distant dots.
    linkable = dots.filter(d => d.layer >= 1);
  }

  /* ---------------- PARTICLE SYSTEM: per-frame draw ---------------- */
  function drawParticles() {
    ctx.clearRect(0, 0, w, h);

    pointer.x += (pointer.targetX - pointer.x) * 0.12;
    pointer.y += (pointer.targetY - pointer.y) * 0.12;
    const radius = REACT_RADIUS * dpr;

    for (const d of dots) {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0) d.x = w; if (d.x > w) d.x = 0;
      if (d.y < 0) d.y = h; if (d.y > h) d.y = 0;

      let drawX = d.x, drawY = d.y, drawO = d.o;

      if (pointer.active) {
        const dx = d.x - pointer.x;
        const dy = d.y - pointer.y;
        const distSq = dx * dx + dy * dy;
        const r2 = radius * radius;
        if (distSq < r2) {
          const dist = Math.sqrt(distSq) || 0.01;
          const strength = (1 - dist / radius) * d.react;
          const push = strength * 14 * dpr; // gentle nudge, not a jump
          drawX = d.x + (dx / dist) * push;
          drawY = d.y + (dy / dist) * push;
          drawO = Math.min(1, d.o + strength * 0.35);
        }
      }

      d._drawX = drawX; d._drawY = drawY; d._drawO = drawO;

      ctx.beginPath();
      ctx.arc(drawX, drawY, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(160,210,255,${drawO})`;
      ctx.fill();
    }

    // Faint neural-net style connections between nearby mid/foreground
    // particles — cursor proximity briefly boosts their opacity.
    const connectDist = CONNECT_DIST * dpr;
    const connectDistSq = connectDist * connectDist;
    for (let i = 0; i < linkable.length; i++) {
      for (let j = i + 1; j < linkable.length; j++) {
        const a = linkable[i], b = linkable[j];
        const dx = a._drawX - b._drawX;
        const dy = a._drawY - b._drawY;
        const distSq = dx * dx + dy * dy;
        if (distSq >= connectDistSq) continue;
        const dist = Math.sqrt(distSq);
        let alpha = (1 - dist / connectDist) * 0.14;

        if (pointer.active) {
          const mdx = (a._drawX + b._drawX) / 2 - pointer.x;
          const mdy = (a._drawY + b._drawY) / 2 - pointer.y;
          if (mdx * mdx + mdy * mdy < radius * radius) alpha *= 1.8;
        }

        ctx.beginPath();
        ctx.moveTo(a._drawX, a._drawY);
        ctx.lineTo(b._drawX, b._drawY);
        ctx.strokeStyle = `rgba(150,200,255,${Math.min(alpha, .4)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  /* ---------------- CURSOR INTERACTION ---------------- */
  function updateCursorLight() {
    lightPoint.x += (cursor.x - lightPoint.x) * 0.35;
    lightPoint.y += (cursor.y - lightPoint.y) * 0.35;
    lightGlow.x  += (cursor.x - lightGlow.x) * 0.16;
    lightGlow.y  += (cursor.y - lightGlow.y) * 0.16;
    lightAura.x  += (cursor.x - lightAura.x) * 0.07;
    lightAura.y  += (cursor.y - lightAura.y) * 0.07;

    cursorPoint.style.transform = `translate3d(${lightPoint.x.toFixed(1)}px, ${lightPoint.y.toFixed(1)}px, 0)`;
    cursorGlow.style.transform  = `translate3d(${lightGlow.x.toFixed(1)}px, ${lightGlow.y.toFixed(1)}px, 0)`;
    cursorAura.style.transform  = `translate3d(${lightAura.x.toFixed(1)}px, ${lightAura.y.toFixed(1)}px, 0)`;
  }

  // Parallax depth: derived from the medium-lag glow position, so the
  // background layers settle with the same smoothness as the light
  // itself. Each .parallax-layer supplies its own --depth multiplier.
  function updateParallax() {
    const nx = Math.max(-1, Math.min(1, (lightGlow.x - innerWidth / 2) / (innerWidth / 2)));
    const ny = Math.max(-1, Math.min(1, (lightGlow.y - innerHeight / 2) / (innerHeight / 2)));
    docEl.style.setProperty("--layer-px", nx.toFixed(3) + "px");
    docEl.style.setProperty("--layer-py", ny.toFixed(3) + "px");
  }

  // Magnetic buttons: a very subtle 1–3px pull while the cursor is
  // close but not yet on the button; CSS :hover/:active take over the
  // instant the cursor is actually over it, so clicking is never
  // affected — only the approach.
  function updateMagnetic() {
    magState.forEach(m => {
      const rect = m.el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = cursor.x - cx;
      const dy = cursor.y - cy;
      const dist = Math.hypot(dx, dy) || 0.001;
      const withinButton = dist < Math.max(rect.width, rect.height) / 2;

      let targetX = 0, targetY = 0;
      if (cursor.active && !withinButton && dist < MAG_RADIUS) {
        const pull = (1 - dist / MAG_RADIUS) * MAG_MAX;
        targetX = (dx / dist) * pull;
        targetY = (dy / dist) * pull;
      }

      m.x += (targetX - m.x) * 0.2;
      m.y += (targetY - m.y) * 0.2;

      if (withinButton && cursor.active) {
        m.el.style.transform = ""; // hand off to CSS :hover/:active
      } else if (Math.abs(m.x) > 0.05 || Math.abs(m.y) > 0.05) {
        m.el.style.transform = `translate3d(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px, 0)`;
      } else {
        m.el.style.transform = "";
      }
    });
  }

  /* ---------------- ANIMATION LOOP ---------------- */
  function tick() {
    drawParticles();
    updateCursorLight();
    updateParallax();
    updateMagnetic();
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (!reduceMotion && rafId === null && tabVisible) rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  /* ---------------- pointer events ---------------- */
  function onPointerMove(e) {
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    cursor.active = true;

    // Canvas fills the viewport (position:absolute inset:0 inside a
    // fixed-position background layer), so client coords map directly.
    pointer.targetX = e.clientX * dpr;
    pointer.targetY = e.clientY * dpr;
    pointer.active = true;

    cursorLight.classList.add("active");
  }

  function onPointerLeave() {
    pointer.active = false;
    cursor.active = false;
    cursorLight.classList.remove("active");
    // Retarget toward the viewport centre so every lerped tracker
    // (light layers, parallax, magnetism) eases back to neutral
    // instead of freezing at the last cursor position.
    pointer.targetX = (innerWidth / 2) * dpr;
    pointer.targetY = (innerHeight / 2) * dpr;
    cursor.x = innerWidth / 2;
    cursor.y = innerHeight / 2;
  }

  /* ---------------- RESPONSIVE BEHAVIOR ---------------- */
  document.addEventListener("visibilitychange", () => {
    tabVisible = !document.hidden;
    tabVisible ? startLoop() : stopLoop();
  });

  addEventListener("resize", resize);

  if (!reduceMotion && !isTouch) {
    addEventListener("mousemove", onPointerMove, { passive: true });
    // Fires when the cursor leaves the document entirely (e.g. to the
    // browser chrome), so particles/glow/magnetism settle back to idle.
    document.addEventListener("mouseout", e => { if (!e.relatedTarget) onPointerLeave(); }, { passive: true });
  }

  resize();
  if (!reduceMotion) startLoop();
  // Under reduced motion (or touch, for the cursor-only pieces) the
  // loop simply never starts: particles stay at their seeded layout,
  // no glow/parallax/magnetism runs, and the CSS in style.css hard-
  // disables the matching decorative layers for the same conditions.
})();

/* =====================================================
   ACCESSIBILITY
   -----------------------------------------------------
   - All interactive controls are real <button>s, so keyboard
     navigation (Tab/Shift+Tab/Enter/Space) works without extra JS.
   - aria-live on #chat announces new messages to screen readers.
   - aria-expanded/aria-current are kept in sync above (menuBtn,
     history items) as their state changes.
   - Decorative layers (.bg, cursor light, floating objects) are
     aria-hidden and never receive focus or pointer events.
   - prefers-reduced-motion is read once above (reduceMotion) and
     gates the entire animation loop plus the matching CSS; a coarse/
     no-hover pointer (isTouch) additionally skips cursor-only effects
     that have no meaning on a touchscreen.
   ===================================================== */

/* =====================================================
   Init — restore chat history from localStorage
   ===================================================== */
renderHistory();
const mostRecent = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
if (mostRecent && mostRecent.messages.length) {
  openConversation(mostRecent.id);
} else {
  showWelcomeView();
}

input.focus();
