import { Hono } from "hono";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getSupabase as getServiceSupabase } from "../lib/supabase.js";
import { sendEmail, renderAccountDeletedEmail } from "../lib/sendEmail.js";

const auth = new Hono();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2026-03-25.dahlia",
});

/**
 * Supabase client（遅延初期化）
 * import 時には何もしない
 */
let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    const url = process.env.SUPABASE_URL_ROOTLINK;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ROOTLINK;

    if (!url || !key) {
      throw new Error(
        "Missing SUPABASE_URL_ROOTLINK or SUPABASE_SERVICE_ROLE_KEY_ROOTLINK"
      );
    }

    supabase = createClient(url, key);
  }

  return supabase;
}

/* ==============================
 * 1. サインアップ（確認メール送信）
 * ============================== */
auth.post("/signup", async (c) => {
  try {
    const { email, password } = await c.req.json();
    const supabase = getSupabase();

    const { error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      return c.json({ error: error.message }, 400);
    }

    return c.json({
      message:
        "確認メールを送信しました。メール内のリンクを開いて登録を完了してください。",
    });
  } catch (err) {
    console.error("[signup] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

/* ==============================
 * 2. ログイン + プロフィール自動作成
 * ============================== */
auth.post("/login", async (c) => {
  try {
    const { email, password } = await c.req.json();
    const supabase = getSupabase();

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return c.json({ error: error.message }, 400);
    }

    const user = data.user;

    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (!existing) {
      const { error: insertError } = await supabase
        .from("profiles")
        .insert({
          id: user.id,
          email: user.email,
          username: (user.email ?? "").split("@")[0],
          avatar_url: null,
        });

      if (insertError) {
        console.error(
          "[login] profile creation error:",
          insertError.message
        );
      }
    }

    return c.json({
      session: data.session,
      user,
    });
  } catch (err) {
    console.error("[login] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

/* ==============================
 * 3. パスワード再設定メール送信
 * ============================== */
auth.post("/reset", async (c) => {
  try {
    const { email } = await c.req.json();
    const supabase = getSupabase();

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo:
        process.env.NODE_ENV === "production"
          ? "https://rootlink.vercel.app/password/update"
          : "http://localhost:5173/password/update",
    });

    if (error) {
      return c.json({ error: error.message }, 400);
    }

    return c.json({ message: "OK" });
  } catch (err) {
    console.error("[password/reset] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

/* ==============================
 * 4. アカウント削除（退会）
 *   - active な Stripe subscription があれば先に解約
 *   - Storage の avatars/{userId}/* を削除
 *   - auth.users を削除 → 関連テーブルは CASCADE で消える
 *   - 完了メールを Resend 経由で送信（削除前に email を退避）
 * ============================== */
auth.post("/delete", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ ok: false, reason: "UNAUTHORIZED" }, 401);

  const supabase = getServiceSupabase();
  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes.user) {
    return c.json({ ok: false, reason: "UNAUTHORIZED" }, 401);
  }
  const user = userRes.user;
  const userId = user.id;
  const email = user.email ?? "";

  try {
    // 1. Stripe subscription 解約（あれば）
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_subscription_id, status")
      .eq("user_id", userId)
      .maybeSingle();

    if (
      sub?.stripe_subscription_id &&
      sub.status !== "canceled" &&
      sub.status !== "incomplete_expired"
    ) {
      try {
        await stripe.subscriptions.cancel(sub.stripe_subscription_id);
        console.log("[account/delete] cancelled subscription:", sub.stripe_subscription_id);
      } catch (err) {
        console.error("[account/delete] stripe cancel failed:", err);
        return c.json({ ok: false, reason: "STRIPE_CANCEL_FAILED" }, 500);
      }
    }

    // 2. Storage: avatars/{userId}/* を削除
    try {
      const { data: files } = await supabase.storage
        .from("avatars")
        .list(userId);
      if (files && files.length > 0) {
        const paths = files.map((f) => `${userId}/${f.name}`);
        await supabase.storage.from("avatars").remove(paths);
      }
    } catch (err) {
      // Storage 削除失敗は致命的ではないので警告のみ
      console.warn("[account/delete] avatar cleanup failed:", err);
    }

    // 3. auth.users を削除 → CASCADE で関連データも消える
    const { error: deleteErr } = await supabase.auth.admin.deleteUser(userId);
    if (deleteErr) {
      console.error("[account/delete] auth.admin.deleteUser failed:", deleteErr);
      return c.json({ ok: false, reason: "DELETE_FAILED" }, 500);
    }

    // 4. 退会完了メール送信（失敗しても退会自体は成功として返す）
    if (email) {
      const { subject, html } = renderAccountDeletedEmail(email);
      await sendEmail({ to: email, subject, html }).catch((err) => {
        console.error("[account/delete] confirmation email failed:", err);
      });
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[account/delete] unexpected error:", err);
    return c.json({ ok: false, reason: "INTERNAL_ERROR" }, 500);
  }
});

export default auth;
