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
      CLEAR_HIGHLIGHTS: "HERMES_CLEAR_HIGHLIGHTS"     // Command to clear all highlights
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
        border: "3px solid #ff3b30", 
        boxShadow: "0 0 12px rgba(0,0,0,.35)", 
        background: "rgba(255,59,48,0.08)", 
        borderRadius: circle ? "9999px" : "12px", 
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
        default: 
          break;
      }
    });
  })();