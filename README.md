# Project Hermes — Adaptive Navigation Assistant (MV3 extension)

An accessibility-first assistant that overlays any website to guide older adults through multi-step tasks. This prototype injects a floating “Guide AI” button and a keyboard-friendly panel with Ask AI, History, and Settings tabs. It includes a guide engine with a breadcrumb trail and demo pages for realistic scenarios.

Note: Built as a no-build MV3 extension (vanilla JS + Shadow DOM) to minimize setup and CSS conflicts. The code is structured to be migrated to React + TypeScript in a future iteration if desired.

## What’s included in this prototype

- Manifest V3 Chrome extension with:
  - Content script injecting:
    - Floating “Guide AI” button (bottom-right).
    - Assistant panel with tabs:
      - Ask AI: Rule-based helpful replies (no API key needed).
      - History: Seeded demo guides with “Replay guide”.
      - Settings: Text size (Small/Medium/Large), High-contrast mode, Voice hints (speechSynthesis), global on/off toggle, privacy statement.
    - Guide Overlay System:
      - Steps with selector and instruction.
      - High-contrast highlight ring + tooltip bubble anchored to target.
      - Breadcrumb trail with clickable crumbs to jump back.
      - Status readout and Next / Back / Exit controls.
      - Pause/Resume across page navigation (persists current step in storage).
  - Popup to:
    - Open the on-page assistant panel.
    - “Highlight Sign in” and “Find by visible text”.
  - Background service worker for extension lifecycle and a context menu item to highlight “Sign in”.
- Demo site (file-based) for testing:
  - demo/health-portal/index.html (dashboard)
  - demo/health-portal/results.html (test results list with “Download PDF”)

## Install (Load Unpacked)

1) In Chrome, open chrome://extensions
2) Enable “Developer mode”.
3) Click “Load unpacked” and select this folder (project-hermes).
4) Pin “Project Hermes” to the toolbar if desired.

Important for demo pages (file://):
- In chrome://extensions, find “Project Hermes” and toggle “Allow access to file URLs” ON. This lets the content script run on local demo pages.

## Try the features

A) On any normal site (not chrome:// pages):
- You should see a floating “Guide AI” button at bottom-right.
- Click it to open the panel.
- Ask AI: type “Find my test results” or “Download my benefits letter”.
- History tab: “Replay guide” to start a demo guide.
- Settings:
  - Text size: Small/Medium/Large (defaults to Large for readability).
  - High-contrast mode: On by default.
  - Voice hints: Toggle to hear spoken hints if supported by the browser.
  - Turn off assistant (global): Shows banner and marks FAB “(off)”.

Popup actions:
- Click the extension icon → “Open Guide AI panel” (opens the on-page panel).
- “Highlight ‘Sign in’”
- “Find by visible text”: type “Checkout”, “Results”, etc.

B) Demo scenario: “Find and download your latest test result”
- Enable “Allow access to file URLs” as above.
- Open demo/health-portal/index.html (for example, drag-drop into Chrome or open file path).
- Use the extension panel → History → “Replay guide” on “Find and download your latest test result”.
- Follow steps with the breadcrumb trail:
  1. Click “Results” (navigates to results.html).
  2. Open your latest result.
  3. Click “Download PDF”.
- Use the Next/Back/Exit controls or keyboard arrows (Left/Right while guide is running).
- The breadcrumb is clickable to jump back to earlier steps.

## Accessibility & Design Notes

- Large, high-contrast defaults for older-adult readability.
- Keyboard navigation:
  - Tab focus on controls and inputs.
  - Arrow keys switch tabs (Left/Right) and step the guide (Left/Right) when running.
  - Escape closes the panel.
- Consistent plain-language labels: “Guide AI”, “History”, “Settings”, “Replay guide”, “Turn off assistant”.
- Clear privacy explanation in Settings.
- Shadow DOM used to isolate assistant styles from page CSS.

## Architecture

- manifest.json: MV3 configuration (content script, background, popup, permissions).
- src/content.js:
  - Shadow-root based UI injection (floating FAB + panel).
  - Ask AI (rule-based), Settings (persisted via chrome.storage.local), History (seeded demo entries).
  - Guide Engine (highlight, tooltip, breadcrumb, status, navigation).
  - Message handlers to interop with popup (open/toggle panel, highlight actions).
  - Existing highlight heuristics (Sign in, by visible text) preserved and compatible.
- src/popup/popup.html + popup.js:
  - Control panel to open on-page assistant and trigger highlighting.
- src/background.js:
  - Service worker lifecycle and context menu (“Hermes: Highlight Sign in”).
- demo/health-portal/*.html:
  - Simple file-based demo site to exercise guide steps.

Why no React/TypeScript yet?
- Kept a no-build setup to ship a working prototype quickly and minimize friction with MV3 + bundlers.
- The UI is modularized in content.js and Shadow DOM for future migration to React + TypeScript (e.g., Vite) if desired.

## Storage

- chrome.storage.local
  - hermes_settings: textSize, highContrast, voiceHints, enabled.
  - hermes_history: array of demo guide entries (seeded on first run).
  - hermes_running_guide: persists current guide id and step to resume across page navigation.

## Known Limitations / Next Steps

- Guide steps don’t wait on actual user clicks (prototype uses Next/Back). Can add event-based progression later.
- urlIncludes metadata in steps is currently informational; a future version could validate page context before advancing.
- History saving of completed runs is seeded demo content; expanding to record actual runs is straightforward.
- React + TypeScript integration (Vite) can be added in a follow-up:
  - Create a content UI bundle mounted in Shadow DOM.
  - Keep guide logic and messaging in separate modules for testability.

## Development notes

- This project uses a no-build workflow. Edits to files are live once you reload the extension:
  1) chrome://extensions → click “Reload” on Project Hermes.
  2) Refresh your test webpage.

## Privacy

The assistant sees the current page’s DOM structure to guide you. It does not read passwords or store sensitive fields. You can turn off the assistant at any time from Settings or hide the panel.

## AI mode (OpenAI)

What it does
- When you type a question in Ask AI, the extension summarizes the current page (URL, title, top headings, visible navigation link labels, visible button labels) and sends that summary with your question to OpenAI Chat Completions.
- The model returns:
  1) A short, plain-language reply (for older adults).
  2) A JSON “plan” inside a fenced ```json code block. The plan includes goal, confidence, and steps with an optional selector_hint.

How to enable
- Option 1 (Settings UI): Open the panel → Settings → enter your OpenAI API key (sk-...) → Save Key. The popup indicator shows “AI is ready” when configured.
- Option 2 (Dev only): Place your key in myapi.txt at the project root before loading the extension; on install/reload, the background will seed the key automatically (good for quick testing). Avoid committing real keys to source control.

What data is sent to OpenAI
- Only a lightweight page summary:
  - url, title
  - up to 20 headings (h1/h2/h3)
  - up to 50 visible anchor text labels
  - up to 50 visible button-like labels (button, role=button, input[type=button/submit])
- No text input values, and no password fields.
- See src/ai/prompt.js for the exact system prompt and message shape.

Running plans as guides
- The AI reply includes a JSON plan in a fenced ```json block:
  - Each step has "instruction" and optional "selector_hint" (either a CSS selector like #download-pdf or a visible label like “Results”).
- The Ask AI panel renders a “Run plan as guide” button below the reply.
- Clicking it converts the AI plan into a dynamic guide:
  - If selector_hint looks like a CSS selector (#, ., [), it tries querySelector.
  - Otherwise it searches buttons/links by visible text.
  - Guide UI provides breadcrumb trail, Next/Back/Exit, and keyboard arrows.
  - The running plan persists across navigation.

Configuration and code
- Background API wrapper (good practice; key stays in service worker):
  - src/background.js (HERMES_AI_SET_KEY, HERMES_AI_HAS_KEY, HERMES_AI_ASK)
  - src/ai/client.js (fetch-based OpenAI client)
  - src/ai/prompt.js (older-adult friendly system prompt + contextual message builder)
- Content script:
  - Builds page summary (headings/nav/buttons).
  - Sends Ask → background for LLM call.
  - Parses the model’s ```json fenced plan and renders a “Run plan as guide” control.

Notes
- Default model: gpt-4o-mini, temperature 0.2 (tunable in src/background.js).
- To disable AI, remove the key in Settings or toggle the assistant OFF globally.
- Best practice: do not commit real keys; use Settings to set per-user keys at runtime.
