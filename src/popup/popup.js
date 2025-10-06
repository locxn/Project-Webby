const MSG = {
    HIGHLIGHT_SIGN_IN: "HERMES_HIGHLIGHT_SIGN_IN",
    HIGHLIGHT_BY_TEXT: "HERMES_HIGHLIGHT_BY_TEXT",
    CLEAR_HIGHLIGHTS: "HERMES_CLEAR_HIGHLIGHTS"
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
  