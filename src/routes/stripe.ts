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

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      success_url: `${FRONTEND_URL}/premium/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/wordlist`,
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
        const plan = session.metadata?.plan
        if (!userId) break

        await supabase.from("subscriptions").upsert(
          {
            user_id: userId,
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
            plan: plan ?? "monthly",
            status: "active",
          },
          { onConflict: "user_id" }
        )
        console.log("SUBSCRIPTION ACTIVATED:", userId)
        break
      }

      case "customer.subscription.deleted":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription
        const status = sub.status === "active" ? "active" : "canceled"

        await supabase
          .from("subscriptions")
          .update({ status, updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", sub.id)

        console.log("SUBSCRIPTION UPDATED:", sub.id, status)
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
