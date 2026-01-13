import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import auth from "./routes/auth.js";
const app = new Hono();
/* =========================
 * 1. CORS
 * ========================= */
app.use("/*", cors({
    origin: (origin) => {
        if (!origin)
            return "*"; // curl / server-to-server 用
        if (origin === "http://localhost:3000")
            return origin;
        if (origin.endsWith(".vercel.app"))
            return origin;
        if (origin === "https://rootlink.vercel.app")
            return origin;
        if (origin === "https://www.rootlink.jp")
            return origin;
        return null; // 明示的に拒否
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
}));
/* =========================
 * 2. Health check
 * ========================= */
app.get("/", (c) => c.text("OK"));
/* =========================
 * 3. Routes
 * ========================= */
app.route("/auth", auth);
/* =========================
 * 4. Chat (Word Generator)
 * ========================= */
app.post("/chat", async (c) => {
    const { message } = await c.req.json();
    const prompt = `
For the English word "${message}", return JSON ONLY in the exact format below.

All output must be in English.
Japanese is allowed ONLY in "meaning" and "translation".

========================
ETYMology Hook Rules
========================
- Must be EXACTLY ONE sentence.
- No line breaks.
- No explanations or hedging.
- Prioritize memorability over academic accuracy.

Choose ONE type:
Type A: prefix + root (+ suffix)
Type B: root-based hub (shared image)
Type C: origin-based (no clear segmentation)
Type D: pure image (no etymology)

========================
Derived Words Rules
========================
- Include ONLY words that share the same root or etymological origin.
- NO explanations.
- Max 3 words.
- If none exist, return [].

========================
Synonyms / Antonyms Rules
========================
- ALWAYS include both.
- 1–2 words each.
- Common, high-frequency words only.
- English words only.

========================
Return this JSON format
========================

{
  "main": {
    "word": "",
    "meaning": "",
    "partOfSpeech": [],
    "pronunciation": "",
    "example": "",
    "translation": ""
  },
  "etymologyHook": {
    "type": "A | B | C | D",
    "text": ""
  },
  "derivedWords": [
    {
      "word": "",
      "partOfSpeech": "",
      "pronunciation": "",
      "meaning": ""
    }
  ],
  "related": {
    "synonyms": [],
    "antonyms": []
  }
}
`;
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: 0.7,
            }),
        });
        const data = await response.json();
        const cleaned = data?.choices?.[0]?.message?.content
            ?.replace(/```json|```/g, "")
            ?.trim();
        return c.json(JSON.parse(cleaned));
    }
    catch (err) {
        console.error("🔥 OpenAI fetch error:", err);
        return c.json({ error: "OpenAI fetch failed" }, 500);
    }
});
/* =========================
 * 5. Cloud Run
 * ========================= */
const port = Number(process.env.PORT) || 8080;
serve({
    fetch: app.fetch,
    port,
    hostname: "0.0.0.0",
});
console.log(`🚀 RootLink Server running on port ${port}`);
