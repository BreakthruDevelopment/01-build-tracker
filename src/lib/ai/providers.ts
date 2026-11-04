import { type AiProvider, AiError } from "./types";

const TIMEOUT_MS = 30_000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 429) throw new AiError("Model quota reached", "quota");
  if (!res.ok) {
    // Never echo the response body: it can contain request details.
    throw new AiError(`Model provider returned HTTP ${res.status}`, "provider");
  }
  return res.json();
}

/** Google Gemini API (free tier via Google AI Studio). */
export function geminiProvider(apiKey: string, model: string): AiProvider {
  return {
    name: "gemini",
    model,
    async complete({ system, prompt, maxOutputTokens }) {
      const json = (await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": apiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens },
        },
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
      if (!text) throw new AiError("Empty response from model", "invalid_output");
      return text;
    },
  };
}

/** Anthropic Claude (Messages API). Optional: for clients who pay for it. */
export function anthropicProvider(apiKey: string, model: string): AiProvider {
  return {
    name: "anthropic",
    model,
    async complete({ system, prompt, maxOutputTokens }) {
      const json = (await post(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: maxOutputTokens,
          system: `${system}\n\nRespond with JSON only, no prose and no code fences.`,
          messages: [{ role: "user", content: prompt }],
        },
      )) as { content?: { type: string; text?: string }[] };
      const text = json.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (!text) throw new AiError("Empty response from model", "invalid_output");
      return text;
    },
  };
}
