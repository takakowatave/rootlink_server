import 'dotenv/config'
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import auth from "./routes/auth.js";
import stripe from "./routes/stripe.js";
import { resolveQuery } from "./lib/resolveQuery.js";
import { getSupabase } from "./lib/supabase.js";
import { generateTTS } from "./lib/generateTTS.js";

const app = new Hono();

/* =========================
 * 1. CORS
 * ========================= */
app.use(
  "/*",
  cors({
    origin: (origin) => {
      if (!origin) return "*"; // curl / server-to-server 用

      if (origin === "http://localhost:3000") return origin;
      if (origin.endsWith(".vercel.app")) return origin;
      if (origin === "https://rootlink.vercel.app") return origin;
      if (origin === "https://www.rootlink.jp") return origin;
      if (origin === "https://www.rootlink.app") return origin;
      if (origin === "https://rootlink.app") return origin;

      return null; // 明示的に拒否
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

/* =========================
 * 2. Health check
 * ========================= */
app.get("/", (c) => c.text("OK"));

/* =========================
 * 3. Routes
 * ========================= */
app.route("/auth", auth);
app.route("/stripe", stripe);


/* =========================
 * 4. resolveQuery
 * ========================= */
app.post("/resolve", async (c) => {
  try {
    const body = await c.req.json()
    const result = await resolveQuery(body.query)
    return c.json(result)
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "OxfordUsageLimitError"
    ) {
      return c.json(
        {
          ok: false,
          reason: "UNAVAILABLE",
        },
        503
      )
    }

    console.error("RESOLVE HANDLER FAILED:", error)

    return c.json(
      {
        ok: false,
        reason: "INTERNAL_ERROR",
      },
      500
    )
  }
})

/* =========================
 * 5. Audio (TTS on demand)
 * ========================= */
app.post("/audio", async (c) => {
  try {
    const body = await c.req.json()
    const word: string = body.word

    if (!word) return c.json({ ok: false, reason: "MISSING_WORD" }, 400)

    const supabase = getSupabase()

    // キャッシュ確認
    const { data: wordRow } = await supabase
      .from("words")
      .select("id")
      .eq("word", word)
      .maybeSingle()

    if (wordRow?.id) {
      const { data: cached } = await supabase
        .from("dictionary_cache")
        .select("payload")
        .eq("word_id", wordRow.id)
        .maybeSingle()

      if (cached?.payload?.audio?.audioPath) {
        const supabaseUrl = process.env.SUPABASE_URL!
        const audioUrl = `${supabaseUrl}/storage/v1/object/public/${cached.payload.audio.audioPath}`
        return c.json({ ok: true, audioUrl })
      }
    }

    // 生成
    const audioPath = await generateTTS(word)
    if (!audioPath) return c.json({ ok: false, reason: "TTS_FAILED" }, 500)

    // payloadに保存
    if (wordRow?.id) {
      const { data: cached } = await supabase
        .from("dictionary_cache")
        .select("payload")
        .eq("word_id", wordRow.id)
        .maybeSingle()

      if (cached?.payload) {
        await supabase
          .from("dictionary_cache")
          .update({ payload: { ...cached.payload, audio: { audioPath } } })
          .eq("word_id", wordRow.id)
      }
    }

    const supabaseUrl = process.env.SUPABASE_URL!
    const audioUrl = `${supabaseUrl}/storage/v1/object/public/${audioPath}`
    return c.json({ ok: true, audioUrl })
  } catch (error) {
    console.error("AUDIO HANDLER FAILED:", error)
    return c.json({ ok: false, reason: "INTERNAL_ERROR" }, 500)
  }
})

/* =========================
 * 6. Chat (AI Executor)
 * =========================
 * - プロンプトはフロントから受け取る
 * - server は OpenAI API を叩くだけ
 * - API Key は server から出ない
 */
app.post("/chat", async (c) => {
  try {
    // ログイン済みユーザーのみ許可
    const token = c.req.header("Authorization")?.replace("Bearer ", "")
    if (!token) return c.json({ error: "Unauthorized" }, 401)

    const supabase = getSupabase()
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const body = await c.req.json();

    const prompt = body?.prompt;

    if (!prompt || typeof prompt !== "string") {
      return c.json(
        { error: "Invalid request: prompt is required" },
        400
      );
    }

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
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
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error("🔥 OpenAI API error:", text);
      return c.json({ error: "OpenAI API error" }, 500);
    }

    const data = await response.json();

    const cleaned = data?.choices?.[0]?.message?.content
    ?.replace(/```json|```/g, "")
    ?.trim();
  
  console.log("🧠 Prompt snippet:", prompt.slice(0, 120));
  console.log("🧠 AI raw content:", cleaned);
  

    if (!cleaned) {
      return c.json(
        { error: "Empty response from OpenAI" },
        500
      );
    }

    return c.json(JSON.parse(cleaned));
  } catch (err) {
    console.error("🔥 Server error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

/* =========================
 * 6. Cloud Run
 * ========================= */
const port = Number(process.env.PORT) || 8080;

serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0",
});

console.log(`🚀 RootLink Server running on port ${port}`);


