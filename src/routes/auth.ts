import { Hono } from "hono";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const auth = new Hono();

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

export default auth;
