## README.md
Quick start and notes.

# Project Webby — Quick Start

1. **Download / clone** this folder.
2. Open **Chrome → Extensions → Developer mode → Load unpacked** → select the `project-hermes` folder.
3. Pin "Project Hermes". Click the icon → try:
   - **Highlight “Sign in”** on any site with a login (e.g., a news site).
   - Use **Find by visible text** with words like `Checkout`, `Profile`, `Continue`.
4. Right‑click anywhere on a page → **Hermes: Highlight Sign in** (context menu).

## Notes / Architecture
- **Manifest V3** using a **service worker** background and a **content script**.
- The content script never permanently modifies the page; it renders overlays in a high `z-index` fixed root.
- Open **shadow DOMs** are searched; for cross‑origin iframes, host permissions are needed, but content scripts will run in those frames if allowed.
- Styling avoids intercepting clicks using `pointer-events: none` on the overlay root and rings.

## Extending to AI
- Map user requests → intents (e.g., `sign_in`, `checkout`, `download_invoice`).
- For each intent, add selectors and heuristics in `selectorEngine.js`.
- When your LLM determines an intent + optional text, it sends `{ type: MSG.HIGHLIGHT_BY_TEXT, text }` or a specialized message.

## Privacy & Security
- Avoid reading sensitive inputs by default.
- If you need form values/DOM snapshots, be explicit with users and document what is sent to servers.

## Roadmap Ideas
- Voice read‑out and microphone input.
- Multi‑element guidance (step 1/2/3 arrows).
- Per‑site fine‑tuning of selectors.
- Desktop overlay app (post‑MVP).
