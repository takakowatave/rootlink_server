const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "RootLink <noreply@rootlink.app>";

type SendEmailArgs = {
  to: string;
  subject: string;
  html: string;
  from?: string;
};

export async function sendEmail({ to, subject, html, from }: SendEmailArgs) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[sendEmail] RESEND_API_KEY missing, skipping send");
    return { ok: false as const, reason: "MISSING_API_KEY" };
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: from ?? DEFAULT_FROM,
      to,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[sendEmail] Resend API error:", res.status, text);
    return { ok: false as const, reason: "SEND_FAILED" };
  }

  return { ok: true as const };
}

export function renderAccountDeletedEmail(email: string) {
  return {
    subject: "RootLink 退会手続きが完了しました",
    html: `
<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; color: #111; line-height: 1.7;">
    <div style="max-width: 480px; margin: 0 auto; padding: 32px 24px;">
      <h2 style="font-size: 18px; margin: 0 0 16px;">退会手続きが完了しました</h2>
      <p style="font-size: 14px; margin: 0 0 12px;">
        RootLink をご利用いただきありがとうございました。<br>
        <strong>${email}</strong> のアカウントに紐づく個人データは削除されました。
      </p>
      <p style="font-size: 13px; color: #666; margin: 16px 0 0;">
        プライバシーポリシーに基づき、残存する個人データは30日以内に完全に削除されます。<br>
        再度ご利用いただける日を心よりお待ちしております。
      </p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;">
      <p style="font-size: 12px; color: #999; margin: 0;">
        RootLink — <a href="https://www.rootlink.app" style="color: #00AD82; text-decoration: none;">https://www.rootlink.app</a>
      </p>
    </div>
  </body>
</html>
    `.trim(),
  };
}
