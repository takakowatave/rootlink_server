import { Hono } from "hono";
import { supabase } from "../lib/supabaseClient";

const auth = new Hono();

auth.post("/signup", async (c) => {
  const { email, password } = await c.req.json();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ user: data.user });
});

auth.post("/login", async (c) => {
  const { email, password } = await c.req.json();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ session: data.session });
});

export default auth;
