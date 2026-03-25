/**
 * rewriteDictionary
 *
 * 役割:
 * - normalizeDictionary の結果を受け取る
 * - definition / example を OpenAI で learner-friendly な英語に書き換える
 * - lexicalUnits は contexts を使って AI で meaning を生成する
 * - その結果を、dictionary_cache に保存する完成JSONとして返す
 *
 * 注意:
 * - Oxford raw は扱わない
 * - 保存するのは、この関数が返す最終JSONだけ
 * - 呼び出し側で try/catch してください
 */

import type {
  NormalizedDictionary,
  NormalizedLexicalUnit,
  NormalizedLexicalUnitContext,
} from "./normalizeDictionary.js"
import type { EtymologyData } from "../types/etymology.js"

export type RewrittenSense = {
  senseId: string
  senseNumber: string
  definition: string
  example: string | null
  patterns: string[]
}

export type RewrittenSenseGroup = {
  partOfSpeech: string
  totalSenseCount: number
  shownSenseCount: number
  hasMoreSenses: boolean
  senses: RewrittenSense[]
}

export type RewrittenLexicalUnitMeaning = {
  meaning: {
    en: string
    ja: string
  }
  examples: {
    sentence: string
    translation: string
  }[]
}

export type RewrittenLexicalUnit = {
  lexicalUnitId: string
  phrase: string
  meanings: RewrittenLexicalUnitMeaning[]
}

export type RewrittenDictionary = {
  schemaVersion: number
  word: string
  ipa: string | null
  inflections: string[]
  senseGroups: RewrittenSenseGroup[]
  lexicalUnits: RewrittenLexicalUnit[]
  derivatives: string[]
  etymology: string | null
  etymologyData: EtymologyData | null
}

type RewriteSourceItem = {
  id: string
  sourceDefinition: string
  sourceExample: string | null
}

type OpenAIRewriteItem = {
  id: string
  definition: string
  example?: string | null
}

type OpenAIRewriteResponse = {
  items?: OpenAIRewriteItem[]
}

type OpenAILexicalUnitExample = {
  sentence?: string
  translation?: string
}

type OpenAILexicalUnitMeaning = {
  en?: string
  ja?: string
  examples?: OpenAILexicalUnitExample[]
}

type OpenAILexicalUnitResponse = {
  meanings?: OpenAILexicalUnitMeaning[]
}

const OPENAI_API_URL =
  process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"

const OPENAI_MODEL =
  process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

const CHUNK_SIZE = 12
const SCHEMA_VERSION = 1

function assertEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required")
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }

  return out
}

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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function buildRewriteSources(data: NormalizedDictionary): RewriteSourceItem[] {
  const items: RewriteSourceItem[] = []

  for (const group of data.senseGroups) {
    for (const sense of group.senses) {
      if (!sense.definition.trim()) continue

      items.push({
        id: `${group.partOfSpeech}-${sense.senseNumber}`,
        sourceDefinition: sense.definition,
        sourceExample: sense.example ?? null,
      })
    }
  }

  return items
}

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

  return parsed.items
}

function buildLexicalUnitContextKey(
  context: NormalizedLexicalUnitContext
): string {
  return [
    context.sourceType,
    context.sourceText ?? "",
    context.parentDefinition ?? "",
    context.parentExample ?? "",
    context.partOfSpeech ?? "",
  ].join("||")
}

function normaliseLexicalUnitContexts(
  contexts: NormalizedLexicalUnitContext[]
): NormalizedLexicalUnitContext[] {
  const seen = new Set<string>()
  const deduped: NormalizedLexicalUnitContext[] = []

  for (const context of contexts) {
    const key = buildLexicalUnitContextKey(context)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(context)
  }

  return deduped
}

function buildLexicalUnitPrompt(
  word: string,
  unit: NormalizedLexicalUnit
): string {
  const contexts = normaliseLexicalUnitContexts(unit.contexts).map((context) => ({
    sourceType: context.sourceType,
    sourceText: context.sourceText,
    parentDefinition: context.parentDefinition,
    parentExample: context.parentExample,
    partOfSpeech: context.partOfSpeech,
  }))

  return [
    "Create learner-friendly dictionary content for an English phrase.",
    "Rules:",
    "- Use British English only.",
    "- The phrase is derived from dictionary evidence and may be incomplete without context.",
    "- Use the provided contexts to infer the phrase meaning.",
    "- Write meanings for the phrase itself, not for the headword alone.",
    "- Keep meanings concise and faithful.",
    "- Japanese should be natural and short.",
    "- Return 1 or 2 meanings only.",
    "- Return 1 example per meaning.",
    "- Return JSON only.",
    "",
    'Output format: {"meanings":[{"en":"...","ja":"...","examples":[{"sentence":"...","translation":"..."}]}]}',
    "",
    "Input:",
    JSON.stringify({
      headword: word,
      phrase: unit.text,
      contexts,
    }),
  ].join("\n")
}

function normaliseLexicalUnitMeaning(
  meaning: OpenAILexicalUnitMeaning
): RewrittenLexicalUnitMeaning | null {
  const en = readString(meaning.en)
  const ja = readString(meaning.ja)

  if (!en || !ja) return null

  const examples = Array.isArray(meaning.examples)
    ? meaning.examples
        .map((example) => {
          const sentence = readString(example.sentence)
          const translation = readString(example.translation)

          if (!sentence || !translation) return null

          return {
            sentence,
            translation,
          }
        })
        .filter(
          (
            item
          ): item is {
            sentence: string
            translation: string
          } => item !== null
        )
    : []

  return {
    meaning: {
      en,
      ja,
    },
    examples,
  }
}

async function rewriteSingleLexicalUnit(
  word: string,
  unit: NormalizedLexicalUnit
): Promise<RewrittenLexicalUnit> {
  const content = await postOpenAI([
    {
      role: "system",
      content:
        "You write learner-friendly British English dictionary content for phrases. Return JSON only.",
    },
    {
      role: "user",
      content: buildLexicalUnitPrompt(word, unit),
    },
  ])

  const parsed = safeJsonParse<OpenAILexicalUnitResponse>(content)

  if (!Array.isArray(parsed.meanings)) {
    throw new Error(`OPENAI_LEXICAL_UNIT_INVALID_JSON: ${unit.text}`)
  }

  const meanings = parsed.meanings
    .map((meaning) => normaliseLexicalUnitMeaning(meaning))
    .filter((meaning): meaning is RewrittenLexicalUnitMeaning => meaning !== null)

  if (meanings.length === 0) {
    throw new Error(`OPENAI_LEXICAL_UNIT_EMPTY_MEANINGS: ${unit.text}`)
  }

  return {
    lexicalUnitId: unit.lexicalUnitId,
    phrase: unit.text,
    meanings,
  }
}

async function rewriteLexicalUnits(
  word: string,
  lexicalUnits: NormalizedLexicalUnit[]
): Promise<RewrittenLexicalUnit[]> {
  if (lexicalUnits.length === 0) {
    return []
  }

  const results: RewrittenLexicalUnit[] = []

  for (const unit of lexicalUnits) {
    const rewritten = await rewriteSingleLexicalUnit(word, unit)
    results.push(rewritten)
  }

  return results
}

export async function rewriteDictionary(
  data: NormalizedDictionary
): Promise<RewrittenDictionary> {
  const sourceItems = buildRewriteSources(data)
  const rewrittenMap = new Map<string, OpenAIRewriteItem>()

  for (const group of chunk(sourceItems, CHUNK_SIZE)) {
    const rewrittenItems = await rewriteChunk(group)

    for (const item of rewrittenItems) {
      if (!item.id) continue

      const definition = readString(item.definition)
      if (!definition) continue

      const example = readString(item.example)

      rewrittenMap.set(item.id, {
        id: item.id,
        definition,
        example: example || null,
      })
    }
  }

  const rewrittenLexicalUnits = await rewriteLexicalUnits(
    data.word,
    data.lexicalUnits
  )

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
        const rewritten = rewrittenMap.get(
          `${group.partOfSpeech}-${sense.senseNumber}`
        )

        return {
          senseId: sense.senseId,
          senseNumber: sense.senseNumber,
          definition: rewritten?.definition ?? sense.definition,
          example: rewritten?.example ?? sense.example ?? null,
          patterns: sense.patterns,
        }
      }),
    })),
    lexicalUnits: rewrittenLexicalUnits,
    derivatives: data.derivatives,
    etymology: data.etymology,
    etymologyData: data.etymologyData,
  }
}