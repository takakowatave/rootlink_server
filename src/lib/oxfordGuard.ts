import { getSupabase } from "./supabase.js"
import { sendEmail } from "./sendEmail.js"

/**
 * oxfordGuard.ts
 *
 * 責務:
 * - Oxford API の月次コール数を数え、上限を超えたら叩かせない
 * - 閾値（50% / 80% / 100%）を跨いだ時点でメール通知する
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

/**
 * 月あたりに許可する Oxford コール数。
 * 既定は無料枠と同じ 5,000。ここに達したら Oxford を一切叩かない。
 * 実需は月 200 コール程度（新規語 週10〜20語 × 最大2コール）なので、
 * 通常運転で上限に当たることはない。当たったら異常が起きている。
 * 環境変数 OXFORD_MONTHLY_CALL_LIMIT で上書きする。
 */
const MONTHLY_CALL_LIMIT = Number(
  process.env.OXFORD_MONTHLY_CALL_LIMIT ?? 5000
)

/** ネガティブキャッシュの保持時間。 */
const NEGATIVE_TTL_HOURS = Number(
  process.env.RESOLVE_NEGATIVE_TTL_HOURS ?? 24 * 7
)

/** 閾値通知の送り先。未設定なら通知しない（コール自体は通常どおり動く）。 */
const ALERT_EMAIL = process.env.OXFORD_ALERT_EMAIL ?? ""

/** 通知を出すレベル（上限に対する割合）。 */
const ALERT_LEVELS = [50, 80, 100] as const

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

let processCalls = 0

/**
 * Oxford の請求期間はリセット日（既定20日）始まり。
 * 暦月で数えると境界が20日ずれ、上限が実際の請求と噛み合わない。
 */
const BILLING_RESET_DAY = Number(process.env.OXFORD_BILLING_RESET_DAY ?? 20)

function currentPeriodStart(): string {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const day = now.getUTCDate()

  const start =
    day >= BILLING_RESET_DAY
      ? new Date(Date.UTC(year, month, BILLING_RESET_DAY))
      : new Date(Date.UTC(year, month - 1, BILLING_RESET_DAY))

  return start.toISOString().slice(0, 10)
}

/**
 * コールを1件「予約」して、加算後の当月合計を返す。
 *
 * 数えてから撃つ。逆にしない。加算できなかったコールは撃たせない。
 * 「叩いたが数えられていない」状態を作らないことが、この関数の存在理由。
 */
async function reserveCall(): Promise<number> {
  const supabase = getSupabase()
  const { data, error } = await supabase.rpc("reserve_oxford_call", {
    p_period_start: currentPeriodStart(),
    p_calls: 1,
  })

  if (error) throw new Error(`OXFORD_RESERVE_FAILED: ${error.message}`)
  if (typeof data !== "number") throw new Error("OXFORD_RESERVE_FAILED: no count")

  return data
}

/** 閾値を跨いだらメールを送る。送信権はDB側でアトミックに1インスタンスだけが取る。 */
async function notifyIfThresholdCrossed(total: number): Promise<void> {
  if (!ALERT_EMAIL) return

  // 到達した最大レベルを1つだけ扱う（50と80を同時に跨いでも1通）。
  const ratio = (total / MONTHLY_CALL_LIMIT) * 100
  const reached = [...ALERT_LEVELS].reverse().find((level) => ratio >= level)
  if (!reached) return

  try {
    const supabase = getSupabase()
    const { data, error } = await supabase.rpc("claim_oxford_notice", {
      p_period_start: currentPeriodStart(),
      p_level: reached,
    })
    if (error || data !== true) return

    const subject =
      reached >= 100
        ? `[RootLink] Oxford API の月次上限に到達しました (${total}/${MONTHLY_CALL_LIMIT})`
        : `[RootLink] Oxford API のコール数が ${reached}% に到達しました (${total}/${MONTHLY_CALL_LIMIT})`

    const body =
      reached >= 100
        ? "上限に達したため、キャッシュに無い語の検索は停止しています。キャッシュ済みの語は通常どおり返ります。"
        : "上限に近づいています。想定外の流入が無いか確認してください。"

    await sendEmail({
      to: ALERT_EMAIL,
      subject,
      html: `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;color:#111;line-height:1.7;">
<div style="max-width:480px;margin:0 auto;padding:32px 24px;">
<h2 style="font-size:18px;margin:0 0 16px;">Oxford API 使用量アラート</h2>
<p style="font-size:14px;margin:0 0 12px;">期間開始: <strong>${currentPeriodStart()}</strong><br>
コール数: <strong>${total}</strong> / ${MONTHLY_CALL_LIMIT}（${Math.round(ratio)}%）</p>
<p style="font-size:14px;margin:0 0 12px;">${body}</p>
<p style="font-size:13px;color:#666;margin:16px 0 0;">
上限は環境変数 OXFORD_MONTHLY_CALL_LIMIT で変更できます。</p>
</div></body></html>`,
    })

    console.log("OXFORD ALERT SENT:", reached, total, "/", MONTHLY_CALL_LIMIT)
  } catch (error) {
    // 通知の失敗で検索を止めない。上限そのものは別で効いている。
    console.error("OXFORD ALERT FAILED:", error)
  }
}

/**
 * 上限チェック → コール数の予約 → 実行。
 *
 * 予約に失敗した場合は Oxford を呼ばない。
 * 数えられないコールを撃つのが、これまでの請求の原因だったため。
 */
export async function withOxfordBudget<T>(fn: () => Promise<T>): Promise<T> {
  if (processCalls >= PROCESS_CALL_CEILING) {
    console.error("OXFORD PROCESS CEILING HIT:", processCalls)
    throw new OxfordBudgetExceededError(processCalls, PROCESS_CALL_CEILING)
  }

  let total: number
  try {
    total = await reserveCall()
  } catch (error) {
    console.error("OXFORD RESERVE FAILED, BLOCKING CALL:", error)
    throw new OxfordBudgetExceededError(-1, MONTHLY_CALL_LIMIT)
  }

  processCalls += 1

  await notifyIfThresholdCrossed(total)

  if (total > MONTHLY_CALL_LIMIT) {
    console.error("OXFORD BUDGET EXCEEDED:", total, "/", MONTHLY_CALL_LIMIT)
    throw new OxfordBudgetExceededError(total, MONTHLY_CALL_LIMIT)
  }

  return fn()
}

/** 当月の使用状況を返す。監視・確認用。 */
export async function getOxfordUsage(): Promise<{
  periodStart: string
  calls: number
  limit: number
}> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from("oxford_api_usage")
    .select("calls")
    .eq("period_start", currentPeriodStart())
    .maybeSingle()

  if (error) throw new Error(error.message)

  const calls = (data as { calls?: unknown } | null)?.calls
  return {
    periodStart: currentPeriodStart(),
    calls: typeof calls === "number" ? calls : 0,
    limit: MONTHLY_CALL_LIMIT,
  }
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
