import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server"; // ← これを使う
import auth from "./routes/auth.js";

const app = new Hono();
app.use("*", cors());

// ✅ ヘルスチェック
app.get("/", (c) => c.text("OK"));

// ✅ Auth ルート
app.route("/auth", auth);

// ✅ Chat API
app.post("/chat", async (c) => {
  const { message } = await c.req.json();

  const prompt = `
次の英単語「${message}」について、日本語で以下の形式のJSONを返してください。
{
  "main": { "word": "", "meaning": "", "partOfSpeech": [], "pronunciation": "", "example": "", "translation": "" }
}`;

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
      }),
    });

    const data = await response.json();
    const cleaned = data?.choices?.[0]?.message?.content
      ?.replace(/```json|```/g, "")
      ?.trim();

    return c.json(JSON.parse(cleaned));
  } catch (err) {
    console.error("🔥 OpenAI fetch error:", err);
    return c.json({ error: "OpenAI fetch failed" });
  }
});

// ✅ Cloud Run 用ポート設定
const port = Number(process.env.PORT) || 8080;

// ✅ Cloud Run 向け: hono/node-server を使って起動
serve({
  fetch: app.fetch,
  port,
});

console.log(`🚀 Server running on port ${port}`);
