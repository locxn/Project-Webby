// src/background.js
const MSG = {
  HIGHLIGHT_SIGN_IN: "HERMES_HIGHLIGHT_SIGN_IN"
};

chrome.runtime.onInstalled.addListener(() => {
  console.log("Project Hermes installed.");
});

// Example: context menu to trigger Sign in highlight
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "hermes-highlight-sign-in",
    title: "Hermes: Highlight Sign in",
    contexts: ["all"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "hermes-highlight-sign-in" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: MSG.HIGHLIGHT_SIGN_IN });
  }
});
