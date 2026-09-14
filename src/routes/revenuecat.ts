import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"
import { getSupabase } from "../lib/supabase.js"

/**
 * RevenueCat Webhook
 * ==================
 * RevenueCat Dashboard → Integrations → Webhooks に URL と Authorization ヘッダー値を登録する。
 * 認証は shared secret を Authorization: Bearer <secret> で受け取り、`REVENUECAT_WEBHOOK_SECRET`
 * と一致するかで検証する（RevenueCat 側の推奨方式）。
 *
 * plan (monthly/yearly) は product_id と env vars を照合して決定する:
 *  - REVENUECAT_PRODUCT_MONTHLY : カンマ区切りで iOS/Android の product identifier を並べる
 *  - REVENUECAT_PRODUCT_YEARLY  : 同上
 * 一致しない場合は既存 plan を保ち、判定不能な新規購入は 'monthly' フォールバック。
 */

type PlanName = "monthly" | "yearly"
type Store = "app_store" | "play_store" | "stripe"

type RevenueCatEventType =
  | "INITIAL_PURCHASE"
  | "RENEWAL"
  | "UNCANCELLATION"
  | "CANCELLATION"
  | "EXPIRATION"
  | "BILLING_ISSUE"
  | "SUBSCRIPTION_PAUSED"
  | "PRODUCT_CHANGE"
  | "TRANSFER"
  | "NON_RENEWING_PURCHASE"
  | "SUBSCRIBER_ALIAS"
  | "REFUND"
  | "TEST"

type RevenueCatEvent = {
  type: RevenueCatEventType
  app_user_id?: string
  original_app_user_id?: string
  transferred_to?: string[]
  transferred_from?: string[]
  product_id?: string
  store?: string
  environment?: "SANDBOX" | "PRODUCTION"
  purchased_at_ms?: number
  expiration_at_ms?: number
  period_type?: "TRIAL" | "INTRO" | "NORMAL"
  entitlement_ids?: string[] | null
}

type WebhookBody = {
  event?: RevenueCatEvent
  api_version?: string
}

function parseProductList(env: string | undefined): Set<string> {
  if (!env) return new Set()
  return new Set(env.split(",").map((s) => s.trim()).filter(Boolean))
}

function planFromProductId(productId: string | undefined | null): PlanName | null {
  if (!productId) return null
  const monthly = parseProductList(process.env.REVENUECAT_PRODUCT_MONTHLY)
  const yearly = parseProductList(process.env.REVENUECAT_PRODUCT_YEARLY)
  if (monthly.has(productId)) return "monthly"
  if (yearly.has(productId)) return "yearly"
  // フォールバック: 文字列に yearly/annual が含まれれば yearly、それ以外は monthly
  const lower = productId.toLowerCase()
  if (lower.includes("year") || lower.includes("annual")) return "yearly"
  if (lower.includes("month")) return "monthly"
  return null
}

function normalizeStore(raw: string | undefined | null): Store | null {
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (upper === "APP_STORE") return "app_store"
  if (upper === "PLAY_STORE") return "play_store"
  if (upper === "STRIPE") return "stripe"
  return null
}

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

const router = new Hono()

router.post("/webhook", async (c) => {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET
  const auth = c.req.header("Authorization")
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : auth

  if (!secret) {
    console.error("REVENUECAT WEBHOOK: secret not configured")
    return c.json({ ok: false, reason: "MISCONFIGURED" }, 500)
  }
  if (!provided || !secretsMatch(provided, secret)) {
    return c.json({ ok: false, reason: "UNAUTHORIZED" }, 401)
  }

  let body: WebhookBody
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, reason: "INVALID_BODY" }, 400)
  }

  const event = body.event
  if (!event?.type) {
    return c.json({ ok: false, reason: "INVALID_EVENT" }, 400)
  }

  const supabase = getSupabase()
  const userId = event.app_user_id ?? event.original_app_user_id

  try {
    switch (event.type) {
      case "TEST": {
        console.log("REVENUECAT WEBHOOK TEST OK")
        return c.json({ ok: true })
      }

      case "TRANSFER": {
        // ユーザー間で subscription が移った (RC の app_user_id 変更)
        const from = event.transferred_from?.[0]
        const to = event.transferred_to?.[0]
        if (!from || !to) break
        await supabase
          .from("subscriptions")
          .update({ user_id: to, updated_at: new Date().toISOString() })
          .eq("user_id", from)
        console.log("REVENUECAT SUBSCRIPTION TRANSFERRED:", from, "->", to)
        break
      }

      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELLATION":
      case "PRODUCT_CHANGE": {
        if (!userId) break
        const plan = planFromProductId(event.product_id) ?? "monthly"
        const store = normalizeStore(event.store)
        const expiresAt = event.expiration_at_ms
          ? new Date(event.expiration_at_ms).toISOString()
          : null

        // period_type=TRIAL は INITIAL_PURCHASE でのみ来る。RENEWAL は trial→paid 変換後なので常に active
        const status =
          event.type === "INITIAL_PURCHASE" && event.period_type === "TRIAL"
            ? "trialing"
            : "active"

        // trial_used は monotonic (一度 true にしたら不可逆)。
        // Apple/Google の intro offer eligibility は period_type 問わず初回購入で消費されるため、
        // positive イベント全部で true を書く (webhook 順序ズレへの防御)。
        await supabase.from("subscriptions").upsert(
          {
            user_id: userId,
            plan,
            status,
            store,
            revenuecat_product_id: event.product_id ?? null,
            expires_at: expiresAt,
            trial_used: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        console.log(
          "REVENUECAT SUBSCRIPTION ACTIVATED:",
          userId,
          plan,
          store,
          status,
          event.type
        )
        break
      }

      case "CANCELLATION": {
        // ユーザーが解約意思表示。期限までは有効なので status は active のまま。
        // 期限だけ更新しておく。
        // 既知のトレードオフ: EXPIRATION webhook が届くまで getUserPlan は premium を返し続ける。
        // RC の3日リトライで実務上は問題ないが、「解約したのにまだ使える」調査時はここが起点。
        if (!userId) break
        const expiresAt = event.expiration_at_ms
          ? new Date(event.expiration_at_ms).toISOString()
          : null
        await supabase
          .from("subscriptions")
          .update({
            expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
        console.log("REVENUECAT SUBSCRIPTION CANCEL SCHEDULED:", userId)
        break
      }

      case "EXPIRATION": {
        if (!userId) break
        await supabase
          .from("subscriptions")
          .update({
            status: "expired",
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
        console.log("REVENUECAT SUBSCRIPTION EXPIRED:", userId)
        break
      }

      case "REFUND": {
        // 返金は Apple/Google 側で処理され、entitlement は即 revoke される。
        // status='expired' + expires_at=now() で即失効させる。
        if (!userId) break
        await supabase
          .from("subscriptions")
          .update({
            status: "expired",
            expires_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
        console.log("REVENUECAT SUBSCRIPTION REFUNDED:", userId)
        break
      }

      case "BILLING_ISSUE": {
        if (!userId) break
        await supabase
          .from("subscriptions")
          .update({
            status: "past_due",
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
        console.log("REVENUECAT SUBSCRIPTION BILLING_ISSUE:", userId)
        break
      }

      case "SUBSCRIPTION_PAUSED": {
        if (!userId) break
        await supabase
          .from("subscriptions")
          .update({
            status: "paused",
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
        console.log("REVENUECAT SUBSCRIPTION PAUSED:", userId)
        break
      }

      default:
        console.log("REVENUECAT WEBHOOK UNHANDLED:", event.type)
    }
  } catch (error) {
    console.error("REVENUECAT WEBHOOK HANDLER FAILED:", error)
    return c.json({ ok: false, reason: "HANDLER_ERROR" }, 500)
  }

  return c.json({ ok: true })
})

export default router
