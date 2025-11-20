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

    // data.user が null のケース
    // → メールリンク方式ではあり得る（メール送信されただけ）
    if (!data.user) {
      console.log("[signup] email confirmation sent (user null)");
      return c.json({
        message: "確認メールを送信しました。メール内のリンクを開いて登録を完了してください。",
      });
    }

    // -------------------------
    // ★ supabase.auth.signUp が user を返した場合
    //    → ここで profiles に自動作成
    // -------------------------
    try {
      await supabase
        .from("profiles")
        .insert({
          id: data.user.id,
          email: data.user.email,
          username: data.user.email?.split("@")[0] ?? "",
          avatar_url: null,
        });

      console.log("[signup] profile created:", data.user.id);
    } catch (profileErr: any) {
      console.error("[signup] profile insert error:", profileErr.message);
      // profile の INSERT エラーは 500 にしない（ユーザー登録自体は成功しているため）
    }

    return c.json({
      user: {
        id: data.user.id,
        email: data.user.email,
      },
      message: "確認メールを送信しました。",
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

    return c.json({
      session: data.session,
      user: data.user,
    });
  } catch (err) {
    console.error("[login] unexpected error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// --- パスワード再設定メール送信 ---
auth.post("/reset", async (c) => {
  try {
    const { email } = await c.req.json();

    console.log("[password/reset] request:", email);

    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: "https://rootlink.vercel.app/password/update"
      // ← ローカルで動かすときは http://localhost:5173/password/update に変更して
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