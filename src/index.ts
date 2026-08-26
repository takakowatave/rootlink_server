import 'dotenv/config'
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import auth from "./routes/auth.js";
import stripe from "./routes/stripe.js";
import revenuecat from "./routes/revenuecat.js";
import { resolveQuery, ensureHookForCachedWord } from "./lib/resolveQuery.js";
import { getSupabase } from "./lib/supabase.js";
import { generateTTS, generateTTSInstructions, generatePhraseTTS, generatePhraseHeadwordTTS, generateWordExampleTTS } from "./lib/generateTTS.js";
import { fetchOxfordAudioUrl } from "./lib/fetchOxfordAudio.js";
import { rateLimit } from "./lib/rateLimit.js";

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
app.route("/revenuecat", revenuecat);


/* =========================
 * 4. resolveQuery
 * ========================= */
app.post("/resolve", rateLimit, async (c) => {
  try {
    const body = await c.req.json()
    const query = typeof body?.query === "string" ? body.query.trim() : ""
    if (!query || query.length > 100) {
      return c.json({ ok: false, reason: "INVALID_QUERY" }, 400)
    }
    const result = await resolveQuery(query)
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
 * 4a. Hook lazy generation
 *   OGP・単語詳細から fire-and-forget で叩く。
 *   hook が空なら AI で生成→ dictionary_cache 更新。既存なら noop。
 * ========================= */
app.post("/hook", rateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const word = typeof body?.word === "string" ? body.word.trim() : ""
    if (!word || word.length > 100) {
      return c.json({ ok: false, reason: "INVALID_WORD" }, 400)
    }
    const result = await ensureHookForCachedWord(word)
    const status = result.ok ? 200 : result.reason === "NOT_CACHED" ? 404 : 200
    return c.json(result, status)
  } catch (error) {
    console.error("HOOK HANDLER FAILED:", error)
    return c.json({ ok: false, reason: "INTERNAL_ERROR" }, 500)
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

    // words + dictionary_cache を同時取得
    const { data: wordRow } = await supabase
      .from("words")
      .select("id")
      .eq("word", word)
      .maybeSingle()

    type CachePayload = {
      ipa?: string
      audio?: { audioUrl?: string; audioPath?: string }
      ttsInstructions?: string
      [key: string]: unknown
    }
    let cachedPayload: CachePayload | null = null

    if (wordRow?.id) {
      const { data: cached } = await supabase
        .from("dictionary_cache")
        .select("payload")
        .eq("word_id", wordRow.id)
        .maybeSingle()

      cachedPayload = (cached?.payload as CachePayload) ?? null

      // Oxford の公式音声 URL が最優先
      if (cachedPayload?.audio?.audioUrl) {
        return c.json({ ok: true, audioUrl: cachedPayload.audio.audioUrl })
      }

      if (cachedPayload?.audio?.audioPath) {
        const supabaseUrl = process.env.SUPABASE_URL!
        const audioUrl = `${supabaseUrl}/storage/v1/object/public/${cachedPayload.audio.audioPath}`
        return c.json({ ok: true, audioUrl })
      }

      // Lazy backfill: 既存 cache に audio が入っていなくても、Oxford URL を1回取りに行って保存する。
      // 実際に音声が鳴らされる単語だけがコスト対象になる（節約）。
      const backfilledUrl = await fetchOxfordAudioUrl(word)
      if (backfilledUrl) {
        const nextPayload: CachePayload = { ...(cachedPayload ?? {}), audio: { audioUrl: backfilledUrl } }
        await supabase
          .from("dictionary_cache")
          .upsert(
            { word_id: wordRow.id, payload: nextPayload },
            { onConflict: "word_id" },
          )
        return c.json({ ok: true, audioUrl: backfilledUrl })
      }
    }

    // 発音 instructions を用意（キャッシュ優先・なければ IPA から生成）
    let instructions = cachedPayload?.ttsInstructions
    if (!instructions && cachedPayload?.ipa) {
      instructions = await generateTTSInstructions(word, cachedPayload.ipa)
    }

    const audioPath = await generateTTS(word, instructions)
    if (!audioPath) return c.json({ ok: false, reason: "TTS_FAILED" }, 500)

    // payloadに保存（audio + ttsInstructions を同時に）
    if (wordRow?.id) {
      const nextPayload: CachePayload = { ...(cachedPayload ?? {}), audio: { audioPath } }
      if (instructions) nextPayload.ttsInstructions = instructions
      await supabase
        .from("dictionary_cache")
        .upsert(
          { word_id: wordRow.id, payload: nextPayload },
          { onConflict: "word_id" },
        )
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
 * 5a. Audio for word sense example (TTS on demand)
 * ========================= */
app.post("/audio/word/example", async (c) => {
  try {
    const body = await c.req.json()
    const word: string = body.word
    const senseId: string = body.sense_id

    if (!word || !senseId) {
      return c.json({ ok: false, reason: "MISSING_PARAMS" }, 400)
    }

    const supabase = getSupabase()
    const supabaseUrl = process.env.SUPABASE_URL!

    const { data: wordRow } = await supabase
      .from("words")
      .select("id")
      .eq("word", word)
      .maybeSingle()

    if (!wordRow?.id) {
      return c.json({ ok: false, reason: "WORD_NOT_FOUND" }, 404)
    }

    const { data: cached } = await supabase
      .from("dictionary_cache")
      .select("payload")
      .eq("word_id", wordRow.id)
      .maybeSingle()

    type SenseAudioMap = Record<string, string>
    type Sense = { senseId?: string; example?: string }
    type SenseGroup = { senses?: Sense[] }
    type CachePayload = {
      senseGroups?: SenseGroup[]
      senseAudioPaths?: SenseAudioMap
      [key: string]: unknown
    }

    const payload = (cached?.payload as CachePayload | null) ?? null
    if (!payload) {
      return c.json({ ok: false, reason: "CACHE_NOT_FOUND" }, 404)
    }

    const cachedPath = payload.senseAudioPaths?.[senseId]
    if (cachedPath) {
      const audioUrl = `${supabaseUrl}/storage/v1/object/public/${cachedPath}`
      return c.json({ ok: true, audioUrl })
    }

    let exampleText: string | undefined
    for (const group of payload.senseGroups ?? []) {
      for (const sense of group.senses ?? []) {
        if (sense.senseId === senseId && sense.example) {
          exampleText = sense.example
          break
        }
      }
      if (exampleText) break
    }

    if (!exampleText) {
      return c.json({ ok: false, reason: "NO_EXAMPLE" }, 400)
    }

    const audioPath = await generateWordExampleTTS(senseId, exampleText)
    if (!audioPath) return c.json({ ok: false, reason: "TTS_FAILED" }, 500)

    const nextAudioMap: SenseAudioMap = {
      ...(payload.senseAudioPaths ?? {}),
      [senseId]: audioPath,
    }
    await supabase
      .from("dictionary_cache")
      .update({ payload: { ...payload, senseAudioPaths: nextAudioMap } })
      .eq("word_id", wordRow.id)

    const audioUrl = `${supabaseUrl}/storage/v1/object/public/${audioPath}`
    return c.json({ ok: true, audioUrl })
  } catch (error) {
    console.error("AUDIO WORD EXAMPLE HANDLER FAILED:", error)
    return c.json({ ok: false, reason: "INTERNAL_ERROR" }, 500)
  }
})

/* =========================
 * 5b. Audio for phrase example (TTS on demand)
 * ========================= */
app.post("/audio/phrase", async (c) => {
  try {
    const body = await c.req.json()
    const phraseCardId: string = body.phrase_card_id

    if (!phraseCardId) {
      return c.json({ ok: false, reason: "MISSING_PHRASE_CARD_ID" }, 400)
    }

    const supabase = getSupabase()
    const supabaseUrl = process.env.SUPABASE_URL!

    const { data: card } = await supabase
      .from("phrase_cards")
      .select("id, example_en, audio_path")
      .eq("id", phraseCardId)
      .maybeSingle()

    if (!card) {
      return c.json({ ok: false, reason: "NOT_FOUND" }, 404)
    }

    if (card.audio_path) {
      const audioUrl = `${supabaseUrl}/storage/v1/object/public/${card.audio_path}`
      return c.json({ ok: true, audioUrl })
    }

    if (!card.example_en) {
      return c.json({ ok: false, reason: "NO_EXAMPLE" }, 400)
    }

    const audioPath = await generatePhraseTTS(card.id, card.example_en)
    if (!audioPath) return c.json({ ok: false, reason: "TTS_FAILED" }, 500)

    await supabase
      .from("phrase_cards")
      .update({ audio_path: audioPath })
      .eq("id", card.id)

    const audioUrl = `${supabaseUrl}/storage/v1/object/public/${audioPath}`
    return c.json({ ok: true, audioUrl })
  } catch (error) {
    console.error("AUDIO PHRASE HANDLER FAILED:", error)
    return c.json({ ok: false, reason: "INTERNAL_ERROR" }, 500)
  }
})

/* =========================
 * 5c. Audio for phrase headword (TTS on demand)
 * ========================= */
app.post("/audio/phrase/headword", async (c) => {
  try {
    const body = await c.req.json()
    const phraseCardId: string = body.phrase_card_id

    if (!phraseCardId) {
      return c.json({ ok: false, reason: "MISSING_PHRASE_CARD_ID" }, 400)
    }

    const supabase = getSupabase()
    const supabaseUrl = process.env.SUPABASE_URL!

    const { data: card } = await supabase
      .from("phrase_cards")
      .select("id, phrase, headword_audio_path")
      .eq("id", phraseCardId)
      .maybeSingle()

    if (!card) {
      return c.json({ ok: false, reason: "NOT_FOUND" }, 404)
    }

    if (card.headword_audio_path) {
      const audioUrl = `${supabaseUrl}/storage/v1/object/public/${card.headword_audio_path}`
      return c.json({ ok: true, audioUrl })
    }

    if (!card.phrase) {
      return c.json({ ok: false, reason: "NO_PHRASE" }, 400)
    }

    const audioPath = await generatePhraseHeadwordTTS(card.id, card.phrase)
    if (!audioPath) return c.json({ ok: false, reason: "TTS_FAILED" }, 500)

    await supabase
      .from("phrase_cards")
      .update({ headword_audio_path: audioPath })
      .eq("id", card.id)

    const audioUrl = `${supabaseUrl}/storage/v1/object/public/${audioPath}`
    return c.json({ ok: true, audioUrl })
  } catch (error) {
    console.error("AUDIO PHRASE HEADWORD HANDLER FAILED:", error)
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


