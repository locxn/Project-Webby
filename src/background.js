// src/background.js (MV3 service worker, module)
import { chatCompletion } from "./ai/client.js";
import { buildMessages } from "./ai/prompt.js";

const MSG = {
  HIGHLIGHT_SIGN_IN: "HERMES_HIGHLIGHT_SIGN_IN",
  AI_ASK: "HERMES_AI_ASK",
  AI_SET_KEY: "HERMES_AI_SET_KEY",
  AI_HAS_KEY: "HERMES_AI_HAS_KEY",
};

const KEY_STORAGE = "hermes_openai_key";

// Install/init
chrome.runtime.onInstalled.addListener(async () => {
  console.log("Project Hermes installed.");
  try {
    await createContextMenu();
    await seedKeyFromPackagedFile();
  } catch (e) {
    console.warn("Initialization warnings:", e);
  }
});

// Context menu for quick highlight
async function createContextMenu() {
  chrome.contextMenus.create({
    id: "hermes-highlight-sign-in",
    title: "Hermes: Highlight Sign in",
    contexts: ["all"]
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "hermes-highlight-sign-in" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: MSG.HIGHLIGHT_SIGN_IN });
  }
});

// Attempt to seed API key from packaged myapi.txt (for development)
async function seedKeyFromPackagedFile() {
  const existing = await getApiKey();
  if (existing) return;
  try {
    const url = chrome.runtime.getURL("myapi.txt");
    const res = await fetch(url);
    if (!res.ok) return;
    const text = (await res.text()).trim();
    if (/^sk-/.test(text) || /^sk-proj-/.test(text)) {
      await chrome.storage.local.set({ [KEY_STORAGE]: text });
      console.log("Seeded OpenAI key from myapi.txt");
    }
  } catch (e) {
    // ignore if file missing
  }
}

async function getApiKey() {
  const got = await chrome.storage.local.get(KEY_STORAGE);
  return got?.[KEY_STORAGE] || null;
}

// Messaging API used by content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Save/clear key from Settings
  if (message?.type === MSG.AI_SET_KEY) {
    const val = (message?.key || "").trim();
    if (!val) {
      chrome.storage.local.remove(KEY_STORAGE).then(() => sendResponse({ ok: true, cleared: true }));
      return true;
    }
    chrome.storage.local.set({ [KEY_STORAGE]: val }).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Check if key present
  if (message?.type === MSG.AI_HAS_KEY) {
    getApiKey()
      .then((k) => sendResponse({ ok: true, hasKey: !!k }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Ask AI with contextual prompt
  if (message?.type === MSG.AI_ASK) {
    (async () => {
      try {
        const apiKey = await getApiKey();
        if (!apiKey) {
          sendResponse({ ok: false, error: "Missing OpenAI API key. Add it in Settings." });
          return;
        }
        const { userText, context, model, temperature } = message || {};
        const messages = buildMessages({ userText, context });
        const { content } = await chatCompletion({
          apiKey,
          messages,
          model: model || "gpt-4o-mini",
          temperature: temperature ?? 0.2
        });
        sendResponse({ ok: true, content });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // keep channel open for async response
  }

  // default
  return false;
});
