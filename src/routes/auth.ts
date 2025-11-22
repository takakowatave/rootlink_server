// src/routes/auth.ts
import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL_ROOTLINK!,
  process.env.SUPABASE_SERVICE_ROLE_KEY_ROOTLINK!
);

const auth = new Hono();

// ==============================
//  1. サインアップ（確認メール送信のみ）
// ==============================
auth.post("/signup", async (c) => {
  try {
    const { email, password } = await c.req.json();
    console.log("[signup] received:", email);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      console.error("[signup] signUp error:", error.message);
      return c.json({ error: error.message }, 400);
    }

    console.log("[signup] confirmation email sent");
    console.log("SERVICE ROLE KEY:", process.env.SUPABASE_SERVICE_ROLE_KEY_ROOTLINK?.slice(0,10));

    return c.json({
      message:
        "確認メールを送信しました。メール内のリンクを開いて登録を完了してください。",
    });
  } catch (err) {
    console.error("[signup] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// ==============================
//  2. ログイン（メール確認後）＋ プロフィール自動作成
// ==============================
auth.post("/login", async (c) => {
  try {
    const { email, password } = await c.req.json();

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.error("[login] error:", error.message);
      return c.json({ error: error.message }, 400);
    }

    const user = data.user;

    // ---- プロフィール存在チェック ----
    const { data: existing } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    // ---- 初回ログインなら profile を自動作成 ----
    if (!existing) {
      console.log("[login] creating profile:", user.id);

      await supabase.from("profiles").insert({
        id: user.id,
        email: user.email,
        username: (user.email ?? "").split("@")[0],
        avatar_url: null,
      });
    }

    console.log("[login] success:", user.email);

    return c.json({
      session: data.session,
      user,
    });
  } catch (err) {
    console.error("[login] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// ==============================
//  3. パスワード再設定メール送信
// ==============================
auth.post("/reset", async (c) => {
  try {
    const { email } = await c.req.json();

    console.log("[password/reset] request:", email);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: process.env.NODE_ENV === "production"
        ? "https://rootlink.vercel.app/password/update"
        : "http://localhost:5173/password/update",
    });

    if (error) {
      console.error("[password/reset] error:", error.message);
      return c.json({ error: error.message }, 400);
    }

    return c.json({ message: "OK" });
  } catch (err) {
    console.error("[password/reset] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

export default auth;
