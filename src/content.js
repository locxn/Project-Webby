// ===== Project Hermes Content Script (No-build) =====
// This content script is injected into web pages to detect and highlight specific UI elements,
// such as "Sign in" buttons or elements containing specified visible text. It communicates
// with the extension's background or popup scripts via message passing. Highlights are rendered
// as overlay rings around target elements, with optional labels, and automatically removed after a timeout.

(() => {
    // Message types used for communication with the extension
    const MSG = {
      PING: "HERMES_PING",                          // Ping message for health check (unused here)
      HIGHLIGHT_SIGN_IN: "HERMES_HIGHLIGHT_SIGN_IN",  // Command to highlight the best "Sign in" button
      HIGHLIGHT_BY_TEXT: "HERMES_HIGHLIGHT_BY_TEXT",  // Command to highlight element by visible text
      CLEAR_HIGHLIGHTS: "HERMES_CLEAR_HIGHLIGHTS",     // Command to clear all highlights
      OPEN_PANEL: "HERMES_OPEN_PANEL",                 // Command to open assistant panel
      TOGGLE_PANEL: "HERMES_TOGGLE_PANEL"              // Command to toggle assistant panel
    };
  
    // Normalize a string for case-insensitive, whitespace-normalized comparisons
    const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  
    // Safely get the bounding client rectangle of an element; returns default if error occurs
    const rectOf = (el) => { 
      try { 
        return el.getBoundingClientRect(); 
      } catch { 
        return { left:0, top:0, width:0, height:0 }; 
      } 
    };
  
    // Determine if an element is visible on the page
    // Checks for existence, element type, CSS visibility, display, opacity, and non-zero size
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
      const r = rectOf(el);
      return r.width > 0 && r.height > 0;
    };
  
    // Root container element for overlay highlights; created once per page
    let overlayRoot = null;
    // Ensure the overlay root element exists in the DOM; create it if missing
    function ensureOverlayRoot() {
      if (!overlayRoot) {
        overlayRoot = document.getElementById("__hermes_overlay_root");
        if (!overlayRoot) {
          overlayRoot = document.createElement("div");
          overlayRoot.id = "__hermes_overlay_root";
          overlayRoot.setAttribute("role", "presentation");
          // Style to cover entire viewport, highest z-index, and ignore pointer events
          Object.assign(overlayRoot.style, { position: "fixed", inset: "0", zIndex: 2147483647, pointerEvents: "none" });
          document.documentElement.appendChild(overlayRoot);
        }
      }
      return overlayRoot;
    }
  
    // Common keywords used to identify sign-in buttons
    const SIGNIN_KWS = ["sign in","signin","log in","login","log-in","sign-in"];
  
    // Collect all candidate elements that could be buttons or clickable links
    // Includes <button>, role="button", input buttons/submits, and anchor elements with role=button or href
    // Filters out invisible elements
    function allCandidateButtons(root = document) {
      const selectors = ["button","[role=button]","input[type=button]","input[type=submit]","a[role=button]","a[href]"];
      return Array.from(root.querySelectorAll(selectors.join(","))).filter(isVisible);
    }
  
    // Compute a heuristic score for an element based on keyword matches and element characteristics
    // Higher score means more likely to be a target button (e.g., Sign in)
    function scoreByKeywords(el, keywords) {
      // Gather text content and attributes to search for keywords
      const pieces = [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.value].map(normalize).filter(Boolean);
      const joined = pieces.join(" | ");
      let score = 0;
      // Add 10 points for each keyword found in the combined text
      for (const kw of keywords) if (joined.includes(kw)) score += 10;
      // Add 3 points if id or class contains "signin" or "login"
      const idClass = (el.id + " " + (el.className || "")).toLowerCase();
      if (/signin|login/.test(idClass)) score += 3;
      // Add 1.5 points if element is reasonably sized (width > 40px, height > 20px)
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 20) score += 1.5;
      // Add 1 point if element is a <button> or <input>
      if (["BUTTON","INPUT"].includes(el.tagName)) score += 1;
      return score;
    }
  
    // Find the best matching "Sign in" button within a root element
    // Returns the element with highest score above threshold, or null if none found
    function findBestSignIn(root = document) {
      const candidates = allCandidateButtons(root);
      let best = null, bestScore = -1;
      for (const el of candidates) {
        const s = scoreByKeywords(el, SIGNIN_KWS);
        if (s > bestScore) { best = el; bestScore = s; }
      }
      // Require minimum score of 10 to consider a match valid
      return bestScore >= 10 ? best : null;
    }
  
    // Find the best matching element by visible text content
    // Similar to findBestSignIn but uses a single target text keyword
    function findByVisibleText(txt, root = document) {
      const target = normalize(txt);
      const candidates = allCandidateButtons(root);
      let best = null, bestScore = -1;
      for (const el of candidates) {
        const s = scoreByKeywords(el, [target]);
        if (s > bestScore) { best = el; bestScore = s; }
      }
      // Require minimum score of 8 to consider a match valid
      return bestScore >= 8 ? best : null;
    }
  
    // Generator function to iterate over shadow roots within the document
    // This enables searching inside shadow DOMs for target elements
    function* walkShadowHosts(root = document) {
      const it = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
      let n; 
      while ((n = it.nextNode())) if (n.shadowRoot) yield n.shadowRoot;
    }
  
    // Search for a target element using a callback function, checking the main document and shadow roots
    function searchEverywhere(fn) {
      // First search in the main document
      const topHit = fn(document);
      if (topHit) return topHit;
      // Then search inside each shadow root found
      for (const sr of walkShadowHosts(document)) { 
        const inside = fn(sr); 
        if (inside) return inside; 
      }
      return null;
    }
  
    // Set to track currently active highlight ring and label elements for cleanup
    const rings = new Set();
  
    // UI control hooks for assistant panel; populated by initAssistantUI
    const uiControl = { open: () => {}, close: () => {}, toggle: () => {} };
  
    // Draw a highlight ring around a given element with optional label and styling
    // The ring and label are positioned absolutely in the overlay root and track element size changes
    // Automatically removes itself after ttlMs milliseconds (default 10 seconds)
    function drawRingAround(el, { label = null, pad = 8, circle = true, ttlMs = 10000 } = {}) {
      const root = ensureOverlayRoot();
      const r = rectOf(el);
      const ring = document.createElement("div");
      ring.className = "__hermes_ring";
      // Style the ring as a rounded border with shadow and semi-transparent background
      Object.assign(ring.style, {
        position: "absolute", 
        left: `${r.left - pad}px`, 
        top: `${r.top - pad}px`, 
        width: `${r.width + pad * 2}px`, 
        height: `${r.height + pad * 2}px`,
        border: "3px solid #5b47ff", 
        boxShadow: "0 6px 14px rgba(91,71,255,.35)", 
        background: "rgba(91,71,255,0.08)", 
        borderRadius: circle ? "9999px" : "14px", 
        pointerEvents: "none"
      });
      root.appendChild(ring); 
      rings.add(ring);
  
      let labelEl = null;
      if (label) {
        labelEl = document.createElement("div");
        labelEl.className = "__hermes_label";
        labelEl.textContent = label;
        // Style the label below the ring with readable font and subtle shadow
        Object.assign(labelEl.style, {
          position: "absolute", 
          left: `${r.left - pad}px`, 
          top: `${r.top + r.height + pad}px`,
          font: "600 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif", 
          color: "#111", 
          background: "#fff",
          border: "1px solid rgba(0,0,0,.12)", 
          borderRadius: "8px", 
          padding: "4px 8px", 
          boxShadow: "0 2px 8px rgba(0,0,0,.12)", 
          pointerEvents: "none"
        });
        root.appendChild(labelEl); 
        rings.add(labelEl);
      }
  
      // Update function to reposition and resize ring and label if the target element changes size or position
      const update = () => {
        const rr = rectOf(el);
        ring.style.left = `${rr.left - pad}px`;
        ring.style.top = `${rr.top - pad}px`;
        ring.style.width = `${rr.width + pad * 2}px`;
        ring.style.height = `${rr.height + pad * 2}px`;
        if (labelEl) { 
          labelEl.style.left = `${rr.left - pad}px`; 
          labelEl.style.top = `${rr.top + rr.height + pad}px`; 
        }
      };
      // Observe size changes of the target element to update highlight accordingly
      const ro = new ResizeObserver(update); 
      ro.observe(el);
      // Also update on scroll and resize events to keep highlight in sync with viewport changes
      const onScroll = () => update();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
  
      // Automatically remove highlight and cleanup after ttlMs milliseconds
      setTimeout(() => {
        ro.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
        ring.remove(); 
        labelEl?.remove(); 
        rings.delete(ring); 
        rings.delete(labelEl);
      }, ttlMs);
    }
  
    // Remove all active highlight rings and labels from the page
    function clearHighlights() { 
      for (const n of rings) n?.remove(); 
      rings.clear(); 
    }
  
    // Display a temporary toast message in the bottom-left corner of the viewport
    function toast(msg) {
      const root = ensureOverlayRoot();
      const t = document.createElement("div");
      Object.assign(t.style, {
        position: "fixed", 
        left: "16px", 
        bottom: "16px",
        font: "600 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        color: "#111", 
        background: "#fff", 
        border: "1px solid rgba(0,0,0,.12)", 
        borderRadius: "8px",
        padding: "6px 10px", 
        boxShadow: "0 2px 8px rgba(0,0,0,.12)", 
        pointerEvents: "none", 
        zIndex: 2147483647
      });
      t.textContent = msg; 
      root.appendChild(t); 
      setTimeout(() => t.remove(), 3000);
    }
  
    // Highlight the best matching "Sign in" button found anywhere on the page or in shadow roots
    function highlightSignIn() {
      // Use searchEverywhere to include shadow DOMs, fallback to main document search
      const el = searchEverywhere(findBestSignIn) || findBestSignIn(document);
      if (!el) return toast("Couldn’t find a Sign in button on this page.");
      // Smoothly scroll the element into center view
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Draw a circular highlight ring labeled "Sign in"
      drawRingAround(el, { label: "Sign in", circle: true });
    }
  
    // Highlight an element containing the specified visible text anywhere on the page or in shadow roots
    function highlightByText(text) {
      // Use searchEverywhere to include shadow DOMs, fallback to main document search
      const el = searchEverywhere((root) => findByVisibleText(text, root)) || findByVisibleText(text, document);
      if (!el) return toast(`Couldn’t find “${text}”.`);
      // Smoothly scroll the element into center view
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Draw a circular highlight ring labeled with the matched text
      drawRingAround(el, { label: `“${text}”`, circle: true });
    }
  
    // Listen for messages from the extension and respond accordingly
    chrome.runtime.onMessage.addListener((message) => {
      switch (message?.type) {
        case MSG.HIGHLIGHT_SIGN_IN: 
          // Highlight the sign-in button when requested
          return void highlightSignIn();
        case MSG.HIGHLIGHT_BY_TEXT: 
          // Highlight element by specified text
          return void highlightByText(message?.text || "");
        case MSG.CLEAR_HIGHLIGHTS: 
          // Clear all highlights on the page
          return void clearHighlights();
        case MSG.OPEN_PANEL:
          // Open assistant panel
          return void uiControl.open();
        case MSG.TOGGLE_PANEL:
          // Toggle assistant panel
          return void uiControl.toggle();
        default: 
          break;
      }
    });

  // ===== Assistant UI (floating button + basic panel) =====
  function initAssistantUI() {
    try { if (window.top !== window) return; } catch {}
    if (document.getElementById("__hermes_ui_host")) return;

    const host = document.createElement("div");
    host.id = "__hermes_ui_host";
    // Slightly below overlay root to allow rings to draw above if needed
    Object.assign(host.style, { position: "fixed", inset: "0", zIndex: 2147483646, pointerEvents: "none" });
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }

      /* Design tokens and accessibility variables */
      :host {
        /* Core palette */
        --bg: #ffffff;
        --fg: #0f172a;
        --accent: #5b47ff;            /* primary */
        --accent-contrast: #ffffff;
        --muted: #eef2ff;
        --subtext: #6b7280;

        /* Surfaces */
        --surface: #ffffff;
        --border: #00000022;
        --shadow: 0 10px 28px rgba(17,24,39,.22);

        /* Gradients */
        --header-gradient: linear-gradient(45deg, #5b47ff, #a855f7, #f97316);

        /* A11y */
        --focus: #ffd54f;

        /* Type scale */
        --fs: 18px;
      }
      :host([data-text-size="small"]) { --fs: 14px; }
      :host([data-text-size="medium"]) { --fs: 16px; }
      :host([data-text-size="large"]) { --fs: 18px; }

      :host([data-contrast="high"]) {
        --bg: #ffffff;
        --fg: #000000;
        --accent: #0b57d0;
        --accent-contrast: #ffffff;
        --border: #000;
        --shadow: 0 8px 24px rgba(0,0,0,.35);
        --focus: #ffcc00;
      }

      .hermes-fab {
        position: fixed; right: 20px; bottom: 20px;
        pointer-events: auto;
        width: 56px; height: 56px;
        border-radius: 999px; border: none;
        background: radial-gradient(120% 120% at 30% 20%, #7c6bff 0%, #5b47ff 45%, #7c3aed 100%);
        color: #fff;
        font: 800 24px/56px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        text-align: center;
        box-shadow: 0 10px 28px rgba(17,24,39,.28);
        cursor: pointer;
      }
      .hermes-fab:focus { outline: 3px solid var(--focus); outline-offset: 2px; }
      .hermes-fab:focus { outline: 3px solid var(--focus); outline-offset: 2px; }

      .hermes-panel {
        position: fixed; right: 20px; bottom: 76px;
        width: 380px; max-width: calc(100vw - 40px);
        max-height: calc(100vh - 120px);
        overflow: auto;
        pointer-events: auto;
        background: var(--bg); color: var(--fg);
        border: 2px solid var(--border); border-radius: 12px;
        box-shadow: var(--shadow);
        display: none;
      }
      .hermes-panel[open] { display: block; }

      .hermes-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 14px;
        background: var(--header-gradient);
        color: #fff;
        border-top-left-radius: 12px; border-top-right-radius: 12px;
      }
      .hermes-title {
        font: 800 calc(var(--fs) + 2px)/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      .icon-btn {
        width: 32px; height: 32px;
        border-radius: 999px;
        border: none;
        background: rgba(255,255,255,.18);
        color: #fff;
        cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        font: 900 16px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,.18) inset;
      }
      .icon-btn:focus { outline: 3px solid var(--focus); outline-offset: 2px; }

      /* Buttons use class="icon-btn" already; gear just adds spacing */
      .hermes-close {}
      .hermes-gear { margin-right: 8px; width: 36px; height: 36px; font-size: 18px; }

      /* Tabs (segmented) */
      .tabs {
        display: flex; gap: 6px; padding: 12px;
        background: #ffffff;
        border-bottom: 1px solid var(--border);
      }
      .tab {
        font: 800 var(--fs)/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: #f4f5ff; color: var(--fg);
        border-radius: 999px; border: 2px solid transparent;
        padding: 8px 14px; cursor: pointer;
      }
      .tab[aria-selected="true"] {
        background: #e9e8ff;
        border-color: var(--accent);
        color: var(--accent);
      }
      .tab:focus { outline: 3px solid var(--focus); outline-offset: 2px; }

      .panel { padding: 12px; font: 600 var(--fs)/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      [hidden] { display: none !important; }

      /* Chat */
      .chat-log {
        height: 220px; overflow: auto; border: 1px solid var(--border);
        border-radius: 12px; padding: 12px; background: #f8fafc;
      }
      .msg { margin: 10px 0; display: flex; flex-direction: column; }
      .msg.user { align-items: flex-end; }
      .msg.bot { align-items: flex-start; }
      .bubble {
        max-width: 80%;
        padding: 10px 12px;
        border-radius: 16px;
        box-shadow: 0 2px 8px rgba(0,0,0,.08);
        word-wrap: break-word;
      }
      .msg.user .bubble { background: var(--accent); color: var(--accent-contrast); border-top-right-radius: 4px; }
      .msg.bot .bubble { background: #eef3ff; color: var(--fg); border-top-left-radius: 4px; border: 1px solid #00000012; }
      .timestamp {
        margin-top: 4px; font: 700 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        color: var(--subtext); opacity: .85;
      }

      /* Typing indicator */
      .typing { display: inline-flex; gap: 4px; }
      .typing .dot {
        width: 6px; height: 6px; border-radius: 999px;
        background: #9aa5ff; animation: bounce 1s infinite ease-in-out;
      }
      .typing .dot:nth-child(2) { animation-delay: .15s; }
      .typing .dot:nth-child(3) { animation-delay: .30s; }
      @keyframes bounce {
        0%, 80%, 100% { transform: translateY(0); opacity: .5; }
        40% { transform: translateY(-4px); opacity: 1; }
      }

      .chat-input-row {
        margin-top: 12px; display: flex; gap: 8px;
      }
      .chat-input-row input[type="text"] {
        flex: 1; font: 600 var(--fs)/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        padding: 12px 14px; border-radius: 999px; border: 1px solid var(--border);
        background: #fff;
      }
      .chat-input-row button {
        width: 48px; height: 48px;
        font: 900 18px/48px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: var(--accent); color: var(--accent-contrast);
        border: none; border-radius: 999px; cursor: pointer;
        box-shadow: 0 6px 16px rgba(17,24,39,.18);
      }
      .chat-input-row button:focus { outline: 3px solid var(--focus); outline-offset: 2px; }

      /* Rich bubble formatting (response rendered like a card) */
      .bubble .text { white-space: pre-wrap; }
      .bubble .card {
        border: 1px dashed var(--border);
        background: #fff;
        border-radius: 10px;
        padding: 10px;
        margin-top: 8px;
      }
      .bubble .card .title { font-weight: 900; margin-bottom: 6px; }
      .bubble .card ol { margin: 0 0 10px 18px; }

      /* History */
      .history-intro { 
        font: 700 calc(var(--fs) - 2px)/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; 
        color: var(--subtext); 
        margin: 4px 0 10px; 
      }
      .history-list { list-style: none; padding: 0; margin: 0; }
      .history-item { border: 1px solid var(--border); border-radius: 10px; padding: 10px; margin: 8px 0; background: #fff; }
      .history-title { font-weight: 800; margin-bottom: 4px; }
      .history-desc { font-weight: 600; opacity: .85; margin-bottom: 8px; }
      .history-actions button {
        font: 700 calc(var(--fs) - 2px)/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: transparent; color: var(--accent);
        border: 2px solid var(--accent); border-radius: 8px; padding: 6px 10px; cursor: pointer;
      }

      /* Settings */
      .setting { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; }
      .setting label { font-weight: 800; }
      .setting input[type="checkbox"], .setting select { transform: scale(1.2); }
      .privacy { margin-top: 10px; font-weight: 600; }

      /* Settings theming + chips (visual parity with Figma) */
      .settings-section { margin: 12px 0; }
      .settings-title { font: 900 calc(var(--fs)) /1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin-bottom: 6px; }
      .swatches { display: flex; gap: 10px; }
      .swatch {
        width: 28px; height: 28px; border-radius: 999px; border: 2px solid #ffffff;
        box-shadow: 0 2px 8px rgba(0,0,0,.18); cursor: pointer;
      }
      .swatch[data-theme="violet"] { background: #5b47ff; }
      .swatch[data-theme="orange"] { background: #f97316; }
      .swatch[data-theme="green"]  { background: #16a34a; }
      .swatch[data-theme="cyan"]   { background: #06b6d4; }
      .swatch[data-theme="gradient"] { background: linear-gradient(45deg,#5b47ff,#a855f7,#f97316); }
      .swatch[aria-selected="true"] { outline: 3px solid var(--fg); outline-offset: 2px; }

      .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
      .chip {
        display: inline-flex; align-items: center; gap: 8px;
        background: #fff; border: 1px solid var(--border); border-radius: 999px;
        padding: 6px 10px; box-shadow: 0 2px 6px rgba(0,0,0,.06);
        font: 700 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      .chip button {
        border: none; background: transparent; color: var(--subtext);
        cursor: pointer; font: 900 14px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }

      /* Enabled OFF banner */
      .off-banner {
        background: #fff3cd; color: #5f4b00; border: 1px solid #ffe58f;
        padding: 8px 10px; border-radius: 8px; margin-bottom: 8px; font-weight: 700;
      }
    `;
    shadow.appendChild(style);

    // Additional styles for Guide overlay (breadcrumb, tooltip, controls)
    const guideStyle = document.createElement("style");
    guideStyle.textContent = `
      .guide-breadcrumb {
        position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
        max-width: 90vw; background: var(--bg); color: var(--fg);
        border: 2px solid var(--border); border-radius: 999px;
        box-shadow: var(--shadow); padding: 8px 12px;
        display: none; gap: 6px; align-items: center; pointer-events: auto; z-index: 2;
        font: 800 calc(var(--fs)) /1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      .guide-breadcrumb[open] { display: inline-flex; flex-wrap: wrap; }
      .guide-breadcrumb .crumb { 
        cursor: pointer; 
        color: var(--accent); 
        background: #f4f5ff; 
        border: 1px solid var(--border); 
        border-radius: 999px; 
        padding: 6px 10px; 
      }
      .guide-breadcrumb .crumb[aria-current="step"] { 
        color: var(--accent-contrast); 
        background: var(--accent); 
        border-color: var(--accent);
        cursor: default; 
        text-decoration: none; 
      }
      .guide-breadcrumb .sep { opacity: .6; padding: 0 4px; }

      .guide-tooltip {
        position: fixed; left: 20px; top: 20px;
        max-width: min(420px, 90vw);
        background: var(--bg); color: var(--fg);
        border: 2px solid var(--border); border-radius: 12px;
        box-shadow: var(--shadow); padding: 12px;
        display: none; pointer-events: auto; z-index: 2;
        font: 700 calc(var(--fs)) /1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      .guide-tooltip[open] { display: block; }

      .guide-controls {
        position: fixed; right: 20px; bottom: 160px;
        display: none; gap: 8px; align-items: center; pointer-events: auto; z-index: 2;
      }
      .guide-controls[open] { display: flex; flex-wrap: wrap; }
      .guide-controls .status {
        font: 800 calc(var(--fs)) /1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: #fff3cd; color: #5f4b00; border: 1px solid #ffe58f;
        padding: 6px 10px; border-radius: 8px; margin-right: 6px;
      }
      .guide-controls .btn-lg {
        font: 800 calc(var(--fs)) /1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: var(--accent); color: var(--accent-contrast);
        border: none; border-radius: 12px; padding: 10px 14px; cursor: pointer;
        box-shadow: 0 6px 16px rgba(17,24,39,.18);
      }
      .guide-controls .btn-lg.ghost {
        background: transparent; color: var(--accent); border: 2px solid var(--accent);
      }
      .guide-controls .btn-lg:focus { outline: 3px solid var(--focus); outline-offset: 2px; }
    `;
    shadow.appendChild(guideStyle);

    // Additional styles for AI output (plan rendering and indicators)
    const aiStyle = document.createElement("style");
    aiStyle.textContent = `
      .ai-indicator {
        display: inline-block; margin-left: 8px; font-weight: 800;
      }
      .ai-indicator.ready { color: #2e7d32; }
      .ai-indicator.missing { color: #b71c1c; }

      .ai-plan {
        margin-top: 10px; border: 1px dashed var(--border);
        border-radius: 10px; padding: 10px; background: #fff;
      }
      .ai-plan .plan-title { font-weight: 900; margin-bottom: 6px; }
      .ai-plan .plan-meta { font-weight: 700; opacity: .8; margin-bottom: 8px; }
      .ai-plan ol { margin: 0 0 10px 18px; }
      .ai-plan button {
        font: 800 calc(var(--fs)) /1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: var(--accent); color: var(--accent-contrast);
        border: none; border-radius: 8px; padding: 8px 10px; cursor: pointer;
      }
      .ai-plan button:focus { outline: 3px solid var(--focus); outline-offset: 2px; }
    `;
    shadow.appendChild(aiStyle);

    const fab = document.createElement("button");
    fab.className = "hermes-fab";
    fab.type = "button";
    fab.id = "hermes-fab";
    fab.textContent = "?";
    fab.title = "Open Guide AI";
    fab.setAttribute("aria-label", "Open Guide AI");
    fab.setAttribute("aria-expanded", "false");
    fab.setAttribute("aria-controls", "hermes-panel");

    const panel = document.createElement("div");
    panel.className = "hermes-panel";
    panel.id = "hermes-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", "hermes-title");
    panel.innerHTML = `
      <div class="hermes-header">
        <div id="hermes-title" class="hermes-title">Guide AI</div>
        <div class="header-actions">
          <button class="hermes-gear icon-btn" type="button" aria-label="Open settings" title="Settings">⚙</button>
          <button class="hermes-close icon-btn" type="button" aria-label="Close panel" title="Close">✕</button>
        </div>
      </div>

      <div class="tabs" role="tablist" aria-label="Guide AI Tabs">
        <button class="tab" role="tab" id="tab-ask" aria-selected="true" aria-controls="panel-ask">Ask AI</button>
        <button class="tab" role="tab" id="tab-history" aria-selected="false" aria-controls="panel-history">History</button>
      </div>

      <section id="panel-ask" class="panel" role="tabpanel" tabindex="0" aria-labelledby="tab-ask">
        <div class="off-banner" id="banner-off" hidden>Assistant is turned off. You can enable it in Settings.</div>
        <div id="chat-log" class="chat-log" aria-live="polite" aria-label="Chat messages"></div>
        <div class="chat-input-row">
          <input id="chat-input" type="text" placeholder="Ask where to go…" aria-label="Chat input" />
          <button id="chat-send" type="button" aria-label="Send message">➤</button>
        </div>
      </section>

      <section id="panel-history" class="panel" role="tabpanel" tabindex="0" aria-labelledby="tab-history" hidden>
        <p class="history-intro">Welcome to the history page! Here you can find your recent trails. Select Start to begin.</p>
        <ul id="history-list" class="history-list" aria-label="Saved guides"></ul>
      </section>

      <section id="panel-settings" class="panel" role="tabpanel" tabindex="0" aria-labelledby="tab-settings" hidden>
        <div class="setting">
          <label for="setting-text-size">Text size</label>
          <select id="setting-text-size" aria-label="Text size">
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large" selected>Large</option>
          </select>
        </div>
        <div class="setting">
          <label for="setting-contrast">High-contrast mode</label>
          <input id="setting-contrast" type="checkbox" aria-label="High-contrast mode" checked />
        </div>
        <div class="setting">
          <label for="setting-voice">Voice hints</label>
          <input id="setting-voice" type="checkbox" aria-label="Voice hints" />
        </div>
        <div class="setting">
          <label for="setting-enabled">Turn off assistant (global)</label>
          <input id="setting-enabled" type="checkbox" aria-label="Turn off assistant globally" />
        </div>
        <div class="privacy" role="note" aria-label="Privacy information">
          Privacy: The assistant sees the current page’s layout to help guide you. It does not read passwords or save secure fields. You can turn it off anytime.
        </div>
      </section>
    `;

    shadow.appendChild(fab);
    shadow.appendChild(panel);

    const closeBtn = panel.querySelector(".hermes-close");
    const gearBtn = panel.querySelector(".hermes-gear");

    function openPanel() {
      panel.setAttribute("open", "");
      fab.setAttribute("aria-expanded", "true");
      // Move focus into panel for accessibility
      closeBtn?.focus();
    }
    function closePanel() {
      panel.removeAttribute("open");
      fab.setAttribute("aria-expanded", "false");
      fab.focus();
    }
    function togglePanel() {
      panel.hasAttribute("open") ? closePanel() : openPanel();
    }

    fab.addEventListener("click", togglePanel);
    fab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePanel(); }
    });
    closeBtn?.addEventListener("click", closePanel);
    gearBtn?.addEventListener("click", () => {
      // Open Settings via the gear icon (no Settings tab in the segmented control)
      const ask = shadow.getElementById("panel-ask");
      const hist = shadow.getElementById("panel-history");
      const settings = shadow.getElementById("panel-settings");
      // deselect any current tabs
      tabs.forEach(t => t.setAttribute("aria-selected", "false"));
      if (ask) ask.hidden = true;
      if (hist) hist.hidden = true;
      if (settings) {
        settings.hidden = false;
        settings.focus();
      }
    });

    // Wire global UI controls for messages
    uiControl.open = openPanel;
    uiControl.close = closePanel;
    uiControl.toggle = togglePanel;

    // ===== Settings, Tabs, Chat, and History wiring =====
    const hostEl = shadow.host;
    let renderRestrictedList = () => {};

    // Storage keys
    const SETTINGS_KEY = "hermes_settings";
    const HISTORY_KEY = "hermes_history";

    // Defaults designed for older adults: larger text, high contrast on
    const defaultSettings = {
      textSize: "large",
      highContrast: true,
      voiceHints: false,
      enabled: true,
      theme: "violet",
      micEnabled: false,
      restrictedSites: []
    };
    let settings = { ...defaultSettings };

    // Apply settings to :host attributes and UI
    function applySettings() {
      hostEl.setAttribute("data-text-size", settings.textSize);
      hostEl.setAttribute("data-contrast", settings.highContrast ? "high" : "normal");
      hostEl.setAttribute("data-enabled", settings.enabled ? "on" : "off");
      hostEl.setAttribute("data-theme", settings.theme || "violet");

      // Theme tokens based on selected theme
      applyTheme(settings.theme || "violet");

      // Update FAB symbol (always "?")
      fab.textContent = "?";

      // Banner in Ask tab if disabled or this site is restricted
      const banner = shadow.getElementById("banner-off");
      if (banner) {
        const restricted = isSiteRestricted();
        banner.textContent = (!settings.enabled)
          ? "Assistant is turned off. You can enable it in Settings."
          : (restricted ? "Assistant is turned off on this site. Update Restrictions in Settings." : "");
        banner.hidden = settings.enabled && !restricted;
      }
    }
    function saveSettings() { try { chrome.storage?.local?.set({ [SETTINGS_KEY]: settings }); } catch {} }
    async function loadSettings() {
      try {
        const got = await chrome.storage?.local?.get(SETTINGS_KEY);
        if (got && got[SETTINGS_KEY]) settings = { ...defaultSettings, ...got[SETTINGS_KEY] };
      } catch {}
      applySettings();
      // Reflect in controls
      const sel = shadow.getElementById("setting-text-size");
      const c1 = shadow.getElementById("setting-contrast");
      const c2 = shadow.getElementById("setting-voice");
      const c3 = shadow.getElementById("setting-enabled");
      if (sel) sel.value = settings.textSize;
      if (c1) c1.checked = !!settings.highContrast;
      if (c2) c2.checked = !!settings.voiceHints;
      if (c3) c3.checked = !settings.enabled; // checkbox means "Turn off" -> true when disabled

      // Mirror into Theme & Privacy UI if present
      const mic = shadow.getElementById("setting-mic");
      if (mic) mic.checked = !!settings.micEnabled;
      shadow.querySelectorAll(".swatch").forEach(sw => {
        sw.setAttribute("aria-selected", sw.getAttribute("data-theme") === (settings.theme || "violet") ? "true" : "false");
      });
      renderRestrictedList();
    }

    // Helpers
    function isSiteRestricted() {
      try {
        const origin = location.origin;
        const sites = Array.isArray(settings.restrictedSites) ? settings.restrictedSites : [];
        return sites.some(s => {
          const t = (s || "").toString().trim();
          if (!t) return false;
          // treat entries as host or substring match
          return origin.includes(t) || location.hostname.includes(t);
        });
      } catch { return false; }
    }
    function canRunAssistant() {
      return !!settings.enabled && !isSiteRestricted();
    }
    function applyTheme(name) {
      const t = (name || "violet").toLowerCase();
      let acc = "#5b47ff";
      let grad = "linear-gradient(45deg, #5b47ff, #a855f7, #f97316)";
      if (t === "orange") { acc = "#f97316"; grad = "linear-gradient(45deg,#fb923c,#f97316,#f59e0b)"; }
      if (t === "green")  { acc = "#16a34a"; grad = "linear-gradient(45deg,#34d399,#16a34a,#22c55e)"; }
      if (t === "cyan")   { acc = "#06b6d4"; grad = "linear-gradient(45deg,#67e8f9,#06b6d4,#22d3ee)"; }
      if (t === "gradient") { acc = "#5b47ff"; grad = "linear-gradient(45deg, #5b47ff, #a855f7, #f97316)"; }
      hostEl.style.setProperty("--accent", acc);
      hostEl.style.setProperty("--header-gradient", grad);
    }

    // Tabs
    const tabs = Array.from(shadow.querySelectorAll('[role="tab"]'));
    const panels = Array.from(shadow.querySelectorAll('[role="tabpanel"]'));
    function activateTab(tabId) {
      // Hide all panels first (Ask, History, Settings, etc.)
      panels.forEach(p => { p.hidden = true; });

      for (const t of tabs) {
        const sel = t.id === tabId;
        t.setAttribute("aria-selected", sel ? "true" : "false");
        const pid = t.getAttribute("aria-controls");
        const panelEl = pid ? shadow.getElementById(pid) : null;
        if (panelEl && sel) panelEl.hidden = false;
      }
      // Move focus to active panel for screen readers
      const active = tabs.find(t => t.id === tabId);
      const pid = active?.getAttribute("aria-controls");
      const panelEl = pid ? shadow.getElementById(pid) : null;
      panelEl?.focus();
    }
    tabs.forEach(t => {
      t.addEventListener("click", () => activateTab(t.id));
      t.addEventListener("keydown", (e) => {
        const i = tabs.indexOf(t);
        if (e.key === "ArrowRight") { e.preventDefault(); tabs[(i + 1) % tabs.length].focus(); }
        if (e.key === "ArrowLeft") { e.preventDefault(); tabs[(i - 1 + tabs.length) % tabs.length].focus(); }
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activateTab(t.id); }
      });
    });

    // Chat (mocked, rule-based)
    const chatLog = shadow.getElementById("chat-log");
    const chatInput = shadow.getElementById("chat-input");
    const chatSend = shadow.getElementById("chat-send");

    function formatTime(d) {
      try { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
    }

    let typingRow = null;
    function showTypingIndicator() {
      if (!chatLog) return;
      typingRow = document.createElement("div");
      typingRow.className = "msg bot";
      typingRow.innerHTML = `<div class="bubble"><span class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>`;
      chatLog.appendChild(typingRow);
      chatLog.scrollTo({ top: chatLog.scrollHeight });
    }
    function hideTypingIndicator() {
      if (typingRow) { typingRow.remove(); typingRow = null; }
    }

    function appendMsg(role, text) {
      const row = document.createElement("div");
      row.className = `msg ${role}`;
      const safe = String(text || "");
      row.innerHTML = `<div class="bubble">${safe}</div><div class="timestamp">${formatTime(new Date())}</div>`;
      chatLog?.appendChild(row);
      chatLog?.scrollTo({ top: chatLog.scrollHeight });
    }

    function escapeHTML(s) {
      const div = document.createElement("div");
      div.textContent = s == null ? "" : String(s);
      return div.innerHTML;
    }

    function appendBotRich(html) {
      const row = document.createElement("div");
      row.className = "msg bot";
      row.innerHTML = `<div class="bubble">${html || ""}</div><div class="timestamp">${formatTime(new Date())}</div>`;
      chatLog?.appendChild(row);
      chatLog?.scrollTo({ top: chatLog.scrollHeight });
    }

    function speak(text) {
      try {
        if (settings.voiceHints && "speechSynthesis" in window) {
          const u = new SpeechSynthesisUtterance(text);
          u.rate = 0.9; u.pitch = 1.0;
          speechSynthesis.speak(u);
        }
      } catch {}
    }

    function botReply(userText) {
      const t = (userText || "").toLowerCase();
      let reply =
        "I can guide common tasks. Try: “Find my test results” or “Download my benefits letter”.";
      if (/test result|results|lab/i.test(t)) {
        reply = "Step 1: Look for “Results” or “Test Results” at the top of the page. Step 2: Open your latest result. Step 3: Choose “Download PDF”.";
      } else if (/benefit|letter|proof/i.test(t)) {
        reply = "Go to “Benefits”, then “Letters”. Look for “Download” or “Save as PDF”.";
      } else if (/history/i.test(t)) {
        reply = "Open the History tab to replay a saved guide.";
      } else if (/setting|contrast|text|voice/i.test(t)) {
        reply = "Open Settings to adjust text size, high-contrast mode, or voice hints.";
      }
      appendMsg("bot", reply);
      speak(reply);
    }

    let aiHasKey = false;

    function onSend() {
      if (!canRunAssistant()) {
        appendMsg("bot", "Assistant is turned off for this site. Update Settings to run guides.");
        return;
      }
      const v = chatInput.value.trim();
      if (!v) return;
      appendMsg("user", v);
      chatInput.value = "";
      if (aiHasKey) {
        sendAi(v);
      } else {
        setTimeout(() => botReply(v), 200);
      }
    }
    chatSend?.addEventListener("click", onSend);
    chatInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); onSend(); }
    });

    // Settings controls wiring
    shadow.getElementById("setting-text-size")?.addEventListener("change", (e) => {
      settings.textSize = e.target.value;
      applySettings(); saveSettings();
    });

    // Theme + Privacy (visual parity; immediate-save UX)
    function setupThemeAndPrivacy() {
      const settingsPanel = shadow.getElementById("panel-settings");
      if (!settingsPanel) return;

      const wrap = document.createElement("div");
      wrap.className = "settings-section";
      wrap.innerHTML = `
        <div class="settings-section">
          <div class="settings-title">Theme</div>
          <div class="swatches" id="theme-swatches" role="radiogroup" aria-label="Theme">
            <button class="swatch" role="radio" aria-label="Violet" data-theme="violet" aria-selected="false"></button>
            <button class="swatch" role="radio" aria-label="Orange" data-theme="orange" aria-selected="false"></button>
            <button class="swatch" role="radio" aria-label="Green" data-theme="green" aria-selected="false"></button>
            <button class="swatch" role="radio" aria-label="Cyan" data-theme="cyan" aria-selected="false"></button>
            <button class="swatch" role="radio" aria-label="Gradient" data-theme="gradient" aria-selected="false"></button>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-title">Privacy & Restrictions</div>
          <div class="setting" style="justify-content: flex-start; gap: 12px;">
            <label for="setting-mic" style="min-width:200px;">Enable Microphone Access</label>
            <input id="setting-mic" type="checkbox" aria-label="Enable Microphone Access" />
          </div>
          <div style="border:1px solid var(--border); border-radius:10px; padding:10px; background:#fff;">
            <div style="display:flex; align-items:center; gap:8px; font-weight:800; margin-bottom:8px;">
              <span aria-hidden="true">ⓘ</span> Restricted Websites List
            </div>
            <div style="display:flex; gap:8px; margin-bottom:8px;">
              <input id="restrict-input" placeholder="www.example.com" style="flex:1; padding:8px 10px; border:1px solid var(--border); border-radius:8px;" />
              <button id="restrict-add" type="button" style="background:var(--accent); color:var(--accent-contrast); border:none; border-radius:8px; padding:8px 10px;">Add</button>
            </div>
            <div id="restrict-list" class="chips" aria-live="polite"></div>
          </div>
        </div>

        <div style="margin-top:12px;">
          <button id="settings-save" type="button" style="width:100%; background: var(--accent); color: var(--accent-contrast); border:none; border-radius:12px; padding:12px; font:800 var(--fs)/1.2 system-ui;">Save Changes</button>
        </div>
      `;
      settingsPanel.appendChild(wrap);

      // Swatches
      wrap.querySelectorAll(".swatch").forEach(btn => {
        btn.addEventListener("click", () => {
          settings.theme = btn.getAttribute("data-theme") || "violet";
          wrap.querySelectorAll(".swatch").forEach(sw => sw.setAttribute("aria-selected", sw === btn ? "true" : "false"));
          applySettings(); saveSettings();
        });
      });

      // Mic toggle (visual only for now)
      wrap.querySelector("#setting-mic")?.addEventListener("change", (e) => {
        settings.micEnabled = !!e.target.checked;
        saveSettings();
      });

      const listEl = wrap.querySelector("#restrict-list");
      const inputEl = wrap.querySelector("#restrict-input");

      renderRestrictedList = function() {
        if (!listEl) return;
        listEl.innerHTML = "";
        const items = Array.isArray(settings.restrictedSites) ? settings.restrictedSites : [];
        for (const site of items) {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.innerHTML = `<span>${site}</span><button type="button" aria-label="Remove ${site}">✕</button>`;
          chip.querySelector("button")?.addEventListener("click", () => {
            settings.restrictedSites = items.filter(s => s !== site);
            saveSettings(); applySettings(); renderRestrictedList();
          });
          listEl.appendChild(chip);
        }
      };

      wrap.querySelector("#restrict-add")?.addEventListener("click", () => {
        const v = (inputEl?.value || "").trim();
        if (!v) return;
        const arr = Array.isArray(settings.restrictedSites) ? settings.restrictedSites.slice() : [];
        if (!arr.includes(v)) arr.push(v);
        settings.restrictedSites = arr;
        inputEl.value = "";
        saveSettings(); applySettings(); renderRestrictedList();
      });

      wrap.querySelector("#settings-save")?.addEventListener("click", () => {
        saveSettings();
        toast("Settings saved");
      });
    }

    // Inject AI settings UI into Settings panel
    (function setupAiSettings() {
      const settingsPanel = shadow.getElementById("panel-settings");
      if (!settingsPanel) return;
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <hr style="margin: 10px 0; border: none; border-top: 1px solid var(--border);" />
        <div class="setting">
          <label for="setting-openai-key">OpenAI API key</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="setting-openai-key" type="password" placeholder="sk-..." style="min-width: 180px;" />
            <button id="setting-save-key" type="button">Save Key</button>
            <span id="ai-ready-indicator" class="ai-indicator">Checking…</span>
          </div>
        </div>
      `;
      settingsPanel.appendChild(wrap);

      async function updateAiIndicator() {
        const ind = shadow.getElementById("ai-ready-indicator");
        if (!ind) return;
        ind.textContent = aiHasKey ? "AI is ready" : "AI not configured";
        ind.classList.toggle("ready", !!aiHasKey);
        ind.classList.toggle("missing", !aiHasKey);
      }

      async function checkAiReady() {
        try {
          const res = await chrome.runtime.sendMessage({ type: "HERMES_AI_HAS_KEY" });
          aiHasKey = !!res?.hasKey;
        } catch { aiHasKey = false; }
        updateAiIndicator();
      }

      shadow.getElementById("setting-save-key")?.addEventListener("click", async () => {
        const inp = shadow.getElementById("setting-openai-key");
        const key = (inp?.value || "").trim();
        try {
          await chrome.runtime.sendMessage({ type: "HERMES_AI_SET_KEY", key });
          aiHasKey = !!key;
          updateAiIndicator();
          if (key) toast("OpenAI API key saved.");
          if (inp) inp.value = "";
        } catch (e) {
          toast("Failed to save API key");
        }
      });

      // initial check
      checkAiReady();
    })();
    shadow.getElementById("setting-contrast")?.addEventListener("change", (e) => {
      settings.highContrast = !!e.target.checked;
      applySettings(); saveSettings();
    });
    shadow.getElementById("setting-voice")?.addEventListener("change", (e) => {
      settings.voiceHints = !!e.target.checked;
      saveSettings();
    });
    shadow.getElementById("setting-enabled")?.addEventListener("change", (e) => {
      // Checkbox label: "Turn off assistant" -> checked means disabled
      const disabled = !!e.target.checked;
      settings.enabled = !disabled;
      applySettings(); saveSettings();
    });

    // Simple AI call using background service worker
    async function sendAi(userText) {
      // Build lightweight page context
      const ctx = {
        url: location.href,
        title: document.title,
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 30).map(n => (n.textContent || "").trim()).filter(Boolean),
        navLinks: Array.from(document.querySelectorAll("a[href]")).filter(a => isVisible(a)).slice(0, 50).map(a => (a.innerText || a.textContent || "").trim()).filter(Boolean),
        buttons: Array.from(document.querySelectorAll("button,[role=button],input[type=button],input[type=submit]")).filter(b => isVisible(b)).slice(0, 50).map(b => (b.innerText || b.value || "").trim()).filter(Boolean),
      };
      // Typing indicator while we call the model
      showTypingIndicator();
      try {
        const res = await chrome.runtime.sendMessage({ type: "HERMES_AI_ASK", userText, context: ctx });
        if (!res?.ok) {
          appendMsg("bot", res?.error || "AI request failed.");
          return;
        }
        hideTypingIndicator();
        const content = res.content || "";
        const { message, plan } = splitAiContent(content);
        // Build a neatly formatted bot response (instructions inside the chat bubble)
        let rich = "";
        if (message && message.trim().length) {
          rich += `<div class="text">${escapeHTML(message.trim())}</div>`;
        }
        if (plan && Array.isArray(plan.steps) && plan.steps.length) {
          const steps = plan.steps.map((s, i) => `<li>${escapeHTML(s.instruction || `Step ${i + 1}`)}</li>`).join("");
          const goal = escapeHTML(plan.goal || "Proposed steps");
          rich += `<div class="card"><div class="title">${goal}</div><ol>${steps}</ol></div>`;
        }
        if (!rich) {
          rich = `<div class="text">${escapeHTML("I created steps for you below.")}</div>`;
        }
        appendBotRich(rich);
        if (plan) {
          renderPlan(plan);
        }
      } catch (e) {
        appendMsg("bot", "Network error. Please try again.");
      }
    }

    function extractJsonPlan(text) {
      try {
        const m = text.match(/```json([\s\S]*?)```/i);
        if (!m) return null;
        const obj = JSON.parse(m[1]);
        // Basic shape check
        if (!obj || typeof obj !== "object" || !Array.isArray(obj.steps)) return null;
        return obj;
      } catch {
        return null;
      }
    }

    // Split AI content into a human-friendly message and an optional JSON plan
    function splitAiContent(text) {
      if (!text) return { message: "", plan: null };
      const plan = extractJsonPlan(text);
      // Remove fenced json code blocks from the visible message
      const message = text.replace(/```json[\s\S]*?```/gi, "").trim();
      return { message, plan };
    }

    function renderPlan(plan) {
      // Minimal run button (do not repeat instructions here)
      const container = document.createElement("div");
      container.className = "ai-plan";
      container.innerHTML = `
        <button type="button" id="ai-plan-run">Begin Guide</button>
      `;
      panel.querySelector("#panel-ask")?.appendChild(container);
      container.querySelector("#ai-plan-run")?.addEventListener("click", () => {
        createDynamicGuideFromPlan(plan);
        uiControl.close();
      });
    }
    // History: seed demo guides and render
    const defaultHistory = [
      { id: "demo-1", name: "Find and download your latest test result", description: "Results → Latest → Download PDF.", updatedAt: Date.now() },
      { id: "demo-2", name: "Download a benefits letter", description: "Benefits → Letters → Download.", updatedAt: Date.now() }
    ];
    async function loadHistoryAndRender() {
      let items = [];
      try {
        const got = await chrome.storage?.local?.get(HISTORY_KEY);
        if (got && Array.isArray(got[HISTORY_KEY])) items = got[HISTORY_KEY];
      } catch {}
      if (!items.length) {
        items = defaultHistory;
        try { await chrome.storage?.local?.set({ [HISTORY_KEY]: items }); } catch {}
      }
      renderHistory(items);
    }
    function renderHistory(items) {
      const ul = shadow.getElementById("history-list");
      if (!ul) return;
      ul.innerHTML = "";
      for (const it of items) {
        const li = document.createElement("li");
        li.className = "history-item";
        li.innerHTML = `
          <div class="history-title">${it.name}</div>
          <div class="history-desc">${it.description}</div>
          <div class="history-actions">
            <button type="button" data-id="${it.id}">Start Guide</button>
          </div>
        `;
        ul.appendChild(li);
      }
      ul.querySelectorAll("button[data-id]").forEach(btn => {
        btn.addEventListener("click", (e) => {
          const id = e.currentTarget.getAttribute("data-id");
          if (!settings.enabled) {
            appendMsg("bot", "Assistant is turned off. Enable it in Settings to run guides.");
            activateTab("tab-ask");
            return;
          }
          activateTab("tab-ask");
          speak("Starting guide");
          startGuide(id);
        });
      });

      // Start New Chat button like Figma
      const newChat = document.createElement("div");
      newChat.style.marginTop = "12px";
      newChat.innerHTML = `<button type="button" id="start-new-chat" style="
        width:100%; background: var(--accent); color: var(--accent-contrast);
        border:none; border-radius:12px; padding:12px; font:800 var(--fs)/1.2 system-ui;">Start New Chat</button>`;
      ul.parentElement?.appendChild(newChat);
      newChat.querySelector("#start-new-chat")?.addEventListener("click", () => {
        activateTab("tab-ask");
        chatInput?.focus();
      });
    }

    // Initial tab and data load
    activateTab("tab-ask");
    setupThemeAndPrivacy();
    loadSettings();
    loadHistoryAndRender();

    // ===== Guide Engine (overlay + breadcrumb + navigation) =====
    const RUN_KEY = "hermes_running_guide";
    const DYNAMIC_AI_KEY = "hermes_dynamic_ai_guide";
    let guides = {
      "demo-1": {
        name: "Find and download your latest test result",
        steps: [
          { selector: "#nav-results", instruction: "Click on “Results” at the top of the page.", breadcrumb: "Results", urlIncludes: "index.html", scroll: true },
          { selector: "#latest-result .ghost", instruction: "Open your latest result.", breadcrumb: "Open latest", urlIncludes: "results.html", scroll: true },
          { selector: "#download-pdf", instruction: "Click “Download PDF”.", breadcrumb: "Download PDF", urlIncludes: "results.html", scroll: true }
        ]
      },
      "demo-2": {
        name: "Download a benefits letter",
        steps: [
          { selector: "#nav-benefits", instruction: "Open “Benefits”. (Demo placeholder)", breadcrumb: "Benefits" }
        ]
      }
    };

    let breadcrumbEl = null;
    let tooltipEl = null;
    let controlsEl = null;
    let tooltipUpdater = null;

    function ensureGuideUI() {
      if (!breadcrumbEl) {
        breadcrumbEl = document.createElement("div");
        breadcrumbEl.className = "guide-breadcrumb";
        breadcrumbEl.setAttribute("role", "navigation");
        breadcrumbEl.setAttribute("aria-label", "Guide breadcrumb");
        shadow.appendChild(breadcrumbEl);
      }
      if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.className = "guide-tooltip";
        tooltipEl.setAttribute("role", "status");
        tooltipEl.setAttribute("aria-live", "polite");
        shadow.appendChild(tooltipEl);
      }
      if (!controlsEl) {
        controlsEl = document.createElement("div");
        controlsEl.className = "guide-controls";
        controlsEl.innerHTML = `
          <span class="status" id="guide-status">Step 1 of 1</span>
          <button type="button" class="btn-lg ghost" id="guide-back" aria-label="Back step">Back</button>
          <button type="button" class="btn-lg" id="guide-play" aria-label="Play step">Play</button>
          <button type="button" class="btn-lg" id="guide-next" aria-label="Next step">Next</button>
          <button type="button" class="btn-lg ghost" id="guide-exit" aria-label="Exit guide">Exit</button>
        `;
        shadow.appendChild(controlsEl);
        shadow.getElementById("guide-back")?.addEventListener("click", prevStep);
        shadow.getElementById("guide-play")?.addEventListener("click", markCurrentStep);
        shadow.getElementById("guide-next")?.addEventListener("click", nextStep);
        shadow.getElementById("guide-exit")?.addEventListener("click", stopGuide);
      }
    }

    const guideState = { id: null, index: 0, running: false };

    // Auto-reassess and auto-advance support

    function elementForStep(step) {
      if (!step) return null;
      try {
        if (step.selector) {
          const el = document.querySelector(step.selector);
          if (el && isVisible(el)) return el;
        }
      } catch {}
      if (step.textHint) {
        try {
          const el = findByVisibleText(step.textHint, document);
          if (el && isVisible(el)) return el;
        } catch {}
      }
      return null;
    }


    // Auto Back if we detect the previous step's page/target is active





    // Redirect-planning (throttled) when we cannot auto-redirect with a click




    function setUIVisibility(on) {
      if (!breadcrumbEl || !tooltipEl || !controlsEl) return;
      breadcrumbEl.toggleAttribute("open", !!on);
      tooltipEl.toggleAttribute("open", !!on);
      controlsEl.toggleAttribute("open", !!on);
    }

    function renderBreadcrumb() {
      const g = guides[guideState.id];
      if (!g || !breadcrumbEl) return;
      const upto = guideState.index;
      breadcrumbEl.innerHTML = "";
      for (let i = 0; i <= upto; i++) {
        const step = g.steps[i];
        const b = document.createElement("button");
        b.type = "button";
        b.className = "crumb";
        b.textContent = step.breadcrumb || `Step ${i + 1}`;
        if (i === upto) b.setAttribute("aria-current", "step");
        b.addEventListener("click", () => setStep(i));
        breadcrumbEl.appendChild(b);
        if (i < upto) {
          const sep = document.createElement("span");
          sep.className = "sep";
          sep.textContent = "→";
          breadcrumbEl.appendChild(sep);
        }
      }
    }

    function placeTooltipFor(el, text) {
      if (!tooltipEl) return;
      tooltipEl.textContent = text || "";
      let lastEl = el;
      const update = () => {
        if (!tooltipEl) return;
        let left = 20, top = 20;
        if (lastEl && lastEl.getBoundingClientRect) {
          const r = rectOf(lastEl);
          const maxW = Math.min(420, window.innerWidth - 40);
          left = Math.min(Math.max(r.left, 12), window.innerWidth - maxW - 12);
          top = Math.min(r.top + r.height + 10, window.innerHeight - 80);
          tooltipEl.style.maxWidth = `${maxW}px`;
        }
        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.top = `${top}px`;
      };
      update();
      if (tooltipUpdater) {
        window.removeEventListener("scroll", tooltipUpdater, { capture: false });
        window.removeEventListener("resize", tooltipUpdater, { capture: false });
      }
      tooltipUpdater = () => update();
      window.addEventListener("scroll", tooltipUpdater, { passive: true });
      window.addEventListener("resize", tooltipUpdater, { passive: true });
    }

    function setStatus(text) {
      const st = shadow.getElementById("guide-status");
      if (st) st.textContent = text;
    }

    async function saveRun() {
      try { await chrome.storage?.local?.set({ [RUN_KEY]: { id: guideState.id, index: guideState.index } }); } catch {}
    }

    async function clearRun() {
      try { await chrome.storage?.local?.remove(RUN_KEY); } catch {}
    }

    function setStep(i) {
      const g = guides[guideState.id];
      if (!g) return;
      guideState.index = Math.max(0, Math.min(i, g.steps.length - 1));
      showCurrentStep();
    }

    function showCurrentStep() {
      const g = guides[guideState.id];
      if (!g) return;
      const i = guideState.index;
      const step = g.steps[i];
      renderBreadcrumb();
      setStatus(`Step ${i + 1} of ${g.steps.length}: ${step.instruction}`);
      clearHighlights();
      tooltipEl?.removeAttribute("open");
      saveRun();
    }

    // Mark current step: highlights target and speaks instruction only when user presses Play
    function markCurrentStep() {
      const g = guides[guideState.id];
      if (!g) return;
      const i = guideState.index;
      const step = g.steps[i];
      clearHighlights();

      let target = null;
      try {
        if (step.selector) target = document.querySelector(step.selector);
      } catch {}
      if (!target && step.textHint) {
        try { target = findByVisibleText(step.textHint, document); } catch {}
      }

      if (target && isVisible(target)) {
        if (step.scroll) target.scrollIntoView({ behavior: "smooth", block: "center" });
        drawRingAround(target, { label: "", circle: false, ttlMs: 600000 });
        placeTooltipFor(target, step.instruction);
        tooltipEl?.setAttribute("open", "");
      } else {
        // Fallback: show tooltip near top-left with instruction
        placeTooltipFor(null, step.instruction);
        tooltipEl?.setAttribute("open", "");
      }

      if (settings.voiceHints) speak(step.instruction);
    }

    function nextStep() {
      const g = guides[guideState.id];
      if (!g) return;
      if (guideState.index + 1 < g.steps.length) {
        guideState.index += 1;
        showCurrentStep();
      } else {
        const last = g.steps[g.steps.length - 1];
        if (last?.urlIncludes && location.href.includes(last.urlIncludes)) {
          appendMsg("bot", "Arrived at destination. Guide ended.");
          toast("Arrived at destination.");
        } else {
          appendMsg("bot", "Guide complete.");
        }
        stopGuide();
      }
    }

    function prevStep() {
      if (guideState.index > 0) {
        guideState.index -= 1;
        showCurrentStep();
      }
    }

    function stopGuide() {
      guideState.id = null;
      guideState.index = 0;
      guideState.running = false;
      setUIVisibility(false);
      clearHighlights();
      clearRun();
    }

    let dynamicGuideSteps = null;

    function startGuide(id) {
      if (!guides[id]) {
        appendMsg("bot", "Guide not found in this prototype.");
        return;
      }
      if (!canRunAssistant()) {
        appendMsg("bot", "Assistant is turned off for this site. Update Settings to continue.");
        return;
      }
      ensureGuideUI();
      guideState.id = id;
      guideState.index = 0;
      guideState.running = true;
      setUIVisibility(true);
      // Close the panel to reveal the page when a guide starts
      uiControl.close();
      // Persist dynamic AI guide steps if needed
      if (id === "ai-plan" && Array.isArray(dynamicGuideSteps) && dynamicGuideSteps.length) {
        try { chrome.storage?.local?.set({ [DYNAMIC_AI_KEY]: dynamicGuideSteps }); } catch {}
      }
      showCurrentStep();
    }

    async function resumeRunningGuide() {
      try {
        const got = await chrome.storage?.local?.get(RUN_KEY);
        const run = got ? got[RUN_KEY] : null;
        if (run && run.id) {
          // If resuming AI dynamic guide, reconstruct it
          if (run.id === "ai-plan" && !guides["ai-plan"]) {
            try {
              const dyn = await chrome.storage?.local?.get(DYNAMIC_AI_KEY);
              const steps = dyn?.[DYNAMIC_AI_KEY];
              if (Array.isArray(steps) && steps.length) {
                guides["ai-plan"] = { name: "AI Plan", steps };
              }
            } catch {}
          }
          if (guides[run.id]) {
            ensureGuideUI();
            guideState.id = run.id;
            guideState.index = run.index || 0;
            guideState.running = true;
            setUIVisibility(true);
            // Close the panel if resuming a running guide so the page is visible
            uiControl.close();
            showCurrentStep();
          }
        }
      } catch {}
    }

    // Resume if a guide was active on previous page (e.g., after navigating to Results)
    resumeRunningGuide();

    function createDynamicGuideFromPlan(plan) {
      const steps = [];
      for (const s of plan.steps || []) {
        const instruction = s.instruction || "Follow this step";
        const hint = s.selector_hint || "";
        // Heuristic: treat #,.,[ as CSS selectors, otherwise as visible text hint
        if (/^[#.\[]/.test(hint) || /\s/.test("") ) {
          steps.push({ selector: hint, instruction, breadcrumb: instruction.split(".")[0] || "Step", scroll: true, urlIncludes: s.urlIncludes });
        } else if (hint) {
          steps.push({ textHint: hint, instruction, breadcrumb: instruction.split(".")[0] || "Step", scroll: true, urlIncludes: s.urlIncludes });
        } else {
          steps.push({ instruction, breadcrumb: instruction.split(".")[0] || "Step", scroll: true, urlIncludes: s.urlIncludes });
        }
      }
      dynamicGuideSteps = steps;
      guides["ai-plan"] = { name: plan.goal || "AI Plan", steps };
      startGuide("ai-plan");
    }

    shadow.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel.hasAttribute("open")) {
        e.preventDefault();
        closePanel();
      }
      if (guideState.running) {
        if (e.key === "ArrowRight") { e.preventDefault(); nextStep(); }
        if (e.key === "ArrowLeft") { e.preventDefault(); prevStep(); }
      }
    });
  }

  document.addEventListener("DOMContentLoaded", initAssistantUI);
  if (document.readyState === "complete" || document.readyState === "interactive") initAssistantUI();

  })();
