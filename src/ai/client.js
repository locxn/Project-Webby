// src/ai/client.js
// Minimal OpenAI Chat Completions client using fetch.
// Used by the MV3 background service worker to keep secrets out of content scripts.

export async function chatCompletion({ apiKey, messages, model = "gpt-4o-mini", temperature = 0.2 }) {
  if (!apiKey) throw new Error("Missing OpenAI API key");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature,
      messages
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const choice = data?.choices?.[0]?.message?.content ?? "";
  return { content: choice, raw: data };
}
