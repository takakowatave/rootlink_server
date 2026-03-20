/**
 * generateDerivatives
 *
 * OpenAI を使って単語の派生語（word family）を生成する。
 * 返り値は string[]。
 *
 * - generateDerivatives: API を呼んで派生語を取得
 * - safeParseDerivatives: JSON を安全に配列へ変換
 * - stripCodeFence: ```json ... ``` の囲みを除去
 */

function stripCodeFence(text: string): string {
    return text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()
  }
  
  function safeParseDerivatives(content: string): string[] {
    try {
      const cleaned = stripCodeFence(content)
      const parsed: any = JSON.parse(cleaned)
  
      if (!Array.isArray(parsed?.derivatives)) return []
  
      const arr = parsed.derivatives.filter(
        (v: unknown) => typeof v === "string" && v.trim().length > 0
      )
  
      return [...new Set(arr)] as string[]
  
    } catch {
      return []
    }
  }
  
  export async function generateDerivatives(word: string): Promise<string[]> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You return only valid JSON. No markdown. No explanation.",
          },
          {
            role: "user",
            content: `
  Return English word-family derivatives for the given headword.
  
  Headword: ${word}
  
  Rules:
  - Return only real English derivatives.
  - Exclude the original word itself.
  - Maximum 8 items.
  - Lowercase only.
  - Output JSON only.
  
  Example:
  {"derivatives":["development","developer","developing"]}
  `.trim(),
          },
        ],
      }),
    })
  
    if (!res.ok) {
      const errorText = await res.text()
      console.log("OPENAI DERIVATIVES HTTP ERROR", res.status, errorText)
      return []
    }
  
    const data = await res.json()
  
    const content = data?.choices?.[0]?.message?.content ?? ""
    console.log("OPENAI DERIVATIVES RAW", content)
  
    const derivatives = safeParseDerivatives(content)
    console.log("OPENAI DERIVATIVES PARSED", derivatives)
  
    return derivatives
  }