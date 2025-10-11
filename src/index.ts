import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";

const app = new Hono();
app.use("*", cors());

app.get("/", (c) => c.text("Hono server is running!"));

// OpenAIエンドポイント
app.post("/chat", async (c) => {
  const { message } = await c.req.json();

  const prompt = `
次の英単語「${message}」について、日本語で以下の形式の**JSON文字列のみ**を返してください。
装飾や説明文、バッククォートなどは含めないでください。

{
  "word": "単語",
  "meaning": "意味",
  "partOfSpeech": "品詞",
  "pronunciation": "発音記号",
  "example": "英語の例文（日本語訳付き）"
}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();

  // 🔍 OpenAIからのJSON文字列をパース
  let parsed;
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch (err) {
    console.error("❌ JSON parse error:", err);
    return c.json({ error: "Invalid JSON returned by OpenAI", raw: data });
  }

  return c.json(parsed);
});

const port = Number(process.env.PORT) || 8080;
console.log(`🚀 Server running on port ${port}`);

serve({ fetch: app.fetch, port });
