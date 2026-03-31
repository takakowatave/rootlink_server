/**
 * rewriteDictionary
 *
 * 役割:
 * - normalizeDictionary の結果を受け取る
 * - definition / example を OpenAI で learner-friendly な英語に書き換える
 * - その確定英語から日本語を生成する
 * - その結果を、dictionary_cache に保存する完成JSONとして返す
 *
 * 注意:
 * - Oxford raw は扱わない
 * - 保存するのは、この関数が返す最終JSONだけ
 * - 呼び出し側で try/catch してください
 */

import type { NormalizedDictionary } from "./normalizeDictionary.js"
import type { EtymologyData } from "../types/etymology.js"

// MVP で使う対応言語を表す。
type SupportedLocale = "ja"

// 英語本文と翻訳群をまとめる共通 shape。
export type LocalizedText = {
  en: string
  translations: Partial<Record<SupportedLocale, string>>
}

// 英語例文と翻訳群をまとめる共通 shape。
export type LocalizedExample = {
  en: string | null
  translations: Partial<Record<SupportedLocale, string | null>>
}

// 1 sense 分の保存 shape を表す。
export type RewrittenSense = {
  senseId: string
  senseNumber: string
  definition: LocalizedText
  example: LocalizedExample
  patterns: string[]
}

// 品詞ごとの sense 配列を表す。
export type RewrittenSenseGroup = {
  partOfSpeech: string
  totalSenseCount: number
  shownSenseCount: number
  hasMoreSenses: boolean
  senses: RewrittenSense[]
}

// dictionary_cache に保存する完成 JSON 全体を表す。
export type RewrittenDictionary = {
  schemaVersion: number
  word: string
  ipa: string | null
  inflections: string[]
  senseGroups: RewrittenSenseGroup[]
  derivatives: string[]
  etymology: string | null
  etymologyData: EtymologyData | null
}

// 英語 rewrite に渡す入力 1 件を表す。
type RewriteSourceItem = {
  id: string
  sourceDefinition: string
  sourceExample: string | null
}

// 日本語生成に渡す入力 1 件を表す。
type TranslationSourceItem = {
  id: string
  definitionEn: string
  exampleEn: string | null
}

// 英語 rewrite の OpenAI 返却 1 件を表す。
type OpenAIRewriteItem = {
  id?: string
  definition?: string
  example?: string | null
}

// 英語 rewrite の OpenAI 返却全体を表す。
type OpenAIRewriteResponse = {
  items?: OpenAIRewriteItem[]
}

// 日本語生成の OpenAI 返却 1 件を表す。
type OpenAITranslationItem = {
  id?: string
  definitionJa?: string
  exampleJa?: string | null
}

// 日本語生成の OpenAI 返却全体を表す。
type OpenAITranslationResponse = {
  items?: OpenAITranslationItem[]
}

// OpenAI API の URL を決める。
const OPENAI_API_URL =
  process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"

// OpenAI で使うモデル名を決める。
const OPENAI_MODEL =
  process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

// OpenAI に投げる chunk サイズを決める。
const CHUNK_SIZE = 12

// 保存 JSON の schema version を決める。
const SCHEMA_VERSION = 2

// OpenAI 用の必須 env があるか確認する。
function assertEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required")
  }
}

// 配列を一定件数ずつに分割する。
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }

  return out
}

// OpenAI の code fence を外して JSON を読みやすくする。
function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
}

// JSON 文字列を安全に parse する。
function safeJsonParse<T>(text: string): T {
  return JSON.parse(stripCodeFence(text)) as T
}

// unknown から空文字安全な string を読む。
function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

// normalizeDictionary の senses を英語 rewrite 用入力に並べ替える。
function buildRewriteSources(data: NormalizedDictionary): RewriteSourceItem[] {
  const items: RewriteSourceItem[] = []

  for (const group of data.senseGroups) {
    for (const sense of group.senses) {
      if (!sense.definition.trim()) continue

      items.push({
        id: sense.senseId,
        sourceDefinition: sense.definition,
        sourceExample: sense.example ?? null,
      })
    }
  }

  return items
}

// 確定した英語 definition / example を日本語生成用入力に並べる。
function buildTranslationSources(
  data: NormalizedDictionary,
  rewrittenMap: Map<string, OpenAIRewriteItem>
): TranslationSourceItem[] {
  const items: TranslationSourceItem[] = []

  for (const group of data.senseGroups) {
    for (const sense of group.senses) {
      const rewritten = rewrittenMap.get(sense.senseId)

      const definitionEn = readString(rewritten?.definition) || sense.definition
      const exampleEn = readString(rewritten?.example) || sense.example || null

      if (!definitionEn.trim()) continue

      items.push({
        id: sense.senseId,
        definitionEn,
        exampleEn,
      })
    }
  }

  return items
}

// 英語 rewrite 用の OpenAI prompt を組み立てる。
function buildSenseRewritePrompt(items: RewriteSourceItem[]): string {
  return [
    "Rewrite English dictionary definitions and examples for an English-learning product.",
    "Rules:",
    "- Keep the meaning faithful.",
    "- Use plain British English.",
    "- Make the definition shorter and easier to understand.",
    "- Do not copy the source wording too closely.",
    "- If example is empty, return null for example.",
    "- Return JSON only.",
    "",
    'Output format: {"items":[{"id":"...","definition":"...","example":"..."|null}]}',
    "",
    "Input:",
    JSON.stringify(
      items.map((item) => ({
        id: item.id,
        definition: item.sourceDefinition,
        example: item.sourceExample,
      }))
    ),
  ].join("\n")
}

// 日本語生成用の OpenAI prompt を組み立てる。
function buildSenseTranslationPrompt(items: TranslationSourceItem[]): string {
  return [
    "Translate learner-friendly English dictionary content into natural Japanese for Japanese learners of English.",
    "Rules:",
    "- Keep the meaning faithful to the English input.",
    "- Write concise, natural Japanese.",
    "- Do not add information that is not in the English input.",
    "- If example is empty, return null for exampleJa.",
    "- Return JSON only.",
    "",
    'Output format: {"items":[{"id":"...","definitionJa":"...","exampleJa":"..."|null}]}',
    "",
    "Input:",
    JSON.stringify(
      items.map((item) => ({
        id: item.id,
        definitionEn: item.definitionEn,
        exampleEn: item.exampleEn,
      }))
    ),
  ].join("\n")
}

// OpenAI Chat Completions に POST して本文を返す。
async function postOpenAI(
  messages: { role: "system" | "user"; content: string }[]
): Promise<string> {
  assertEnv()

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.3,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OPENAI_REQUEST_FAILED: ${res.status} ${text}`)
  }

  const data: unknown = await res.json()

  if (
    typeof data !== "object" ||
    data === null ||
    !("choices" in data) ||
    !Array.isArray(data.choices)
  ) {
    throw new Error("OPENAI_INVALID_RESPONSE")
  }

  const firstChoice = data.choices[0]
  if (
    typeof firstChoice !== "object" ||
    firstChoice === null ||
    !("message" in firstChoice) ||
    typeof firstChoice.message !== "object" ||
    firstChoice.message === null ||
    !("content" in firstChoice.message)
  ) {
    throw new Error("OPENAI_EMPTY_MESSAGE")
  }

  const content = firstChoice.message.content
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OPENAI_EMPTY_CONTENT")
  }

  return content
}

// OpenAI の英語 rewrite レスポンスを保存しやすい形に整える。
function normaliseRewriteItems(items: OpenAIRewriteItem[]): OpenAIRewriteItem[] {
  return items
    .map((item) => {
      const id = readString(item.id)
      const definition = readString(item.definition)
      const example = readString(item.example)

      if (!id || !definition) return null

      return {
        id,
        definition,
        example: example || null,
      }
    })
    .filter(
      (
        item
      ): item is {
        id: string
        definition: string
        example: string | null
      } => item !== null
    )
}

// OpenAI の日本語生成レスポンスを保存しやすい形に整える。
function normaliseTranslationItems(
  items: OpenAITranslationItem[]
): OpenAITranslationItem[] {
  return items
    .map((item) => {
      const id = readString(item.id)
      const definitionJa = readString(item.definitionJa)
      const exampleJa = readString(item.exampleJa)

      if (!id || !definitionJa) return null

      return {
        id,
        definitionJa,
        exampleJa: exampleJa || null,
      }
    })
    .filter(
      (
        item
      ): item is {
        id: string
        definitionJa: string
        exampleJa: string | null
      } => item !== null
    )
}

// 1 chunk 分の sense を英語 rewrite する。
async function rewriteChunk(items: RewriteSourceItem[]): Promise<OpenAIRewriteItem[]> {
  const content = await postOpenAI([
    {
      role: "system",
      content:
        "You rewrite dictionary definitions and examples into simpler learner-friendly British English. Return JSON only.",
    },
    {
      role: "user",
      content: buildSenseRewritePrompt(items),
    },
  ])

  const parsed = safeJsonParse<OpenAIRewriteResponse>(content)

  if (!Array.isArray(parsed.items)) {
    throw new Error("OPENAI_REWRITE_INVALID_JSON")
  }

  return normaliseRewriteItems(parsed.items)
}

// 1 chunk 分の英語確定 sense から日本語を生成する。
async function translateChunk(
  items: TranslationSourceItem[]
): Promise<OpenAITranslationItem[]> {
  const content = await postOpenAI([
    {
      role: "system",
      content:
        "You translate learner-friendly English dictionary content into concise natural Japanese. Return JSON only.",
    },
    {
      role: "user",
      content: buildSenseTranslationPrompt(items),
    },
  ])

  const parsed = safeJsonParse<OpenAITranslationResponse>(content)

  if (!Array.isArray(parsed.items)) {
    throw new Error("OPENAI_TRANSLATION_INVALID_JSON")
  }

  return normaliseTranslationItems(parsed.items)
}

// normalizeDictionary の結果を多言語対応の完成 JSON に変換する。
export async function rewriteDictionary(
  data: NormalizedDictionary
): Promise<RewrittenDictionary> {
  const sourceItems = buildRewriteSources(data)
  const rewrittenMap = new Map<string, OpenAIRewriteItem>()
  const translatedMap = new Map<string, OpenAITranslationItem>()

  for (const group of chunk(sourceItems, CHUNK_SIZE)) {
    const rewrittenItems = await rewriteChunk(group)

    for (const item of rewrittenItems) {
      if (!item.id) continue
      rewrittenMap.set(item.id, item)
    }
  }

  const translationSources = buildTranslationSources(data, rewrittenMap)

  for (const group of chunk(translationSources, CHUNK_SIZE)) {
    const translatedItems = await translateChunk(group)

    for (const item of translatedItems) {
      if (!item.id) continue
      translatedMap.set(item.id, item)
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    word: data.word,
    ipa: data.ipa,
    inflections: data.inflections,
    senseGroups: data.senseGroups.map((group) => ({
      partOfSpeech: group.partOfSpeech,
      totalSenseCount: group.totalSenseCount,
      shownSenseCount: group.shownSenseCount,
      hasMoreSenses: group.hasMoreSenses,
      senses: group.senses.map((sense) => {
        const rewritten = rewrittenMap.get(sense.senseId)
        const translated = translatedMap.get(sense.senseId)

        const definitionEn = readString(rewritten?.definition) || sense.definition
        const exampleEn = readString(rewritten?.example) || sense.example || null

        return {
          senseId: sense.senseId,
          senseNumber: sense.senseNumber,
          definition: {
            en: definitionEn,
            translations: {
              ja: readString(translated?.definitionJa),
            },
          },
          example: {
            en: exampleEn,
            translations: {
              ja: translated?.exampleJa ?? null,
            },
          },
          patterns: sense.patterns,
        }
      }),
    })),
    derivatives: data.derivatives,
    etymology: data.etymology,
    etymologyData: data.etymologyData,
  }
}