/**
 * generateDerivatives
 *
 * OpenAI を使って単語の派生語（word family）を生成する。
 * 返り値は string[]。
 *
 * - 機能語（前置詞・adposition・接続詞・冠詞等）は派生語を持たないため即 [] を返す
 * - generateDerivatives: API を呼んで派生語を取得
 * - safeParseDerivatives: JSON を安全に配列へ変換
 * - stripCodeFence: ```json ... ``` の囲みを除去
 */

// 機能語 POS — 派生語生成をスキップする
const FUNCTION_WORD_POS = new Set([
  "adposition",
  "preposition",
  "postposition",
  "conjunction",
  "article",
  "determiner",
  "particle",
  "interjection",
  "numeral",
  "residual",
])

function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
}

function safeParseDerivatives(content: string, word: string): string[] {
  try {
    const cleaned = stripCodeFence(content)
    const parsed: unknown = JSON.parse(cleaned)

    if (!Array.isArray((parsed as { derivatives?: unknown })?.derivatives)) return []

    const arr = (parsed as { derivatives: unknown[] }).derivatives.filter(
      (v): v is string =>
        typeof v === "string" &&
        v.trim().length > 0 &&
        v.trim().length <= 30 &&
        // フレーズ結合（スペースなし）を弾く: headwordで始まる長い結合語
        !v.toLowerCase().startsWith(word.toLowerCase() + word.toLowerCase().slice(1))
    )

    // headwordをprefixとして含む連結語を除外（例: behind → behindthecurtain）
    const filtered = arr.filter((v) => {
      const lower = v.toLowerCase()
      const head = word.toLowerCase()
      // headwordより長く、headwordで始まる単語で、headwordに一般的な英単語が続くパターンを弾く
      if (lower.startsWith(head) && lower.length > head.length + 3) {
        const suffix = lower.slice(head.length)
        const commonWords = ["the", "a", "an", "of", "in", "on", "at", "by", "for", "with", "to", "and", "or", "bars", "time", "times", "hand", "ward", "ness", "less", "ness"]
        if (commonWords.some((w) => suffix.startsWith(w))) return false
      }
      return true
    })

    return [...new Set(filtered)] as string[]
  } catch {
    return []
  }
}

export async function generateDerivatives(word: string, primaryPos?: string): Promise<string[]> {
  // 機能語は派生語なし
  if (primaryPos && FUNCTION_WORD_POS.has(primaryPos.toLowerCase())) {
    console.log(`DERIVATIVES SKIPPED (function word pos: ${primaryPos}):`, word)
    return []
  }

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
- Return only real, standalone English words found in a standard dictionary.
- Each item must be a single word (no phrases, no hyphenated compounds, no concatenated strings).
- Do NOT combine "${word}" with other words (e.g. do NOT return "${word}less", "${word}ward", "${word}the*", phrases).
- Only include: different grammatical forms with standard affixes (-tion, -ness, -er, -ing, -ly, -ment, un-, re-, etc.).
- If the word is a function word (preposition, conjunction, article, determiner) with no real word family, return {"derivatives":[]}.
- Exclude the original word itself.
- Maximum 8 items. Lowercase only.
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

  const data = await res.json() as { choices?: { message?: { content?: string } }[] }

  const content = data?.choices?.[0]?.message?.content ?? ""
  console.log("OPENAI DERIVATIVES RAW", content)

  const derivatives = safeParseDerivatives(content, word)
  console.log("OPENAI DERIVATIVES PARSED", derivatives)

  return derivatives
}
