import { Hono } from "hono"
import Stripe from "stripe"
import { getSupabase } from "../lib/supabase.js"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2026-03-25.dahlia",
})

const PRICE_IDS = {
  monthly: "price_1TM2anEAvnqttVka9rIBlaPM",
  yearly: "price_1TM2bJEAvnqttVkaQ2gc0Itm",
} as const

type PlanName = keyof typeof PRICE_IDS

function planFromPriceId(priceId: string | undefined | null): PlanName | null {
  if (!priceId) return null
  if (priceId === PRICE_IDS.monthly) return "monthly"
  if (priceId === PRICE_IDS.yearly) return "yearly"
  return null
}

function planFromSubscription(sub: Stripe.Subscription): PlanName | null {
  const priceId = sub.items.data[0]?.price?.id
  return planFromPriceId(priceId)
}

const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "https://www.rootlink.app"

const router = new Hono()

/* =========================
 * POST /stripe/checkout
 * Checkout Session を作成して URL を返す
 * Body: { priceId: "monthly" | "yearly", userId: string }
 * ========================= */
router.post("/checkout", async (c) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "")
    if (!token) return c.json({ ok: false, reason: "UNAUTHORIZED" }, 401)

    const supabase = getSupabase()
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return c.json({ ok: false, reason: "UNAUTHORIZED" }, 401)

    const body = await c.req.json()
    const plan = body.plan as "monthly" | "yearly"
    if (!plan || !PRICE_IDS[plan]) {
      return c.json({ ok: false, reason: "INVALID_PLAN" }, 400)
    }

    // フロントから渡されたoriginを優先（テスト環境対応）
    const origin = body.origin ?? FRONTEND_URL

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      success_url: `${origin}/premium/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/wordlist`,
      client_reference_id: user.id,
      metadata: { user_id: user.id, plan },
    })

    return c.json({ ok: true, url: session.url })
  } catch (error) {
    console.error("STRIPE CHECKOUT FAILED:", error)
    return c.json({ ok: false, reason: "INTERNAL_ERROR" }, 500)
  }
})

/* =========================
 * POST /stripe/portal
 * カスタマーポータルセッションを作成して URL を返す
 * Body: { origin?: string }
 * ========================= */
router.post("/portal", async (c) => {
  try {
    const token = c.req.header("Authorization")?.replace("Bearer ", "")
    if (!token) return c.json({ ok: false, reason: "UNAUTHORIZED" }, 401)

    const supabase = getSupabase()
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return c.json({ ok: false, reason: "UNAUTHORIZED" }, 401)

    const body = await c.req.json().catch(() => ({}))
    const origin = body.origin ?? FRONTEND_URL

    // subscriptions から stripe_customer_id を取得
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle()

    if (!sub?.stripe_customer_id) {
      return c.json({ ok: false, reason: "NO_SUBSCRIPTION" }, 404)
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${origin}/wordlist`,
    })

    return c.json({ ok: true, url: session.url })
  } catch (error) {
    console.error("STRIPE PORTAL FAILED:", error)
    return c.json({ ok: false, reason: "INTERNAL_ERROR" }, 500)
  }
})

/* =========================
 * POST /stripe/webhook
 * Stripe からのイベントを受け取り Supabase を更新する
 * ========================= */
router.post("/webhook", async (c) => {
  const sig = c.req.header("stripe-signature")
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  if (!sig || !webhookSecret) {
    return c.json({ ok: false, reason: "MISSING_SIGNATURE" }, 400)
  }

  let event: Stripe.Event
  try {
    const rawBody = await c.req.text()
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
  } catch (error) {
    console.error("STRIPE WEBHOOK SIGNATURE FAILED:", error)
    return c.json({ ok: false, reason: "INVALID_SIGNATURE" }, 400)
  }

  const supabase = getSupabase()

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.user_id
        if (!userId) break

        // Subscription を取得して price から plan を決定（metadata 非依存）
        const subscriptionId = session.subscription as string
        let plan: PlanName = "monthly"
        let status: string = "active"

        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId)
          plan = planFromSubscription(sub) ?? (session.metadata?.plan as PlanName) ?? "monthly"
          status = sub.status
        }

        await supabase.from("subscriptions").upsert(
          {
            user_id: userId,
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: subscriptionId,
            plan,
            status,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        console.log("SUBSCRIPTION ACTIVATED:", userId, plan, status)
        break
      }

      case "customer.subscription.deleted":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription
        const plan = planFromSubscription(sub)

        // Stripe の status をそのまま保存（active/trialing/past_due/canceled/...）
        // getUserPlan 側で premium 判定（['active','trialing']）を行う
        const update: Record<string, unknown> = {
          status: sub.status,
          updated_at: new Date().toISOString(),
        }
        if (plan) update.plan = plan

        await supabase
          .from("subscriptions")
          .update(update)
          .eq("stripe_subscription_id", sub.id)

        console.log("SUBSCRIPTION UPDATED:", sub.id, sub.status, plan ?? "(plan unchanged)")
        break
      }

      default:
        console.log("STRIPE WEBHOOK UNHANDLED:", event.type)
    }
  } catch (error) {
    console.error("STRIPE WEBHOOK HANDLER FAILED:", error)
    return c.json({ ok: false, reason: "HANDLER_ERROR" }, 500)
  }

  return c.json({ ok: true })
})

export default router
