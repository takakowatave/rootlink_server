/**
 * generateHookAI
 *
 * 役割:
 * - 既存の dictionary_cache payload から、日本語1行の覚えフックを生成する
 * - `payload.locales.ja.etymology.hook` を埋める用途
 *
 * 呼び出し元:
 * - resolveQuery のキャッシュヒット時 lazy hydration
 */

import type { RewrittenDictionary } from "./rewriteDictionary.js"

const OPENAI_API_URL =
  process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"
const OPENAI_MODEL =
  process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

type HookContext = {
  word: string
  parts: Array<{ text: string; meaning: string | null; meaningJa: string | null }>
  meaningJa: string | null
  descriptionEn: string | null
  descriptionJa: string | null
}

// 実際の payload には meaningJa も入っているが、型定義には出ていないため
// ここではランタイム構造をゆるく読み取る。
type RuntimePart = {
  text?: unknown
  meaning?: unknown
  meaningJa?: unknown
}

function buildContext(
  headword: string,
  dictionary: RewrittenDictionary
): HookContext {
  const parts: HookContext["parts"] =
    dictionary.etymologyData?.structure.type === "parts"
      ? (dictionary.etymologyData.structure.parts as unknown as RuntimePart[]).map(
          (p) => ({
            text: readString(p.text),
            meaning: readString(p.meaning) || null,
            meaningJa: readString(p.meaningJa) || null,
          })
        )
      : []

  const firstSense = dictionary.senseGroups?.[0]?.senses?.[0]
  const senseId = firstSense?.senseId ?? ""
  const jaSense = dictionary.locales?.ja?.senses?.[senseId]
  const meaningJa = readString(jaSense?.meaning) || null

  const descriptionEn = readString(dictionary.etymology) || null
  const descriptionJa =
    readString(dictionary.locales?.ja?.etymology?.description) || null

  return {
    word: headword,
    parts,
    meaningJa,
    descriptionEn,
    descriptionJa,
  }
}

function buildPrompt(ctx: HookContext): string {
  return [
    "あなたは英単語学習アプリの語源フック作成担当です。",
    "以下の情報から、1行 (最大 60 文字) の日本語「覚えフック」を作ってください。",
    "",
    "形式ガイド:",
    "- parts があるとき: 「意味1（part1）」＋「意味2（part2）」→ 語全体の意味",
    "- parts が無いとき: 起源のイメージ → 現在の意味 (例: 「馬の頑固な行動から『落ち着かない』へ」)",
    "- 語呂・比喩は歓迎するが、正確さを優先",
    "- 末尾の句点は不要",
    "- 「〜から来ています」だけの空虚な文は禁止",
    "- 出力は JSON: {\"hook\":\"...\"}",
    "",
    "入力:",
    JSON.stringify(ctx),
  ].join("\n")
}

async function callOpenAI(prompt: string): Promise<string | null> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required")
  }

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "You output compact Japanese etymology hooks as JSON." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    }),
  })

  if (!res.ok) {
    console.error("GENERATE HOOK OPENAI FAILED:", res.status, await res.text())
    return null
  }

  const data: unknown = await res.json()
  if (!isRecord(data)) return null

  const choices = Array.isArray(data.choices) ? data.choices : []
  const message = isRecord(choices[0]) ? choices[0].message : null
  if (!isRecord(message)) return null

  const content = readString(message.content)
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) return null
    const hook = readString(parsed.hook)
    return hook || null
  } catch {
    return null
  }
}

export async function generateHookForDictionary(
  headword: string,
  dictionary: RewrittenDictionary
): Promise<string | null> {
  const ctx = buildContext(headword, dictionary)

  const hasContext =
    ctx.parts.length > 0 ||
    Boolean(ctx.descriptionEn) ||
    Boolean(ctx.descriptionJa)

  if (!hasContext) {
    return null
  }

  const prompt = buildPrompt(ctx)
  const hook = await callOpenAI(prompt)
  if (!hook) return null

  return hook
}
