import { Hono } from "hono"
import { hashExampleText, reserveTtsCall, recordTtsFailure } from "../lib/ttsBudget.js"

/**
 * Cuppa English 長尺動画用ナレーション TTS。
 * - OpenAI gpt-4o-mini-tts を叩いて raw mp3 を返す。Storage には保存しない (毎回新規原稿のため)。
 * - フロント (Vercel) の /admin/narration から Bearer <NARRATION_PROXY_SECRET> で呼び出す。
 *   フロント側で admin 認証 (ADMIN_EMAILS) を先に通している前提。ここは shared secret のみ検証。
 * - 日次 call 数は tts_daily_counters.kind='narration' で管理 (TTS_DAILY_LIMITS 参照)。
 */

const ALLOWED_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo",
  "fable", "onyx", "nova", "sage", "shimmer", "verse",
] as const
type Voice = typeof ALLOWED_VOICES[number]

const narration = new Hono()

narration.post("/", async (c) => {
  const secret = process.env.NARRATION_PROXY_SECRET
  if (!secret) {
    return c.json({ ok: false, reason: "NOT_CONFIGURED" }, 500)
  }
  const auth = c.req.header("Authorization")?.replace("Bearer ", "")
  if (auth !== secret) {
    return c.json({ ok: false, reason: "UNAUTHORIZED" }, 401)
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return c.json({ ok: false, reason: "OPENAI_NOT_CONFIGURED" }, 500)
  }

  let body: { text?: unknown; voice?: unknown; instructions?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, reason: "BAD_JSON" }, 400)
  }

  const text = typeof body.text === "string" ? body.text.trim() : ""
  const voiceRaw = typeof body.voice === "string" ? body.voice : "alloy"
  const instructions = typeof body.instructions === "string" ? body.instructions.slice(0, 2000) : ""

  if (!text) return c.json({ ok: false, reason: "EMPTY_TEXT" }, 400)
  if (text.length > 2000) return c.json({ ok: false, reason: "TEXT_TOO_LONG" }, 400)
  if (!ALLOWED_VOICES.includes(voiceRaw as Voice)) {
    return c.json({ ok: false, reason: "BAD_VOICE" }, 400)
  }
  const voice = voiceRaw as Voice

  const textHash = hashExampleText(`narration:${voice}:${instructions}:${text}`)
  const decision = await reserveTtsCall("narration", textHash)
  if (!decision.ok) {
    const status = decision.reason === "DAILY_BUDGET_EXCEEDED" ? 429 : 503
    return c.json({ ok: false, reason: decision.reason }, status)
  }

  let ttsRes: Response
  try {
    ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
        instructions: instructions || undefined,
        response_format: "mp3",
      }),
    })
  } catch (err) {
    await recordTtsFailure(textHash, `fetch threw: ${err instanceof Error ? err.message : String(err)}`)
    return c.json({ ok: false, reason: "OPENAI_FETCH_FAILED" }, 502)
  }

  if (!ttsRes.ok) {
    const errText = await ttsRes.text().catch(() => "")
    await recordTtsFailure(textHash, `http ${ttsRes.status}: ${errText.slice(0, 180)}`)
    console.error("NARRATION OPENAI ERROR:", ttsRes.status, errText.slice(0, 300))
    return c.json(
      { ok: false, reason: "OPENAI_ERROR", status: ttsRes.status, detail: errText.slice(0, 300) },
      502,
    )
  }

  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer())
  // 動画編集に取り込む前提なので raw mp3 を返す。
  // Next.js 側で base64 に包み直して client に渡す。
  return new Response(audioBuffer, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audioBuffer.byteLength),
    },
  })
})

export default narration
