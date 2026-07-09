import type { Context, Next } from "hono";

/**
 * 軽量なインメモリ・レート制限ミドルウェア。
 * /resolve は認証不要のまま公開しているため、IP単位で単純に上限を設けて
 * 有料API（Oxford / OpenAI）の無制限な呼び出し（コスト悪用）を抑止する。
 *
 * 注意: Cloud Run が複数インスタンスにスケールした場合、カウントはインスタンス間で
 * 共有されない（各インスタンスが独自のMapを持つ）。小規模betaでは十分だが、
 * 厳密な制御が必要になったら Redis / Supabase など共有ストアに置き換えること。
 */

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000; // 1分
const MAX_REQUESTS = 30; // IPあたり 1分30回まで

const buckets = new Map<string, Bucket>();

function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

export async function rateLimit(c: Context, next: Next) {
  const ip = clientIp(c);
  const now = Date.now();

  let bucket = buckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
  }

  bucket.count++;

  if (bucket.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    c.header("Retry-After", String(retryAfter));
    return c.json({ ok: false, reason: "RATE_LIMITED" }, 429);
  }

  await next();
}

// 期限切れバケットを定期掃除（メモリ肥大防止）
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(ip);
  }
}, 5 * 60_000);
cleanup.unref?.();
