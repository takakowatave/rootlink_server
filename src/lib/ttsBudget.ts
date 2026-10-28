import { createHash } from "node:crypto"
import { getSupabase } from "./supabase.js"

/**
 * ttsBudget.ts
 *
 * 例文音声 TTS (OpenAI gpt-4o-mini-tts) の暴走防止ゲート。
 * 日次 call 数カウンタと「同じテキストで失敗したら一定時間叩かない」の 2 本立て。
 *
 * なぜ必要か:
 * - deck_words.example の override が dictionary_cache と不整合で、ユーザー再生のたびに
 *   新 hash パスで TTS が走る可能性がある
 * - 公式デッキで override がある deck_word は ~5,000 件以上。全部が 1 日で叩かれる最悪ケースを塞ぐ
 * - OpenAI TTS は従量課金なので、Oxford 用の oxfordGuard と同じ思想で封じる
 *
 * やらないこと:
 * - 認証ユーザー単位の quota (今回は global cap)
 * - 複数 Cloud Run instance 間の race 完全防止 (bump が atomic なので課金は正しくカウントされるが、
 *   閾値ちょうどを超える瞬間に 1-2 件は余分に走りうる)
 */

/** TTS 本体を呼ぶ前に通すゲートが面倒を見るテキスト種別。 */
export type TtsBudgetKind = "word_example"

/** 1 日あたりの OpenAI 呼び出し上限。word_example は 1,500/day。 */
export const TTS_DAILY_LIMITS: Record<TtsBudgetKind, number> = {
  word_example: 1500,
}

/** 失敗した hash を再試行してよくなるまでの待機時間。 */
const FAILURE_COOLDOWN_HOURS = 6

/** sha256(trim(text)) の先頭 32 hex 文字 = 128bit。dedup には十分。 */
export function hashExampleText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 32)
}

/** JST 基準の YYYY-MM-DD。dailyNewWordQuota と揃える。 */
function currentPeriodDateJst(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 10)
}

export type BudgetDecision =
  | { ok: true }
  | { ok: false; reason: "DAILY_BUDGET_EXCEEDED" | "RECENT_FAILURE" }

/**
 * TTS を走らせて良いかを判定する。
 * - 失敗 cooldown に該当 → RECENT_FAILURE
 * - 日次上限を超えた → DAILY_BUDGET_EXCEEDED
 * - OK なら counter を +1 して true
 *
 * 「ファイルが既に Storage にある」ケースは呼び出し側で先に判定し、ここは呼ばない。
 */
export async function reserveTtsCall(
  kind: TtsBudgetKind,
  textHash: string,
): Promise<BudgetDecision> {
  if (await isInFailureCooldown(textHash)) {
    return { ok: false, reason: "RECENT_FAILURE" }
  }

  const limit = TTS_DAILY_LIMITS[kind]
  const supabase = getSupabase()
  try {
    const { data, error } = await supabase.rpc("bump_tts_counter", {
      p_date: currentPeriodDateJst(),
      p_kind: kind,
      p_limit: limit,
    })
    if (error) {
      console.error("TTS BUDGET BUMP FAILED:", error.message)
      // 失敗時は保守的に通す (正常運用で DB 落ちているなら TTS 側も失敗する)。
      return { ok: true }
    }
    const newCount = typeof data === "number" ? data : -1
    if (newCount < 0) {
      console.warn("TTS BUDGET EXCEEDED:", kind, "limit=", limit)
      return { ok: false, reason: "DAILY_BUDGET_EXCEEDED" }
    }
    return { ok: true }
  } catch (error) {
    console.error("TTS BUDGET BUMP THREW:", error)
    return { ok: true }
  }
}

/** 失敗を記録して 6 時間 cooldown にする。 */
export async function recordTtsFailure(
  textHash: string,
  reason: string,
): Promise<void> {
  try {
    const supabase = getSupabase()
    const retryAfter = new Date(Date.now() + FAILURE_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString()
    const { error } = await supabase
      .from("tts_failures")
      .upsert(
        {
          text_hash: textHash,
          reason: reason.slice(0, 200),
          failed_at: new Date().toISOString(),
          retry_after: retryAfter,
        },
        { onConflict: "text_hash" },
      )
    if (error) {
      console.error("TTS FAILURE RECORD FAILED:", error.message)
    }
  } catch (error) {
    console.error("TTS FAILURE RECORD THREW:", error)
  }
}

async function isInFailureCooldown(textHash: string): Promise<boolean> {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from("tts_failures")
      .select("retry_after")
      .eq("text_hash", textHash)
      .maybeSingle()
    if (error) {
      console.warn("TTS FAILURE READ failed, treating as not-cooldown:", error.message)
      return false
    }
    const row = data as { retry_after?: string } | null
    if (!row?.retry_after) return false
    return new Date(row.retry_after) > new Date()
  } catch (error) {
    console.warn("TTS FAILURE READ threw, treating as not-cooldown:", error)
    return false
  }
}
