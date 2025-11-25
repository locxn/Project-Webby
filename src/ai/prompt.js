// src/ai/prompt.js
// Builds OpenAI chat messages for a contextual, older-adult friendly assistant.
// The model is asked to return BOTH:
// 1) A short, plain-language helpful reply
// 2) A JSON plan object inside a fenced ```json code block for easy parsing.

const SYSTEM_PROMPT = `
You are "Guide AI", an accessibility-first assistant for older adults (60+) with low to moderate technology literacy.
Your job is to help users complete multi-step tasks on the CURRENT web page clearly and kindly.

Requirements:
- Be concise, friendly, and use plain language. Avoid jargon.
- Prioritize memorability and learnability: keep steps short, high-level, and consistent.
- Output BOTH:
  1) A SHORT helpful reply (2-6 sentences) with step-by-step guidance.
  2) A JSON plan in a fenced code block like:

\`\`\`json
{
  "goal": "One-line goal",
  "confidence": 0.0,
  "website": { "url": "...", "title": "..." },
  "steps": [
    { "instruction": "Clear action", "selector_hint": "Optional selector text or visible label", "notes": "Optional" }
  ]
}
\`\`\`

- "selector_hint" should reference the most likely on-page label or simple selector guess (ids, text).
- If the page context is missing, produce a reasonable plan from the question alone.
- Never include secrets or private data in the plan. Keep it page-context only.
`;

export function buildMessages(payload) {
  const { userText, context } = payload || {};
  const contextSummary = context
    ? {
        url: context.url,
        title: context.title,
        headings: (context.headings || []).slice(0, 20),
        navLinks: (context.navLinks || []).slice(0, 20),
        buttons: (context.buttons || []).slice(0, 20),
      }
    : null;

  const userBlock = [
    `User question:\n${userText || ""}`,
    contextSummary
      ? `\nPage context:\n${JSON.stringify(contextSummary, null, 2)}`
      : `\nPage context: [not provided]`,
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT.trim() },
    { role: "user", content: userBlock },
  ];
}
