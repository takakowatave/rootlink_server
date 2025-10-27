import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import auth from "./routes/auth.js";
const app = new Hono();
// ✅ 1. CORS を最上部で適用（OPTIONSも含めて必ず通るように）
app.use("/*", cors({
    origin: (origin) => {
        if (!origin)
            return "*"; // 一旦 * で全許可（検証用）
        if (origin.endsWith(".vercel.app"))
            return origin;
        if (origin === "http://localhost:5173")
            return origin;
        if (origin === "https://rootlink.vercel.app")
            return origin;
        if (origin === "https://www.rootlink.jp")
            return origin;
        return "*";
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
}));
// ✅ 2. 明示的に OPTIONS を処理
app.options("/chat", (c) => c.newResponse("ok", 204));
app.options("*", (c) => c.newResponse("ok", 204));
// ✅ 3. ヘルスチェック
app.get("/", (c) => c.text("OK"));
// ✅ Authルート
app.route("/auth", auth);
// ✅ Chat API
app.post("/chat", async (c) => {
    const { message } = await c.req.json();
    const prompt = `
次の英単語「${message}」について、日本語で以下の形式のJSONを返してください。
{
  "main": { "word": "", "meaning": "", "partOfSpeech": [], "pronunciation": "", "example": "", "translation": "" }
}`;
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
            }),
        });
        const data = await response.json();
        const cleaned = data?.choices?.[0]?.message?.content
            ?.replace(/```json|```/g, "")
            ?.trim();
        return c.json(JSON.parse(cleaned));
    }
    catch (err) {
        console.error("🔥 OpenAI fetch error:", err);
        return c.json({ error: "OpenAI fetch failed" }, 500);
    }
});
// ✅ Cloud Run 用ポート設定
const port = Number(process.env.PORT) || 8080;
serve({ fetch: app.fetch, port });
console.log(`🚀 RootLink Server running on port ${port}`);
