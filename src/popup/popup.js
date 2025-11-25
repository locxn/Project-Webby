const MSG = {
    HIGHLIGHT_SIGN_IN: "HERMES_HIGHLIGHT_SIGN_IN",
    HIGHLIGHT_BY_TEXT: "HERMES_HIGHLIGHT_BY_TEXT",
    CLEAR_HIGHLIGHTS: "HERMES_CLEAR_HIGHLIGHTS",
    OPEN_PANEL: "HERMES_OPEN_PANEL",
    TOGGLE_PANEL: "HERMES_TOGGLE_PANEL",
    AI_HAS_KEY: "HERMES_AI_HAS_KEY"
  };
  async function sendToActiveTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, message);
  }
  document.getElementById("btn-signin").addEventListener("click", () => sendToActiveTab({ type: MSG.HIGHLIGHT_SIGN_IN }));
  document.getElementById("btn-by-text").addEventListener("click", () => {
    const text = document.getElementById("by-text").value.trim();
    if (text) sendToActiveTab({ type: MSG.HIGHLIGHT_BY_TEXT, text });
  });
  document.getElementById("btn-clear").addEventListener("click", () => sendToActiveTab({ type: MSG.CLEAR_HIGHLIGHTS }));
  document.getElementById("btn-open-panel")?.addEventListener("click", () => sendToActiveTab({ type: MSG.OPEN_PANEL }));

  // AI readiness indicator (shows if an OpenAI key is configured in background)
  (async function showAiStatus() {
    const el = document.getElementById("ai-ready");
    if (!el) return;
    el.textContent = "AI status: checking…";
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.AI_HAS_KEY });
      const ready = !!res?.hasKey;
      el.textContent = ready ? "AI status: ready" : "AI status: not configured";
      el.style.color = ready ? "#2e7d32" : "#b71c1c";
    } catch (e) {
      el.textContent = "AI status: error";
      el.style.color = "#b71c1c";
    }
  })();
