import { getSupabase } from "./supabase.js"

/**
 * dailyNewWordQuota.ts
 *
 * App Store Guideline 5.1.1(v) 対応で、ネイティブも登録なしで使い始められるようにした。
 * 代わりに「dictionary_cache に無い新しい単語」の検索を、認証ユーザー単位・日次で数え、
 * 無料枠 (`DAILY_FREE_QUOTA`) に達したら 429 を返す。
 *
 * 対象:
 * - 認証あり & 非 premium のみ
 * - 認証なし / premium は呼ばない
 *
 * 判定順:
 * 1. プリチェック (resolveQuery を回す前)。既に閾値 >= なら 429
 * 2. resolveQuery 完了後、cache miss なら +1 加算 (bumpNewWordSearchCount)
 *
 * やらないこと:
 * - cache hit のカウント (= Oxford/OpenAI を叩いていない検索はコスト対象外)
 * - 認証なしの IP 単位カウント (既存 rateLimit が担当)
 */

export const DAILY_FREE_QUOTA = 20

/** JST 基準の YYYY-MM-DD。カウント境界を日本時間 00:00 に合わせる。 */
function currentPeriodDateJst(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().slice(0, 10)
}

export async function getDailyNewWordCount(userId: string): Promise<number> {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from("daily_new_word_searches")
      .select("count")
      .eq("user_id", userId)
      .eq("period_date", currentPeriodDateJst())
      .maybeSingle()
    if (error) {
      console.error("DAILY QUOTA READ FAILED:", error.message)
      return 0
    }
    const count = (data as { count?: unknown } | null)?.count
    return typeof count === "number" ? count : 0
  } catch (error) {
    console.error("DAILY QUOTA READ THREW:", error)
    return 0
  }
}

/** +1 加算して加算後の値を返す。 */
export async function bumpDailyNewWordCount(userId: string): Promise<number> {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase.rpc("bump_new_word_search", {
      p_user_id: userId,
      p_period_date: currentPeriodDateJst(),
    })
    if (error) {
      console.error("DAILY QUOTA BUMP FAILED:", error.message)
      return 0
    }
    return typeof data === "number" ? data : 0
  } catch (error) {
    console.error("DAILY QUOTA BUMP THREW:", error)
    return 0
  }
}

/**
 * 認証ユーザーの premium 判定。
 * - profiles.is_tester = true → premium
 * - subscriptions.status が active / trialing → premium
 */
export async function isPremiumUser(userId: string): Promise<boolean> {
  try {
    const supabase = getSupabase()
    const [profileRes, subRes] = await Promise.all([
      supabase.from("profiles").select("is_tester").eq("id", userId).maybeSingle(),
      supabase.from("subscriptions").select("status").eq("user_id", userId).maybeSingle(),
    ])
    const profile = profileRes.data as { is_tester?: unknown } | null
    if (profile?.is_tester === true) return true
    const sub = subRes.data as { status?: unknown } | null
    return sub?.status === "active" || sub?.status === "trialing"
  } catch (error) {
    console.error("PREMIUM CHECK THREW:", error)
    return false
  }
}
