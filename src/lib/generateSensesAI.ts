/**
 * generateSensesAI.ts
 *
 * 役割:
 * - Oxford が sense を返さない / 全て register 付き（informal, derogatory 等）の場合に
 *   GPT を使って基本的な意味を補完する
 * - 語源テキスト（etymologyHint）をプロンプトに含めることで、GPT の虚偽生成を抑制する
 * - 生成結果は NormalizedSenseGroup[] の形で返し、Oxford データと同じ型に揃える
 *
 * 呼び出しタイミング:
 * - resolveQuery.ts の buildNormalizedDictionary 内で、
 *   needsSenseFallback() が true を返したときのみ呼ばれる
 *
 * 注意:
 * - Oxford データが十分な場合は呼ばない（無駄な OpenAI コストを避ける）
 * - 生成された senseId には "__ai_" を含め、Oxford 由来と区別できるようにする
 * - temperature は 0.2 に抑えて安定した出力にする
 */

import type { NormalizedSenseGroup } from "./normalizeDictionary.js"

const OPENAI_API_URL =
  process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"

const OPENAI_MODEL =
  process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

// GPT が返す1件分の sense データ（未検証の生データ）
type GeneratedSenseItem = {
  partOfSpeech?: unknown
  definition?: unknown
  example?: unknown
  registerCode?: unknown
}

// GPT レスポンス全体の型
type OpenAIGenerateSensesResponse = {
  senses?: unknown[]
}

// ---- ユーティリティ ----

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// GPT がコードフェンスを返した場合に除去する
function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
}

function safeJsonParse<T>(text: string): T {
  return JSON.parse(stripCodeFence(text)) as T
}

// ---- OpenAI API 呼び出し ----

async function postOpenAI(
  messages: { role: "system" | "user"; content: string }[]
): Promise<string> {
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
      messages,
      temperature: 0.2, // 安定した出力のために低め
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OPENAI_REQUEST_FAILED: ${res.status} ${text}`)
  }

  const data: unknown = await res.json()

  if (!isRecord(data) || !Array.isArray(data.choices)) {
    throw new Error("OPENAI_INVALID_RESPONSE")
  }

  const firstChoice = data.choices[0]

  if (
    !isRecord(firstChoice) ||
    !isRecord(firstChoice.message) ||
    typeof firstChoice.message.content !== "string"
  ) {
    throw new Error("OPENAI_EMPTY_MESSAGE")
  }

  return firstChoice.message.content
}

// ---- プロンプト構築 ----

// 許可する品詞のみ（Oxford の normalizeDictionary と揃える）
const ALLOWED_POS = new Set(["noun", "verb", "adjective", "adverb"])

// GPT の registerCode 文字列を Oxford の registerCodes 配列に変換する
function toRegisterCodes(value: unknown): string[] {
  const str = readString(value).toLowerCase()
  if (!str) return []
  if (str === "informal" || str === "slang") return ["informal"]
  if (str === "derogatory") return ["derogatory"]
  return []
}

function buildPrompt(word: string, etymologyHint: string | null): string {
  const lines = [
    `You are generating dictionary sense data for the English word "${word}".`,
    "",
    "Rules:",
    "- Only include meanings that are broadly and universally recognized.",
    "- Do NOT invent or guess meanings.",
    "- Include standard meanings AND well-known slang/informal usages if they exist.",
    "- For slang, only include meanings that are widely known (e.g. GOAT = Greatest Of All Time).",
    "- Keep definitions concise and learner-friendly.",
    "- Provide a short natural example sentence for each sense.",
    "",
  ]

  // 語源テキストをコンテキストとして渡す（虚偽生成の抑制）
  if (etymologyHint) {
    lines.push(
      `Etymology context (use to anchor meanings, do not contradict): "${etymologyHint}"`,
      ""
    )
  }

  lines.push(
    'registerCode values: null (standard), "informal", "slang", "derogatory"',
    "partOfSpeech values: noun, verb, adjective, adverb",
    "",
    "Return JSON only.",
    'Output: {"senses":[{"partOfSpeech":"noun","definition":"...","example":"...","registerCode":null}]}',
    "",
    `Word: "${word}"`
  )

  return lines.join("\n")
}

// ---- メイン関数 ----

/**
 * Oxford データが貧弱な単語に対して GPT で sense を補完する。
 * 失敗時は空配列を返してフォールバックをスキップできるようにする。
 */
export async function generateSensesAI(input: {
  word: string
  etymologyHint: string | null
}): Promise<NormalizedSenseGroup[]> {
  const { word, etymologyHint } = input

  console.log("GENERATE SENSES AI START:", word)

  // GPT 呼び出し（失敗しても空配列で続行）
  let content: string
  try {
    content = await postOpenAI([
      {
        role: "system",
        content:
          "You generate factual English dictionary sense data. Only include universally recognized meanings. Do not invent. Return JSON only.",
      },
      {
        role: "user",
        content: buildPrompt(word, etymologyHint),
      },
    ])
  } catch (error) {
    console.error("GENERATE SENSES AI FAILED:", word, error)
    return []
  }

  // JSON パース（失敗しても空配列で続行）
  let parsed: OpenAIGenerateSensesResponse
  try {
    parsed = safeJsonParse<OpenAIGenerateSensesResponse>(content)
  } catch {
    console.error("GENERATE SENSES AI PARSE FAILED:", word, content)
    return []
  }

  if (!Array.isArray(parsed.senses)) return []

  // partOfSpeech ごとにグループ化
  const posMap = new Map<string, GeneratedSenseItem[]>()

  for (const item of parsed.senses) {
    if (!isRecord(item)) continue

    // 許可外の品詞は除外
    const pos = readString(item.partOfSpeech).toLowerCase()
    if (!ALLOWED_POS.has(pos)) continue

    const definition = readString(item.definition)
    if (!definition) continue

    let bucket = posMap.get(pos)
    if (!bucket) {
      bucket = []
      posMap.set(pos, bucket)
    }
    bucket.push(item)
  }

  // NormalizedSenseGroup[] に変換
  const senseGroups: NormalizedSenseGroup[] = []

  for (const [pos, items] of posMap.entries()) {
    // 1品詞あたり最大6件に絞る（Oxford と同じ上限）
    const senses = items.slice(0, 6).map((item, index) => {
      const example = readString(item.example)
      const registerCodes = toRegisterCodes(item.registerCode)

      return {
        // "__ai_" を含めて Oxford 由来の senseId と区別する
        senseId: `${word.toLowerCase().replace(/\s+/g, "_")}__${pos}__ai_${index + 1}`,
        senseNumber: String(index + 1),
        definition: readString(item.definition),
        example: example || undefined,
        grammarTags: [],
        registerCodes,
      }
    })

    if (senses.length === 0) continue

    senseGroups.push({
      partOfSpeech: pos,
      totalSenseCount: senses.length,
      shownSenseCount: senses.length,
      hasMoreSenses: false,
      senses,
    })
  }

  console.log(
    "GENERATE SENSES AI DONE:",
    word,
    senseGroups.flatMap((g) => g.senses).length,
    "senses generated"
  )

  return senseGroups
}
