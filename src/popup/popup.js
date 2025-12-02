// Popup: simple enable/disable toggle for the on-page “?” FAB (AI Breadcrumb Guide)

const SETTINGS_KEY = "hermes_settings";
const defaultSettings = {
  textSize: "large",
  highContrast: true,
  voiceHints: false,
  enabled: true,
  theme: "violet",
  micEnabled: false,
  restrictedSites: []
};

async function loadSettings() {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    const s = got?.[SETTINGS_KEY];
    if (s && typeof s === "object") return { ...defaultSettings, ...s };
  } catch {}
  return { ...defaultSettings };
}

async function saveSettings(settings) {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (e) {
    console.warn("Failed to save settings:", e);
  }
}

function renderStatus(enabled) {
  const status = document.getElementById("status");
  const btn = document.getElementById("toggle");
  if (status) {
    status.textContent = `Status: ${enabled ? "enabled" : "disabled"}`;
    status.style.color = enabled ? "#2e7d32" : "#b71c1c";
  }
  if (btn) btn.textContent = enabled ? "Disable" : "Enable";
}

(async function init() {
  let settings = await loadSettings();
  renderStatus(!!settings.enabled);

  document.getElementById("toggle")?.addEventListener("click", async () => {
    settings.enabled = !settings.enabled;
    await saveSettings(settings);
    // content.js listens to chrome.storage.onChanged and will show/hide FAB accordingly
    renderStatus(!!settings.enabled);
  });
})();
