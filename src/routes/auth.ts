import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL_ROOTLINK!,
  process.env.SUPABASE_SERVICE_ROLE_KEY_ROOTLINK!
);

const auth = new Hono();

// --- サインアップ（確認メールを自動送信）---
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

    console.log("[signup] confirmation mail sent:", email);

    return c.json({
      message: "確認メールを送信しました。メール内のリンクを開いて登録を完了してください。",
    });
  } catch (err) {
    console.error("[signup] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// --- ログイン（メール確認済みユーザーのみ成功）---
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

    console.log("[login] success:", data.user.email);
    return c.json({ session: data.session, user: data.user });
  } catch (err) {
    console.error("[login] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

export default auth;
