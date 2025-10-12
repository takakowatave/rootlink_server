import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";

const app = new Hono();
app.use("*", cors());

app.get("/", (c) => c.text("Hono server is running!"));

// ✅ OpenAI APIを呼び出して、Gemini仕様のJSONを返す
app.post("/chat", async (c) => {
  const { message } = await c.req.json();

  const prompt = `
次の英単語「${message}」について、日本語で以下の形式の**JSON文字列のみ**を返してください。
装飾や説明文、バッククォートなどは含めないでください。

{
  "main": {
    "word": "単語",
    "meaning": "意味（日本語）",
    "partOfSpeech": "品詞",
    "pronunciation": "発音記号",
    "example": "英語の例文",
    "translation": "例文の日本訳"
  },
  "synonyms": {
    "word": "類義語（あれば）",
    "meaning": "意味（日本語）",
    "partOfSpeech": "品詞",
    "pronunciation": "発音記号",
    "example": "英語の例文",
    "translation": "例文の日本訳"
  },
  "antonyms": {
    "word": "対義語（あれば）",
    "meaning": "意味（日本語）",
    "partOfSpeech": "品詞",
    "pronunciation": "発音記号",
    "example": "英語の例文",
    "translation": "例文の日本訳"
  }
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

    // ✅ OpenAIの返答をパース
    let parsed;
    try {
      const content = data?.choices?.[0]?.message?.content;
      const cleaned = content?.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error("❌ JSON parse error:", err);
      return c.json({ error: "Invalid JSON returned by OpenAI", raw: data });
    }

    // ✅ フロントが期待する形式で返す
    return c.json({
      main: {
        ...parsed.main,
        partOfSpeech: Array.isArray(parsed.main.partOfSpeech)
          ? parsed.main.partOfSpeech
          : [parsed.main.partOfSpeech],
      },
      synonyms: parsed.synonyms
        ? {
            ...parsed.synonyms,
            partOfSpeech: Array.isArray(parsed.synonyms.partOfSpeech)
              ? parsed.synonyms.partOfSpeech
              : [parsed.synonyms.partOfSpeech],
          }
        : undefined,
      antonyms: parsed.antonyms
        ? {
            ...parsed.antonyms,
            partOfSpeech: Array.isArray(parsed.antonyms.partOfSpeech)
              ? parsed.antonyms.partOfSpeech
              : [parsed.antonyms.partOfSpeech],
          }
        : undefined,
    });

  } catch (err) {
    console.error("🔥 OpenAI fetch error:", err);
    return c.json({ error: "OpenAI fetch failed" });
  }
});

const port = Number(process.env.PORT) || 8080;
console.log(`🚀 Server running on port ${port}`);

serve({ fetch: app.fetch, port });

