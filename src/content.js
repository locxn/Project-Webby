// ===== Project Hermes Content Script (No-build) =====
(() => {
    const MSG = {
      PING: "HERMES_PING",
      HIGHLIGHT_SIGN_IN: "HERMES_HIGHLIGHT_SIGN_IN",
      HIGHLIGHT_BY_TEXT: "HERMES_HIGHLIGHT_BY_TEXT",
      CLEAR_HIGHLIGHTS: "HERMES_CLEAR_HIGHLIGHTS"
    };
  
    const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const rectOf = (el) => { try { return el.getBoundingClientRect(); } catch { return { left:0, top:0, width:0, height:0 }; } };
    const isVisible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
      const r = rectOf(el);
      return r.width > 0 && r.height > 0;
    };
    //Test
  
    let overlayRoot = null;
    function ensureOverlayRoot() {
      if (!overlayRoot) {
        overlayRoot = document.getElementById("__hermes_overlay_root");
        if (!overlayRoot) {
          overlayRoot = document.createElement("div");
          overlayRoot.id = "__hermes_overlay_root";
          overlayRoot.setAttribute("role", "presentation");
          Object.assign(overlayRoot.style, { position: "fixed", inset: "0", zIndex: 2147483647, pointerEvents: "none" });
          document.documentElement.appendChild(overlayRoot);
        }
      }
      return overlayRoot;
    }
  
    const SIGNIN_KWS = ["sign in","signin","log in","login","log-in","sign-in"];
  
    function allCandidateButtons(root = document) {
      const selectors = ["button","[role=button]","input[type=button]","input[type=submit]","a[role=button]","a[href]"];
      return Array.from(root.querySelectorAll(selectors.join(","))).filter(isVisible);
    }
  
    function scoreByKeywords(el, keywords) {
      const pieces = [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.value].map(normalize).filter(Boolean);
      const joined = pieces.join(" | ");
      let score = 0;
      for (const kw of keywords) if (joined.includes(kw)) score += 10;
      const idClass = (el.id + " " + (el.className || "")).toLowerCase();
      if (/signin|login/.test(idClass)) score += 3;
      const rect = el.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 20) score += 1.5;
      if (["BUTTON","INPUT"].includes(el.tagName)) score += 1;
      return score;
    }
  
    function findBestSignIn(root = document) {
      const candidates = allCandidateButtons(root);
      let best = null, bestScore = -1;
      for (const el of candidates) {
        const s = scoreByKeywords(el, SIGNIN_KWS);
        if (s > bestScore) { best = el; bestScore = s; }
      }
      return bestScore >= 10 ? best : null;
    }
  
    function findByVisibleText(txt, root = document) {
      const target = normalize(txt);
      const candidates = allCandidateButtons(root);
      let best = null, bestScore = -1;
      for (const el of candidates) {
        const s = scoreByKeywords(el, [target]);
        if (s > bestScore) { best = el; bestScore = s; }
      }
      return bestScore >= 8 ? best : null;
    }
  
    function* walkShadowHosts(root = document) {
      const it = document.createNodeIterator(root, NodeFilter.SHOW_ELEMENT);
      let n; while ((n = it.nextNode())) if (n.shadowRoot) yield n.shadowRoot;
    }
    function searchEverywhere(fn) {
      const topHit = fn(document);
      if (topHit) return topHit;
      for (const sr of walkShadowHosts(document)) { const inside = fn(sr); if (inside) return inside; }
      return null;
    }
  
    const rings = new Set();
    function drawRingAround(el, { label = null, pad = 8, circle = true, ttlMs = 10000 } = {}) {
      const root = ensureOverlayRoot();
      const r = rectOf(el);
      const ring = document.createElement("div");
      ring.className = "__hermes_ring";
      Object.assign(ring.style, {
        position: "absolute", left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
        border: "3px solid #ff3b30", boxShadow: "0 0 12px rgba(0,0,0,.35)", background: "rgba(255,59,48,0.08)", borderRadius: circle ? "9999px" : "12px", pointerEvents: "none"
      });
      root.appendChild(ring); rings.add(ring);
  
      let labelEl = null;
      if (label) {
        labelEl = document.createElement("div");
        labelEl.className = "__hermes_label";
        labelEl.textContent = label;
        Object.assign(labelEl.style, {
          position: "absolute", left: `${r.left - pad}px`, top: `${r.top + r.height + pad}px`,
          font: "600 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: "#111", background: "#fff",
          border: "1px solid rgba(0,0,0,.12)", borderRadius: "8px", padding: "4px 8px", boxShadow: "0 2px 8px rgba(0,0,0,.12)", pointerEvents: "none"
        });
        root.appendChild(labelEl); rings.add(labelEl);
      }
  
      const update = () => {
        const rr = rectOf(el);
        ring.style.left = `${rr.left - pad}px`;
        ring.style.top = `${rr.top - pad}px`;
        ring.style.width = `${rr.width + pad * 2}px`;
        ring.style.height = `${rr.height + pad * 2}px`;
        if (labelEl) { labelEl.style.left = `${rr.left - pad}px`; labelEl.style.top = `${rr.top + rr.height + pad}px`; }
      };
      const ro = new ResizeObserver(update); ro.observe(el);
      const onScroll = () => update();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
  
      setTimeout(() => {
        ro.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
        ring.remove(); labelEl?.remove(); rings.delete(ring); rings.delete(labelEl);
      }, ttlMs);
    }
  
    function clearHighlights() { for (const n of rings) n?.remove(); rings.clear(); }
  
    function toast(msg) {
      const root = ensureOverlayRoot();
      const t = document.createElement("div");
      Object.assign(t.style, {
        position: "fixed", left: "16px", bottom: "16px",
        font: "600 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        color: "#111", background: "#fff", border: "1px solid rgba(0,0,0,.12)", borderRadius: "8px",
        padding: "6px 10px", boxShadow: "0 2px 8px rgba(0,0,0,.12)", pointerEvents: "none", zIndex: 2147483647
      });
      t.textContent = msg; root.appendChild(t); setTimeout(() => t.remove(), 3000);
    }
  
    function highlightSignIn() {
      const el = searchEverywhere(findBestSignIn) || findBestSignIn(document);
      if (!el) return toast("Couldn’t find a Sign in button on this page.");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      drawRingAround(el, { label: "Sign in", circle: true });
    }
  
    function highlightByText(text) {
      const el = searchEverywhere((root) => findByVisibleText(text, root)) || findByVisibleText(text, document);
      if (!el) return toast(`Couldn’t find “${text}”.`);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      drawRingAround(el, { label: `“${text}”`, circle: true });
    }
  
    chrome.runtime.onMessage.addListener((message) => {
      switch (message?.type) {
        case MSG.HIGHLIGHT_SIGN_IN: return void highlightSignIn();
        case MSG.HIGHLIGHT_BY_TEXT: return void highlightByText(message?.text || "");
        case MSG.CLEAR_HIGHLIGHTS: return void clearHighlights();
        default: break;
      }
    });
  })();
  