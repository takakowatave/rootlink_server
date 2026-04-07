/**
 * rewriteDictionaryAI
 *
 * 役割:
 * - definition の英語 rewrite を行う
 * - meaning / exampleTranslation の日本語生成を行う
 * - etymology description / sourceMeaning / hook の日本語生成を行う
 *
 * 注意:
 * - 最終 payload は組み立てない
 * - registerLabels や originLanguageLabel は扱わない
 * - 語源パーツの meaning / meaningJa は CSV / Supabase 側が primary source
 */

import type { NormalizedDictionary } from "./normalizeDictionary.js"

// AI が返す日本語 sense データ。
export type AISenseTranslation = {
  meaning: string
  exampleTranslation: string | null
}

// AI が返す日本語 etymology データ。
export type AIEtymologyTranslation = {
  descriptionJa: string | null
  sourceMeaningJa: string | null
  hookJa: string | null
}

// rewriteDictionary へ返す AI 結果。
export type RewriteDictionaryAIResult = {
  rewrittenDefinitions: Map<string, string>
  translatedSenses: Map<string, AISenseTranslation>
  translatedEtymology: AIEtymologyTranslation
}

// 英語 rewrite に渡す入力 1 件。
type RewriteSourceItem = {
  id: string
  sourceDefinition: string
}

// 日本語生成に渡す入力 1 件。
type TranslationSourceItem = {
  id: string
  partOfSpeech: string
  headword: string
  definitionEn: string
  exampleEn: string | null
}

// 英語 rewrite の OpenAI 返却 1 件。
type OpenAIRewriteItem = {
  id?: string
  definition?: string
}

// 英語 rewrite の OpenAI 返却全体。
type OpenAIRewriteResponse = {
  items?: OpenAIRewriteItem[]
}

// 日本語生成の OpenAI 返却 1 件。
type OpenAITranslationItem = {
  id?: string
  definitionJa?: string
  exampleJa?: string | null
}

// 日本語生成の OpenAI 返却全体。
type OpenAITranslationResponse = {
  items?: OpenAITranslationItem[]
}

// 語源説明の日本語生成の OpenAI 返却。
type OpenAIEtymologyResponse = {
  descriptionJa?: string | null
  sourceMeaningJa?: string | null
  hookJa?: string | null
}

const OPENAI_API_URL =
  process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"

const OPENAI_MODEL =
  process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

const CHUNK_SIZE = 12

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// definition だけを rewrite 対象に並べる。
function buildRewriteSources(data: NormalizedDictionary): RewriteSourceItem[] {
  const items: RewriteSourceItem[] = []

  for (const group of data.senseGroups) {
    for (const sense of group.senses) {
      if (!sense.definition.trim()) continue

      items.push({
        id: sense.senseId,
        sourceDefinition: sense.definition,
      })
    }
  }

  return items
}

// 確定した英語 definition と原文 example を日本語生成用に並べる。
function buildTranslationSources(
  data: NormalizedDictionary,
  rewrittenDefinitions: Map<string, string>
): TranslationSourceItem[] {
  const items: TranslationSourceItem[] = []

  for (const group of data.senseGroups) {
    for (const sense of group.senses) {
      const definitionEn =
        rewrittenDefinitions.get(sense.senseId)?.trim() || sense.definition

      if (!definitionEn.trim()) continue

      items.push({
        id: sense.senseId,
        partOfSpeech: group.partOfSpeech,
        headword: data.word,
        definitionEn,
        exampleEn: sense.example || null,
      })
    }
  }

  return items
}

function buildSenseRewritePrompt(items: RewriteSourceItem[]): string {
  return [
    "Rewrite English dictionary definitions for an English-learning product.",
    "Rules:",
    "- Keep the meaning faithful.",
    "- Use plain British English.",
    "- Make the definition shorter and easier to understand.",
    "- Do not copy the source wording too closely.",
    "- Rewrite definitions only.",
    "- Do NOT generate or rewrite example sentences.",
    "- Return JSON only.",
    "",
    'Output format: {"items":[{"id":"...","definition":"..."}]}',
    "",
    "Input:",
    JSON.stringify(
      items.map((item) => ({
        id: item.id,
        definition: item.sourceDefinition,
      }))
    ),
  ].join("\n")
}

function buildSenseTranslationPrompt(items: TranslationSourceItem[]): string {
  return [
    "You are generating Japanese dictionary content for a British English learning app for Japanese learners.",
    "",
    "Your job is to produce for each item:",
    "- definitionJa: a short Japanese dictionary gloss",
    "- exampleJa: a natural Japanese translation of the example sentence, or null if there is no example",
    "",
    "This is NOT free paraphrasing.",
    "This is NOT a long explanation.",
    "Write concise, dictionary-style Japanese.",
    "",
    "Rules for definitionJa:",
    "- Use the partOfSpeech field only to guide the style of the gloss — do NOT include part of speech labels in the output.",
    "- Do NOT append part of speech labels like （動詞）、（名詞）、（形容詞） to the definitionJa.",
    "- verb -> use a concise Japanese verb ending in 〜する or 〜だ.",
    "- noun -> use a Japanese noun gloss.",
    "- adjective -> use a natural Japanese adjective ending in 〜な or 〜的な or 〜の. NEVER paraphrase with 〜に関係する or 〜に関する.",
    "- adverb -> use a Japanese adverb-style gloss.",
    "- Keep it short and dictionary-like.",
    "- Do NOT write explanatory phrases like 「〜に関係する」「〜に関する」「〜に関連する」.",
    "- Do NOT use endings like:",
    '  - 「〜すること」',
    '  - 「〜できること」',
    '  - 「〜なこと」',
    '  - 「〜であること」',
    "- unless the source sense itself is explicitly an abstract noun sense.",
    "- Prefer the most standard learner-dictionary Japanese gloss.",
    "  e.g. 'competitive' adjective -> 競争的な  (NOT 他より優れようとすることに関係する)",
    "  e.g. 'transparent' adjective -> 透明な  (NOT 光を通すことに関係する)",
    "- Use the example only to disambiguate the sense.",
    "",
    "Rules for exampleJa:",
    "- Translate the example into natural Japanese.",
    "- Keep it faithful to the English example.",
    "- Do not add information not present in the English example.",
    "- Preserve the wording of the English example as a translation target.",
    "- If exampleEn is empty, return null for exampleJa.",
    "",
    "Return JSON only.",
    'Output format: {"items":[{"id":"...","definitionJa":"...","exampleJa":"..."|null}]}',
    "",
    "Input:",
    JSON.stringify(
      items.map((item) => ({
        id: item.id,
        headword: item.headword,
        partOfSpeech: item.partOfSpeech,
        definitionEn: item.definitionEn,
        exampleEn: item.exampleEn,
      }))
    ),
  ].join("\n")
}

// 語源説明文 / hook / sourceMeaning だけを日本語化する。
function buildEtymologyTranslationPrompt(input: {
  word: string
  descriptionEn: string | null
  sourceMeaningEn: string | null
  hookEn: string | null
}): string {
  return [
    "You are generating Japanese etymology content for a British English learning app for Japanese learners.",
    "",
    "Translate the etymology content faithfully into concise natural Japanese.",
    "Do not add new etymological claims.",
    "Keep the structure stable.",
    "",
    "Your job is to produce:",
    "- descriptionJa: natural Japanese translation of the etymology description, or null",
    "- sourceMeaningJa: natural Japanese translation of the source meaning, or null",
    "- hookJa: natural Japanese translation of the learning hook, or null",
    "",
    "Rules:",
    "- Return null for missing values.",
    "- Do NOT generate part translations.",
    "- Return JSON only.",
    "",
    'Output format: {"descriptionJa":"..."|null,"sourceMeaningJa":"..."|null,"hookJa":"..."|null}',
    "",
    "Input:",
    JSON.stringify(input),
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

function normaliseRewriteItems(items: OpenAIRewriteItem[]): OpenAIRewriteItem[] {
  return items
    .map((item) => {
      const id = readString(item.id)
      const definition = readString(item.definition)

      if (!id || !definition) return null

      return {
        id,
        definition,
      }
    })
    .filter(
      (
        item
      ): item is {
        id: string
        definition: string
      } => item !== null
    )
}

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

function normaliseEtymologyResponse(value: unknown): AIEtymologyTranslation {
  if (!isRecord(value)) {
    return {
      descriptionJa: null,
      sourceMeaningJa: null,
      hookJa: null,
    }
  }

  return {
    descriptionJa: readString(value.descriptionJa) || null,
    sourceMeaningJa: readString(value.sourceMeaningJa) || null,
    hookJa: readString(value.hookJa) || null,
  }
}

async function rewriteChunk(items: RewriteSourceItem[]): Promise<OpenAIRewriteItem[]> {
  const content = await postOpenAI([
    {
      role: "system",
      content:
        "You rewrite dictionary definitions into simpler learner-friendly British English. Do not rewrite example sentences. Return JSON only.",
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

async function translateChunk(
  items: TranslationSourceItem[]
): Promise<OpenAITranslationItem[]> {
  const content = await postOpenAI([
    {
      role: "system",
      content:
        "You translate learner-friendly English dictionary content into concise natural Japanese. The headword field tells you which word is being defined — use it to disambiguate domain-specific or polysemous terms (e.g. 'sheet' in a sailing context means a rope, not bedding). Return JSON only.",
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

async function translateEtymology(input: {
  word: string
  descriptionEn: string | null
  sourceMeaningEn: string | null
  hookEn: string | null
}): Promise<AIEtymologyTranslation> {
  const hasSomething =
    Boolean(input.descriptionEn) ||
    Boolean(input.sourceMeaningEn) ||
    Boolean(input.hookEn)

  if (!hasSomething) {
    return {
      descriptionJa: null,
      sourceMeaningJa: null,
      hookJa: null,
    }
  }

  const content = await postOpenAI([
    {
      role: "system",
      content:
        "You translate etymology content for Japanese learners. Keep it faithful and concise. Do not generate part translations. Return JSON only.",
    },
    {
      role: "user",
      content: buildEtymologyTranslationPrompt(input),
    },
  ])

  const parsed = safeJsonParse<OpenAIEtymologyResponse>(content)
  return normaliseEtymologyResponse(parsed)
}

export async function rewriteDictionaryAI(
  data: NormalizedDictionary
): Promise<RewriteDictionaryAIResult> {
  const rewrittenDefinitions = new Map<string, string>()
  const translatedSenses = new Map<string, AISenseTranslation>()

  const rewriteSources = buildRewriteSources(data)

  for (const group of chunk(rewriteSources, CHUNK_SIZE)) {
    const rewrittenItems = await rewriteChunk(group)

    for (const item of rewrittenItems) {
      if (!item.id || !item.definition) continue
      rewrittenDefinitions.set(item.id, item.definition)
    }
  }

  const translationSources = buildTranslationSources(data, rewrittenDefinitions)

  for (const group of chunk(translationSources, CHUNK_SIZE)) {
    const translatedItems = await translateChunk(group)

    for (const item of translatedItems) {
      if (!item.id || !item.definitionJa) continue

      translatedSenses.set(item.id, {
        meaning: item.definitionJa,
        exampleTranslation: item.exampleJa ?? null,
      })
    }
  }

  const etymologyStructure = data.etymologyData?.structure

  const translatedEtymology = await translateEtymology({
    word: data.word,
    descriptionEn: data.etymology,
    sourceMeaningEn:
      etymologyStructure?.type === "origin"
        ? etymologyStructure.sourceMeaning
        : null,
    hookEn: etymologyStructure?.hook ?? null,
  })

  return {
    rewrittenDefinitions,
    translatedSenses,
    translatedEtymology,
  }
}