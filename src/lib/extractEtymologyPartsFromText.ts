/**
 * extractEtymologyPartsFromText
 *
 * 語源文（rawEtymology）から AI がパーツを直接抽出する。
 *
 * 既存カタログ（etymology_parts）にあるパーツは既存の part_key と gloss を使用。
 * カタログにない新パーツは意味を AI が生成し、isNew=true を返す。
 * 呼び出し元が新パーツを Supabase に upsert する責務を持つ。
 */

import type { EtymologyPartType } from "../types/etymology.js"

const OPENAI_API_URL =
  process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"

const OPENAI_MODEL =
  process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

export type ExtractedEtymologyPart = {
  part_key: string
  value: string
  type: EtymologyPartType
  meaning: string
  meaningJa: string
  isNew: boolean
}

type InputPartsRow = {
  part_key: string
  type: EtymologyPartType
  value: string
  is_active: boolean | null
}

type InputGlossRow = {
  part_key: string
  locale: string
  gloss: string
  priority: number | null
}

type AiPart = {
  value: string
  type: string
  meaningEn: string
  meaningJa: string
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/-+$/, "")
}

function generatePartKey(type: string, value: string): string {
  const slug = normalizeValue(value).replace(/[^a-z]/g, "_")
  return `gen_${type}_${slug}`
}

function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
}

async function callOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required")

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OPENAI_REQUEST_FAILED: ${res.status} ${text}`)
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  const content = data.choices[0]?.message?.content ?? ""
  if (!content.trim()) throw new Error("OPENAI_EMPTY_CONTENT")
  return content
}

export async function extractEtymologyPartsFromText(input: {
  headword: string
  rawEtymology: string
  partsRows: InputPartsRow[]
  glossRows: InputGlossRow[]
}): Promise<ExtractedEtymologyPart[]> {
  const { headword, rawEtymology, partsRows, glossRows } = input

  if (!rawEtymology.trim()) return []

  // 既存カタログのインデックス: "value::type" -> part_key
  const existingIndex = new Map<string, string>()
  for (const row of partsRows) {
    if (row.is_active === false) continue
    const key = `${normalizeValue(row.value)}::${row.type}`
    existingIndex.set(key, row.part_key)
  }

  // gloss lookup: part_key -> { en, ja }
  const glossByKey = new Map<string, { en: string; ja: string }>()
  for (const row of glossRows) {
    const entry = glossByKey.get(row.part_key) ?? { en: "", ja: "" }
    if (row.locale === "en" && !entry.en) entry.en = row.gloss
    if (row.locale === "ja" && !entry.ja) entry.ja = row.gloss
    glossByKey.set(row.part_key, entry)
  }

  const prompt = [
    "Extract morpheme etymology parts from the following English word.",
    "",
    `Headword: ${headword}`,
    `Etymology: ${rawEtymology}`,
    "",
    "Instructions:",
    "- Identify prefixes, roots, and suffixes that appear in the headword AND are mentioned or implied in the etymology text.",
    "- For each part provide: value (the morpheme text), type (prefix/root/suffix), meaningEn (brief English, 1-5 words), meaningJa (Japanese, 1-5 words).",
    "- Only extract parts genuinely supported by the etymology text.",
    "- Do not extract parts not present in the etymology.",
    "",
    'Return JSON only: {"parts":[{"value":"com","type":"prefix","meaningEn":"together","meaningJa":"共に"},{"value":"pon","type":"root","meaningEn":"to place","meaningJa":"置く"}]}',
    "If no parts can be extracted, return: {\"parts\":[]}",
  ].join("\n")

  let aiParts: AiPart[] = []
  try {
    const raw = await callOpenAI(prompt)
    const parsed = JSON.parse(stripCodeFence(raw)) as { parts?: AiPart[] }
    aiParts = Array.isArray(parsed.parts) ? parsed.parts : []
  } catch (err) {
    console.error("extractEtymologyPartsFromText AI error:", err)
    return []
  }

  const VALID_TYPES = new Set<string>(["prefix", "root", "suffix", "unknown"])

  const results: ExtractedEtymologyPart[] = []
  const seenKeys = new Set<string>()

  for (const p of aiParts) {
    if (!p.value || !VALID_TYPES.has(p.type) || !p.meaningEn) continue

    const valueLower = normalizeValue(p.value)
    const type = p.type as EtymologyPartType
    const indexKey = `${valueLower}::${type}`

    // 重複除去
    if (seenKeys.has(indexKey)) continue
    seenKeys.add(indexKey)

    const existingKey = existingIndex.get(indexKey)

    if (existingKey) {
      // 既存パーツ: DB の gloss を優先
      const glosses = glossByKey.get(existingKey) ?? { en: "", ja: "" }
      results.push({
        part_key: existingKey,
        value: valueLower,
        type,
        meaning: glosses.en || p.meaningEn,
        meaningJa: glosses.ja || p.meaningJa,
        isNew: false,
      })
    } else {
      // 新パーツ: AI 生成の意味を使う
      results.push({
        part_key: generatePartKey(type, valueLower),
        value: valueLower,
        type,
        meaning: p.meaningEn,
        meaningJa: p.meaningJa,
        isNew: true,
      })
    }
  }

  return results
}
