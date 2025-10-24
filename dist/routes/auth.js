import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY // ✅ 管理者用キー
);
const auth = new Hono();
// --- サインアップ ---
auth.post("/signup", async (c) => {
    const { email, password } = await c.req.json();
    const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (error)
        return c.json({ error: error.message }, 400);
    return c.json({ user: data.user });
});
// --- ログイン ---
auth.post("/login", async (c) => {
    const { email, password } = await c.req.json();
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });
    if (error)
        return c.json({ error: error.message }, 400);
    return c.json({ session: data.session });
});
export default auth;
