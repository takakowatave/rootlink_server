/**
 * buildEtymologyData
 *
 * rawEtymology から AI でパーツを抽出し EtymologyData を返す。
 *
 * 設計方針:
 * - 語源文が唯一のソース（カタログマッチングなし）
 * - AI抽出 → DB upsert（first write wins）→ 表示
 * - DBは将来の語根ファミリーページ用に蓄積
 */

import type {
  EtymologyData,
  EtymologyPart,
  EtymologyPartType,
} from "../types/etymology.js"
import {
  extractEtymologyPartsFromText,
  type ExtractedEtymologyPart,
} from "./extractEtymologyPartsFromText.js"

type NewPartToUpsert = {
  part_key: string
  value: string
  type: EtymologyPartType
  meaning: string
  meaningJa: string
}

type BuildEtymologyDataInput = {
  headword: string
  rawEtymology: string | null
  wordFamily: string[]
  upsertNewParts?: (parts: NewPartToUpsert[]) => Promise<void>
}

const ORIGIN_LANGUAGE_PATTERNS: Array<{
  key: string
  pattern: RegExp
}> = [
  { key: "latin", pattern: /\bLatin\b/i },
  { key: "greek", pattern: /\bGreek\b/i },
  { key: "old_english", pattern: /\bOld English\b/i },
  { key: "middle_english", pattern: /\bMiddle English\b/i },
  { key: "old_french", pattern: /\bOld French\b/i },
  { key: "french", pattern: /\bFrench\b/i },
  { key: "germanic", pattern: /\bGermanic\b/i },
  { key: "proto_indo_european", pattern: /\bProto-Indo-European\b|\bPIE\b/i },
  { key: "italian", pattern: /\bItalian\b/i },
  { key: "spanish", pattern: /\bSpanish\b/i },
]

function readString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function uniqueStrings(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    ),
  ]
}

function detectOriginLanguage(
  rawEtymology: string
): EtymologyData["originLanguage"] {
  const matched = ORIGIN_LANGUAGE_PATTERNS.find((item) =>
    item.pattern.test(rawEtymology)
  )
  return matched ? { key: matched.key } : null
}

function buildRelatedWords(value: string, wordFamily: string[]): string[] {
  const lower = value.toLowerCase()
  return uniqueStrings(
    wordFamily.filter((word) => {
      const candidate = word.toLowerCase()
      return candidate !== lower && candidate.includes(lower)
    })
  )
}

function buildOriginResult(input: {
  originLanguage: EtymologyData["originLanguage"]
  rawEtymology: string
  wordFamily: string[]
}): EtymologyData {
  return {
    originLanguage: input.originLanguage,
    rawEtymology: input.rawEtymology || null,
    wordFamily: input.wordFamily,
    structure: {
      type: "origin",
      sourceWord: null,
      sourceMeaning: null,
      hook: null,
    },
  }
}

function toEtymologyParts(
  parts: ExtractedEtymologyPart[],
  wordFamily: string[]
): EtymologyPart[] {
  return parts.map((p, index) => ({
    text: p.value,
    partType: p.type,
    meaning: p.meaning,
    meaningJa: p.meaningJa || null,
    relatedWords: buildRelatedWords(p.value, wordFamily),
    order: index,
  }))
}

export async function buildEtymologyData(
  input: BuildEtymologyDataInput
): Promise<EtymologyData | null> {
  const headword = readString(input.headword)
  const rawEtymology = readString(input.rawEtymology)
  const wordFamily = uniqueStrings(input.wordFamily)

  if (!headword) return null

  const originLanguage = rawEtymology
    ? detectOriginLanguage(rawEtymology)
    : null

  if (!rawEtymology) {
    return buildOriginResult({ originLanguage, rawEtymology, wordFamily })
  }

  // 語源文からAI抽出
  const extracted = await extractEtymologyPartsFromText({
    headword,
    rawEtymology,
  }).catch((err) => {
    console.error("extractEtymologyPartsFromText failed:", err)
    return [] as ExtractedEtymologyPart[]
  })

  if (extracted.length === 0) {
    return buildOriginResult({ originLanguage, rawEtymology, wordFamily })
  }

  // 新規パーツをDBに蓄積（first write wins）
  if (input.upsertNewParts) {
    await input.upsertNewParts(
      extracted.map((p) => ({
        part_key: p.part_key,
        value: p.value,
        type: p.type,
        meaning: p.meaning,
        meaningJa: p.meaningJa,
      }))
    ).catch((err) => console.error("upsertNewParts failed:", err))
  }

  return {
    originLanguage,
    rawEtymology: rawEtymology || null,
    wordFamily,
    structure: {
      type: "parts",
      parts: toEtymologyParts(extracted, wordFamily),
      hook: null,
    },
  }
}
