import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import auth from "./routes/auth.js";


const app = new Hono();

// ✅ 1. CORS
app.use(
  "/*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (origin.endsWith(".vercel.app")) return origin;
      if (origin === "http://localhost:5173") return origin;
      if (origin === "https://rootlink.vercel.app") return origin;
      if (origin === "https://www.rootlink.jp") return origin;
      return "*";
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ 2. Preflightを明示的に返す
app.options("*", (c) =>
  c.newResponse("ok", {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  })
);

// ✅ 3. Health check
app.get("/", (c) => c.text("OK"));

// ✅ 4. Routes
app.route("/auth", auth);

app.post("/chat", async (c) => {
  const { message } = await c.req.json();

  const prompt = `
  次の英単語「${message}」について、以下の形式のJSONを返してください。
  出力はすべて英語で記述し、日本語は meaning と translation の値にのみ使ってください。

  {
    "main": { 
      "word": "",              // 英語の単語名
      "meaning": "",           // 日本語の意味
      "partOfSpeech": [], 
      "pronunciation": "", 
      "example": "", 
      "translation": ""        // 例文の日本語訳
    },
    "related": {
      "synonyms": [],          // 英語のみ
      "antonyms": [],          // 英語のみ
      "derivedWords": [],      // 英語のみ
      "collocations": []       // 英語のみ
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
      }),
    });

    const data = await response.json();
    const cleaned = data?.choices?.[0]?.message?.content
      ?.replace(/```json|```/g, "")
      ?.trim();

    return c.json(JSON.parse(cleaned));
  } catch (err) {
    console.error("🔥 OpenAI fetch error:", err);
    return c.json({ error: "OpenAI fetch failed" }, 500);
  }
});

// ✅ 5. Cloud Run
const port = Number(process.env.PORT) || 8080;
serve({ fetch: app.fetch, port });

console.log(`🚀 RootLink Server running on port ${port}`);
