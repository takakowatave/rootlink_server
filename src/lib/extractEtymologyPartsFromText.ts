/**
 * extractEtymologyPartsFromText
 *
 * rawEtymology から AI がパーツを直接抽出する。
 * DBへの読み書きはしない。呼び出し元が upsert する責務を持つ。
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
}

type AiPart = {
  value: string
  type: string
  meaningEn: string
  meaningJa: string
}

function normalizeValue(value: string): string {
  return value.trim().replace(/^-+|-+$/g, "").toLowerCase()
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
}): Promise<ExtractedEtymologyPart[]> {
  const { headword, rawEtymology } = input

  if (!rawEtymology.trim()) return []

  const prompt = [
    "You are an expert English etymologist. Extract meaningful morpheme parts from the etymology of the following word.",
    "",
    `Headword: ${headword}`,
    `Etymology: ${rawEtymology}`,
    "",
    "Instructions:",
    "- Identify prefixes, roots, and suffixes that appear in the headword AND are supported by the etymology text.",
    "- For each part provide: value (the morpheme as it appears in the headword, no hyphens), type (prefix/root/suffix), meaningEn (1-5 words), meaningJa (Japanese, 1-5 words).",
    "- IMPORTANT: For meaningEn, give the morpheme's original base/lemma meaning — NOT the inflected or contextual form from the etymology sentence.",
    "  e.g. 'competit-' in 'competitive' → split into 'com' (together) + 'petit' (to seek, aim for)",
    "  e.g. 'pon' in 'component' → meaningEn: 'to place' (not 'placing')",
    "- If a root in the etymology is itself a compound visible in the headword (e.g. 'competere' = 'com' + 'petere'), break it into those smaller parts.",
    "- Use clean morpheme values without hyphens (e.g. 'com' not 'com-', 'ive' not '-ive').",
    "- Only extract parts genuinely supported by the etymology text. Do not invent parts.",
    "",
    "Good example for 'competitive':",
    '{"parts":[{"value":"com","type":"prefix","meaningEn":"together","meaningJa":"共に"},{"value":"petit","type":"root","meaningEn":"to seek, aim for","meaningJa":"求める"},{"value":"ive","type":"suffix","meaningEn":"tending to","meaningJa":"〜の性質を持つ"}]}',
    "",
    "Good example for 'component':",
    '{"parts":[{"value":"com","type":"prefix","meaningEn":"together","meaningJa":"共に"},{"value":"pon","type":"root","meaningEn":"to place","meaningJa":"置く"}]}',
    "",
    "Return JSON only. If no parts can be extracted, return: {\"parts\":[]}",
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
  const seen = new Set<string>()
  const results: ExtractedEtymologyPart[] = []

  for (const p of aiParts) {
    if (!p.value || !VALID_TYPES.has(p.type) || !p.meaningEn) continue

    const value = normalizeValue(p.value)
    const type = p.type as EtymologyPartType
    const dedupeKey = `${value}::${type}`

    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    results.push({
      part_key: generatePartKey(type, value),
      value,
      type,
      meaning: p.meaningEn,
      meaningJa: p.meaningJa ?? "",
    })
  }

  return results
}
