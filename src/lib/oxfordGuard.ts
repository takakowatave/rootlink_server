import { getSupabase } from "./supabase.js"

/**
 * oxfordGuard.ts
 *
 * 責務:
 * - Oxford API の月次コール数を数え、上限を超えたら叩かせない
 * - 検索失敗（該当なし・スペル補正結果）をキャッシュし、同じ入力での再課金を防ぐ
 *
 * 背景:
 * Oxford API Lite は無料枠 5,000 call/月、超過は £0.05/call で青天井に課金される。
 * 超過しても 429 は返ってこないため、ベンダー側のエラーをブレーキにできない。
 * ここで自前に数えて止める。
 *
 * やらないこと:
 * - Oxford のレスポンス解釈（resolveQuery.ts の責務）
 */

/* =========================
   設定
========================= */

/** 月あたりに許可する Oxford コール数。無料枠 5,000 に対して余裕を持たせる。 */
const MONTHLY_CALL_LIMIT = Number(
  process.env.OXFORD_MONTHLY_CALL_LIMIT ?? 4500
)

/** ネガティブキャッシュの保持時間。 */
const NEGATIVE_TTL_HOURS = Number(
  process.env.RESOLVE_NEGATIVE_TTL_HOURS ?? 24 * 7
)

/** 使用量を DB から読み直す間隔。1コールごとに SELECT しないための緩衝。 */
const USAGE_REFRESH_MS = 30_000

/**
 * DB が読めないときに 1 インスタンスが暴走しないための保険。
 * プロセス起動からの累計コール数がこれを超えたら、DB の値に関わらず止める。
 */
const PROCESS_CALL_CEILING = Number(
  process.env.OXFORD_PROCESS_CALL_CEILING ?? 2000
)

/* =========================
   エラー
========================= */

/** 月次上限に達したため Oxford を呼ばなかったことを示す。 */
export class OxfordBudgetExceededError extends Error {
  readonly used: number
  readonly limit: number

  constructor(used: number, limit: number) {
    super("OXFORD_BUDGET_EXCEEDED")
    this.name = "OxfordBudgetExceededError"
    this.used = used
    this.limit = limit
  }
}

/* =========================
   月次コール数
========================= */

type UsageSnapshot = {
  calls: number
  readAt: number
}

let usageSnapshot: UsageSnapshot | null = null
let processCalls = 0

function currentMonth(): string {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, "0")
  return `${year}-${month}-01`
}

/** DB から当月のコール数を読む。読めなければ null。 */
async function readUsageFromDb(): Promise<number | null> {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from("oxford_api_usage")
      .select("calls")
      .eq("month", currentMonth())
      .maybeSingle()

    if (error) {
      console.error("OXFORD USAGE READ FAILED:", error.message)
      return null
    }

    const calls = (data as { calls?: unknown } | null)?.calls
    return typeof calls === "number" ? calls : 0
  } catch (error) {
    console.error("OXFORD USAGE READ THREW:", error)
    return null
  }
}

/**
 * Oxford を叩いてよいか判定する。
 * 上限に達している場合は OxfordBudgetExceededError を投げる。
 */
export async function assertOxfordBudget(): Promise<void> {
  if (processCalls >= PROCESS_CALL_CEILING) {
    console.error("OXFORD PROCESS CEILING HIT:", processCalls)
    throw new OxfordBudgetExceededError(processCalls, PROCESS_CALL_CEILING)
  }

  const fresh =
    usageSnapshot !== null && Date.now() - usageSnapshot.readAt < USAGE_REFRESH_MS

  if (!fresh) {
    const calls = await readUsageFromDb()
    if (calls !== null) {
      usageSnapshot = { calls, readAt: Date.now() }
    }
  }

  // DB が一度も読めていない場合は判断材料がないので通す。
  // その場合も PROCESS_CALL_CEILING が上限として効く。
  if (usageSnapshot === null) return

  if (usageSnapshot.calls >= MONTHLY_CALL_LIMIT) {
    console.error(
      "OXFORD BUDGET EXCEEDED:",
      usageSnapshot.calls,
      "/",
      MONTHLY_CALL_LIMIT
    )
    throw new OxfordBudgetExceededError(usageSnapshot.calls, MONTHLY_CALL_LIMIT)
  }
}

/** Oxford を実際に叩いた回数を記録する。失敗レスポンスも 1 コールとして数える。 */
export async function recordOxfordCall(count = 1): Promise<void> {
  processCalls += count

  // ローカルの見積もりを先に進める。DB 反映が遅れても上限を踏み越えにくくする。
  if (usageSnapshot) {
    usageSnapshot = {
      calls: usageSnapshot.calls + count,
      readAt: usageSnapshot.readAt,
    }
  }

  try {
    const supabase = getSupabase()
    const { data, error } = await supabase.rpc("increment_oxford_calls", {
      p_calls: count,
    })

    if (error) {
      console.error("OXFORD USAGE INCREMENT FAILED:", error.message)
      return
    }

    if (typeof data === "number") {
      usageSnapshot = { calls: data, readAt: Date.now() }
    }
  } catch (error) {
    console.error("OXFORD USAGE INCREMENT THREW:", error)
  }
}

/**
 * 上限チェック → 実行 → コール数記録 をまとめる。
 * 例外が出ても「叩いた」事実は記録する。
 */
export async function withOxfordBudget<T>(fn: () => Promise<T>): Promise<T> {
  await assertOxfordBudget()
  try {
    return await fn()
  } finally {
    await recordOxfordCall(1)
  }
}

/** 監視・管理用に当月の使用状況を返す。 */
export async function getOxfordUsage(): Promise<{
  month: string
  calls: number | null
  limit: number
}> {
  const calls = await readUsageFromDb()
  if (calls !== null) usageSnapshot = { calls, readAt: Date.now() }
  return { month: currentMonth(), calls, limit: MONTHLY_CALL_LIMIT }
}

/* =========================
   ネガティブキャッシュ
========================= */

export type NegativeOutcome = "no_result" | "corrected"

export type NegativeEntry = {
  outcome: NegativeOutcome
  /** outcome が "corrected" のときのみ、補正後の語。 */
  resolvedTo: string | null
}

/**
 * 有効期限内のネガティブキャッシュを返す。
 * ヒットした場合、呼び出し側は Oxford も OpenAI も叩いてはいけない。
 */
export async function getNegativeEntry(
  query: string
): Promise<NegativeEntry | null> {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from("resolve_negative_cache")
      .select("outcome, resolved_to, expires_at")
      .eq("query", query)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle()

    if (error) {
      console.error("NEGATIVE CACHE READ FAILED:", error.message)
      return null
    }
    if (!data) return null

    const row = data as { outcome?: unknown; resolved_to?: unknown }
    const outcome = row.outcome

    if (outcome !== "no_result" && outcome !== "corrected") return null

    return {
      outcome,
      resolvedTo:
        typeof row.resolved_to === "string" && row.resolved_to.length > 0
          ? row.resolved_to
          : null,
    }
  } catch (error) {
    console.error("NEGATIVE CACHE READ THREW:", error)
    return null
  }
}

/**
 * 検索失敗（または補正結果）を記録する。
 * ここに書いた入力は TTL の間 Oxford を叩かない。
 */
export async function saveNegativeEntry(
  query: string,
  outcome: NegativeOutcome,
  resolvedTo: string | null = null
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + NEGATIVE_TTL_HOURS * 60 * 60 * 1000
  ).toISOString()

  try {
    const supabase = getSupabase()
    const { error } = await supabase.from("resolve_negative_cache").upsert(
      {
        query,
        outcome,
        resolved_to: resolvedTo,
        expires_at: expiresAt,
      },
      { onConflict: "query" }
    )

    if (error) {
      console.error("NEGATIVE CACHE SAVE FAILED:", error.message)
      return
    }

    console.log("NEGATIVE CACHE SAVED:", query, outcome, resolvedTo ?? "")
  } catch (error) {
    console.error("NEGATIVE CACHE SAVE THREW:", error)
  }
}

/** ヒット回数を加算する（監視用・失敗しても無視してよい）。 */
export async function bumpNegativeHit(query: string): Promise<void> {
  try {
    const supabase = getSupabase()
    await supabase.rpc("increment_negative_hit", { p_query: query })
  } catch {
    // 監視用途のみ。失敗しても検索フローに影響させない。
  }
}
