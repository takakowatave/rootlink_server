/**
 * buildEtymologyData の全体フロー
 *
 * 目的:
 * - Supabase（CSV由来）を主ソースとして語源パーツを構築
 * - Oxford raw は originLanguage / rawEtymology の補助情報としてのみ使用
 * - 語源パーツは「出すか出さないか」を最終的にAIで調整する
 *
 * ---
 * 処理の流れ:
 *
 * 1. DBから候補パーツを取得（matchCatalogParts）
 * 2. ambiguity解決（resolveAmbiguousEtymologyParts）
 * 3. 表示対象の最終フィルタ（judgeMatchedPartsForDisplay）
 * 4. 表示分岐
 *
 * ---
 * 重要な設計ルール:
 *
 * - meaning は絶対にAI生成しない（CSVが唯一のソース）
 * - AIは「選択」と「除外」だけ行う
 * - fallbackで「とりあえず1件目」は絶対にやらない
 * - 語源文と整合しない part は出さない
 *
 * ---
 * 役割分離:
 *
 * - matchCatalogParts:
 *     DBベースで「候補を拾う」
 *
 * - resolveAmbiguousEtymologyParts:
 *     「候補の中から正しい意味を選ぶ or 落とす」
 *
 * - judgeMatchedPartsForDisplay:
 *     「UIに出すpart_keyをさらに絞る」
 *
 */

import type {
  EtymologyData,
  EtymologyPart,
  EtymologyPartType,
} from "../types/etymology.js"
import {
  resolveAmbiguousEtymologyParts,
  type AmbiguousEtymologyPart,
} from "./resolveAmbiguousEtymologyParts.js"
import {
  extractEtymologyPartsFromText,
  type ExtractedEtymologyPart,
} from "./extractEtymologyPartsFromText.js"

type AiJsonGenerator = <T>(_input: {
  systemPrompt: string
  userPrompt: string
}) => Promise<T>

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

  // Supabase: etymology_parts
  partsRows: SupabaseEtymologyPartRow[]

  // Supabase: etymology_part_glosses
  glossRows: SupabaseEtymologyPartGlossRow[]

  // parts の最終表示可否だけを判定する
  aiGenerateJson?: AiJsonGenerator

  // 新規パーツを DB に保存するコールバック（省略可）
  upsertNewParts?: (parts: NewPartToUpsert[]) => Promise<void>
}

type SupabaseEtymologyPartRow = {
  part_key: string
  type: EtymologyPartType
  value: string
  sort_order: number | null
  is_active: boolean | null
}

type SupabaseEtymologyPartGlossRow = {
  id: number
  part_key: string
  locale: string
  gloss: string
  priority: number | null
  sort_order: number | null
}

type GlossBundle = {
  partKey: string
  priority: number
  sortOrder: number
  meaning: string | null
  meaningJa: string | null
}

type MatchedRange = {
  start: number
  end: number
}

type MatchedCatalogPart = {
  part_key: string
  type: EtymologyPartType
  value: string
  sort_order: number
  glossCandidates: Array<{
    meaning: string
    meaningJa: string | null
  }>
  start: number
  end: number
  matchLength: number
}

type ResolvedCatalogPart = {
  part_key: string
  type: EtymologyPartType
  value: string
  sort_order: number
  meaning: string | null
  meaningJa: string | null
}

type EtymologyDisplayDecision = {
  selectedPartKeys: string[]
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

const TYPE_DISPLAY_ORDER: Record<EtymologyPartType, number> = {
  prefix: 0,
  root: 1,
  suffix: 2,
  unknown: 3,
}

// null / undefined を空文字にそろえる。
function readString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

// 空文字を除いて重複文字列を取り除く。
function uniqueStrings(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    ),
  ]
}

// token 比較用に小文字化して末尾ハイフンを外す。
function normalizeToken(text: string): string {
  return text.trim().replace(/-+$/, "").toLowerCase()
}

// token から英字以外を落として比較しやすくする。
function normalizeLettersOnly(text: string): string {
  return normalizeToken(text).replace(/[^a-z]/g, "")
}

// word family からそのパーツを含む関連語だけを拾う。
function buildRelatedWords(text: string, wordFamily: string[]): string[] {
  const lower = text.toLowerCase()

  return uniqueStrings(
    wordFamily.filter((word) => {
      const candidate = word.toLowerCase()
      return candidate !== lower && candidate.includes(lower)
    })
  )
}

// raw etymology の中から主要な起源言語ラベルを拾う。
function detectOriginLanguage(
  rawEtymology: string
): EtymologyData["originLanguage"] {
  const matched = ORIGIN_LANGUAGE_PATTERNS.find((item) =>
    item.pattern.test(rawEtymology)
  )

  if (!matched) {
    return null
  }

  return {
    key: matched.key,
  }
}

function readSortOrder(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function readPriority(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 9999
}

// gloss 行を「priority + sort_order」単位の bundle に束ねる。
// これで en / ja を同じ候補セットとして扱える。
function buildGlossBundleIndex(
  glossRows: SupabaseEtymologyPartGlossRow[]
): Map<string, GlossBundle[]> {
  const grouped = new Map<string, Map<string, GlossBundle>>()

  for (const row of glossRows) {
    const partKey = readString(row.part_key)
    const locale = readString(row.locale).toLowerCase()
    const gloss = readString(row.gloss)

    if (!partKey || !locale || !gloss) continue

    const priority = readPriority(row.priority)
    const sortOrder = readSortOrder(row.sort_order)
    const bundleKey = `${priority}::${sortOrder}`

    const partBundles = grouped.get(partKey) ?? new Map<string, GlossBundle>()
    const existing = partBundles.get(bundleKey) ?? {
      partKey,
      priority,
      sortOrder,
      meaning: null,
      meaningJa: null,
    }

    if (locale === "en" && !existing.meaning) {
      existing.meaning = gloss
    }

    if (locale === "ja" && !existing.meaningJa) {
      existing.meaningJa = gloss
    }

    partBundles.set(bundleKey, existing)
    grouped.set(partKey, partBundles)
  }

  const result = new Map<string, GlossBundle[]>()

  for (const [partKey, bundleMap] of grouped.entries()) {
    const bundles = [...bundleMap.values()].sort((a, b) => {
      const priorityDiff = a.priority - b.priority
      if (priorityDiff !== 0) return priorityDiff
      return a.sortOrder - b.sortOrder
    })

    result.set(partKey, bundles)
  }

  return result
}

// 1 part_key に対する gloss 候補を resolver 用の shape に変換する。
// meaning / meaningJa のどちらかがある候補だけ残す。
function buildGlossCandidates(
  partKey: string,
  glossBundleIndex: Map<string, GlossBundle[]>
): Array<{
  meaning: string
  meaningJa: string | null
}> {
  const bundles = glossBundleIndex.get(partKey) ?? []

  return bundles
    .map((bundle) => {
      const meaning = readString(bundle.meaning)
      const meaningJa = readString(bundle.meaningJa) || null

      if (!meaning && !meaningJa) {
        return null
      }

      return {
        meaning,
        meaningJa,
      }
    })
    .filter(
      (
        candidate
      ): candidate is {
        meaning: string
        meaningJa: string | null
      } => candidate !== null
    )
}

function findPrefixRange(headword: string, value: string): MatchedRange | null {
  const normalizedHeadword = normalizeLettersOnly(headword)
  const normalizedValue = normalizeLettersOnly(value)

  if (!normalizedHeadword || !normalizedValue) return null
  if (normalizedHeadword.length <= normalizedValue.length + 1) return null
  if (!normalizedHeadword.startsWith(normalizedValue)) return null

  return {
    start: 0,
    end: normalizedValue.length,
  }
}

function findSuffixRange(headword: string, value: string): MatchedRange | null {
  const normalizedHeadword = normalizeLettersOnly(headword)
  const normalizedValue = normalizeLettersOnly(value)

  if (!normalizedHeadword || !normalizedValue) return null
  if (normalizedHeadword.length <= normalizedValue.length + 1) return null
  if (!normalizedHeadword.endsWith(normalizedValue)) return null

  return {
    start: normalizedHeadword.length - normalizedValue.length,
    end: normalizedHeadword.length,
  }
}

function findRootRange(
  headword: string,
  rawEtymology: string,
  value: string
): MatchedRange | null {
  const normalizedHeadword = normalizeLettersOnly(headword)
  const normalizedValue = normalizeLettersOnly(value)

  if (!normalizedHeadword || !normalizedValue) return null
  if (normalizedValue.length < 3) return null

  const start = normalizedHeadword.indexOf(normalizedValue)
  if (start < 0) return null

  const escaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const rawPattern = new RegExp(`\\b${escaped}\\b`, "i")

  if (rawPattern.test(rawEtymology)) {
    return {
      start,
      end: start + normalizedValue.length,
    }
  }

  return {
    start,
    end: start + normalizedValue.length,
  }
}

function findMatchedRange(input: {
  headword: string
  rawEtymology: string
  value: string
  type: EtymologyPartType
}): MatchedRange | null {
  if (input.type === "prefix") {
    return findPrefixRange(input.headword, input.value)
  }

  if (input.type === "suffix") {
    return findSuffixRange(input.headword, input.value)
  }

  return findRootRange(input.headword, input.rawEtymology, input.value)
}

function isOverlapping(a: MatchedRange, b: MatchedRange): boolean {
  return a.start < b.end && b.start < a.end
}

// 長い一致を優先し、内包される短い候補を落とす。
function selectNonOverlappingParts(
  parts: MatchedCatalogPart[]
): MatchedCatalogPart[] {
  const selected: MatchedCatalogPart[] = []

  const sortedForSelection = [...parts].sort((a, b) => {
    // まず表示上の基本順を安定させる
    const typeDiff = TYPE_DISPLAY_ORDER[a.type] - TYPE_DISPLAY_ORDER[b.type]
    if (typeDiff !== 0) return typeDiff

    const startDiff = a.start - b.start
    if (startDiff !== 0) return startDiff

    const endDiff = a.end - b.end
    if (endDiff !== 0) return endDiff

    return a.sort_order - b.sort_order
  })

  for (const candidate of sortedForSelection) {
    const overlaps = selected.some((picked) => {
      // 競合 prefix はここで潰さない。
      // 例: per / peri のように同じ開始位置で重なる候補は
      // 後段の resolver / AI に両方渡して判定させる。
      if (
        candidate.type === "prefix" &&
        picked.type === "prefix" &&
        candidate.start === picked.start
      ) {
        return false
      }

      // 競合 suffix もここで潰さない。
      // 例: -ion / -ation のように同じ終了位置で重なる候補は
      // 後段で選ばせる。
      if (
        candidate.type === "suffix" &&
        picked.type === "suffix" &&
        candidate.end === picked.end
      ) {
        return false
      }

      // それ以外の overlap は従来どおり排除する。
      return isOverlapping(
        { start: candidate.start, end: candidate.end },
        { start: picked.start, end: picked.end }
      )
    })

    if (overlaps) continue

    selected.push(candidate)
  }

  return selected
}

// DB の active parts から、この単語に当てる候補だけを選ぶ。
// ここでは gloss を 1件に決め打ちせず、候補配列のまま保持する。
function matchCatalogParts(input: {
  headword: string
  rawEtymology: string
  partsRows: SupabaseEtymologyPartRow[]
  glossRows: SupabaseEtymologyPartGlossRow[]
}): MatchedCatalogPart[] {
  const glossBundleIndex = buildGlossBundleIndex(input.glossRows)

  const activeRows = input.partsRows
    .filter((row) => row.is_active !== false)
    .filter((row) => readString(row.part_key).length > 0)
    .filter((row) => readString(row.value).length > 0)

  const candidates: MatchedCatalogPart[] = []
  const seen = new Set<string>()

  for (const row of activeRows) {
    const partKey = readString(row.part_key)
    const value = readString(row.value)
    const type = row.type

    if (!partKey || !value) continue
    if (seen.has(partKey)) continue

    const range = findMatchedRange({
      headword: input.headword,
      rawEtymology: input.rawEtymology,
      value,
      type,
    })

    if (!range) continue

    const glossCandidates = buildGlossCandidates(partKey, glossBundleIndex)
    if (glossCandidates.length === 0) continue

    seen.add(partKey)

    candidates.push({
      part_key: partKey,
      type,
      value,
      sort_order: readSortOrder(row.sort_order),
      glossCandidates,
      start: range.start,
      end: range.end,
      matchLength: range.end - range.start,
    })
  }

  const selected = selectNonOverlappingParts(candidates)

  return selected.sort((a, b) => {
    const typeDiff = TYPE_DISPLAY_ORDER[a.type] - TYPE_DISPLAY_ORDER[b.type]
    if (typeDiff !== 0) return typeDiff

    const startDiff = a.start - b.start
    if (startDiff !== 0) return startDiff

    return a.sort_order - b.sort_order
  })
}

// parts 候補を ambiguity resolver に渡す shape に変換する。
// order は resolver との往復用に固定する。
function toResolverInputParts(
  parts: MatchedCatalogPart[],
  wordFamily: string[]
): AmbiguousEtymologyPart[] {
  return parts.map((part, index) => ({
    text: part.value,
    partType: part.type,
    relatedWords: buildRelatedWords(part.value, wordFamily),
    order: index,
    glossCandidates: part.glossCandidates,
  }))
}

// resolver 結果に元の part_key を戻す。
// 非表示になった part は resolver 側で落ちる。
function mergeResolvedParts(
  originalParts: MatchedCatalogPart[],
  resolvedParts: Array<{
    text: string
    partType: EtymologyPartType
    meaning: string | null
    meaningJa: string | null
    relatedWords: string[]
    order: number
  }>
): ResolvedCatalogPart[] {
  return resolvedParts
    .map((part) => {
      const source = originalParts[part.order]
      if (!source) return null

      return {
        part_key: source.part_key,
        type: part.partType,
        value: part.text,
        sort_order: source.sort_order,
        meaning: part.meaning,
        meaningJa: part.meaningJa,
      }
    })
    .filter((part): part is ResolvedCatalogPart => part !== null)
}

function shouldUsePartsStructure(parts: ResolvedCatalogPart[]): boolean {
  return parts.length > 0
}

// AIと resolver を通った matched parts を UI 用 EtymologyPart[] に変換する。
function toEtymologyParts(
  parts: ResolvedCatalogPart[],
  wordFamily: string[]
): EtymologyPart[] {
  return parts.map((part, index) => ({
    text: part.value,
    partType: part.type,
    meaning: part.meaning,
    meaningJa: part.meaningJa,
    relatedWords: buildRelatedWords(part.value, wordFamily),
    order: index,
  }))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// AI は selectedPartKeys だけ返す。
// 1件以上あれば parts 表示、0件なら parts 非表示。
function normalizeDisplayDecision(
  value: unknown,
  resolvedParts: ResolvedCatalogPart[]
): EtymologyDisplayDecision {
  const availablePartKeys = new Set(resolvedParts.map((part) => part.part_key))

  if (!isRecord(value)) {
    return {
      selectedPartKeys: resolvedParts.map((part) => part.part_key),
    }
  }

  const rawSelectedPartKeys = value.selectedPartKeys

  const selectedPartKeys = Array.isArray(rawSelectedPartKeys)
    ? uniqueStrings(
        rawSelectedPartKeys
          .filter((item): item is string => typeof item === "string")
          .filter((item) => availablePartKeys.has(item))
      )
    : resolvedParts.map((part) => part.part_key)

  return {
    selectedPartKeys,
  }
}

// ここでは origin / parts のモード二択はさせない。
// 「どの part_key を残すか」だけ AI に判断させる。
async function judgeMatchedPartsForDisplay(input: {
  headword: string
  rawEtymology: string
  resolvedParts: ResolvedCatalogPart[]
  aiGenerateJson?: AiJsonGenerator
}): Promise<EtymologyDisplayDecision> {
  if (!input.aiGenerateJson) {
    return {
      selectedPartKeys: input.resolvedParts.map((part) => part.part_key),
    }
  }

  const systemPrompt = [
    "You select which etymology parts should be shown to a learner.",
    "Return JSON only.",
    'Schema: {"selectedPartKeys":string[]}',
    "selectedPartKeys must be a subset of the provided part_key values.",
    "Do not decide between origin and parts.",
    "Origin information is handled separately.",
    "Keep only parts that are genuinely supported by the raw etymology and helpful to the learner.",
    "If none are reliable, return an empty array.",
  ].join(" ")

  const userPrompt = JSON.stringify({
    headword: input.headword,
    rawEtymology: input.rawEtymology,
    resolvedParts: input.resolvedParts.map((part) => ({
      part_key: part.part_key,
      type: part.type,
      value: part.value,
      meaning: part.meaning,
      meaningJa: part.meaningJa,
    })),
  })

  try {
    const rawDecision = await input.aiGenerateJson<unknown>({
      systemPrompt,
      userPrompt,
    })

    return normalizeDisplayDecision(rawDecision, input.resolvedParts)
  } catch {
    return {
      selectedPartKeys: input.resolvedParts.map((part) => part.part_key),
    }
  }
}

// AI 抽出パーツを ResolvedCatalogPart に変換する。
function toResolvedFromExtracted(
  parts: ExtractedEtymologyPart[]
): ResolvedCatalogPart[] {
  return parts.map((p, index) => ({
    part_key: p.part_key,
    type: p.type,
    value: p.value,
    sort_order: 900 + index, // catalog より後ろに並べる
    meaning: p.meaning,
    meaningJa: p.meaningJa || null,
  }))
}

// Supabase の語源パーツを中心に EtymologyData を組み立てる。
// 内部の流れ:
// 1. DB parts を headword にマッチ
// 2. 複数 gloss 候補の part は resolver で語源文照合
// 3. 語源文から AI がパーツを直接抽出してマージ（カタログ優先）
// 4. その後、表示してよい part_key だけ AI で絞る
// 5. 新規パーツを upsert コールバックに渡す
// 6. 1件も残らなければ origin 構造に落とす
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

  // ---- Step 1: カタログマッチング ----
  const matchedParts = matchCatalogParts({
    headword,
    rawEtymology,
    partsRows: input.partsRows,
    glossRows: input.glossRows,
  })

  // ---- Step 2: ambiguity 解決 ----
  const resolvedAmbiguousParts = matchedParts.length > 0
    ? await resolveAmbiguousEtymologyParts({
        headword,
        rawEtymology: rawEtymology || null,
        parts: toResolverInputParts(matchedParts, wordFamily),
      })
    : []

  const resolvedCatalogParts = mergeResolvedParts(matchedParts, resolvedAmbiguousParts)

  // ---- Step 3: 語源文から AI 抽出してマージ ----
  const aiExtracted = rawEtymology
    ? await extractEtymologyPartsFromText({
        headword,
        rawEtymology,
        partsRows: input.partsRows,
        glossRows: input.glossRows,
      }).catch((err) => {
        console.error("extractEtymologyPartsFromText failed:", err)
        return [] as ExtractedEtymologyPart[]
      })
    : []

  // カタログで解決済みの part_key セット（重複排除用）
  const catalogPartKeys = new Set(resolvedCatalogParts.map((p) => p.part_key))
  const catalogValues = new Set(resolvedCatalogParts.map((p) => p.value.toLowerCase()))

  // カタログに含まれていないパーツのみ追加
  // ハイフンを除去して正規化し重複を防ぐ（例: "ive" と "-ive" を同一視）
  const normalizePartValue = (v: string) => v.replace(/^-+|-+$/g, "").toLowerCase()
  const catalogValuesNorm = new Set(
    resolvedCatalogParts.map((p) => normalizePartValue(p.value))
  )

  const additionalFromAI = toResolvedFromExtracted(
    aiExtracted.filter(
      (p) =>
        !catalogPartKeys.has(p.part_key) &&
        !catalogValuesNorm.has(normalizePartValue(p.value))
    )
  )

  const mergedParts: ResolvedCatalogPart[] = [...resolvedCatalogParts, ...additionalFromAI]

  if (!shouldUsePartsStructure(mergedParts)) {
    return buildOriginResult({
      originLanguage,
      rawEtymology,
      wordFamily,
    })
  }

  // ---- Step 4: 表示フィルタ ----
  const decision = await judgeMatchedPartsForDisplay({
    headword,
    rawEtymology,
    resolvedParts: mergedParts,
    aiGenerateJson: input.aiGenerateJson,
  })

  const filteredParts = mergedParts.filter((part) =>
    decision.selectedPartKeys.includes(part.part_key)
  )

  // ---- Step 5: 新規パーツを upsert ----
  if (input.upsertNewParts) {
    const newPartsToSave: NewPartToUpsert[] = aiExtracted
      .filter((p) => p.isNew)
      .map((p) => ({
        part_key: p.part_key,
        value: p.value,
        type: p.type,
        meaning: p.meaning,
        meaningJa: p.meaningJa,
      }))

    if (newPartsToSave.length > 0) {
      await input.upsertNewParts(newPartsToSave).catch((err) => {
        console.error("upsertNewParts failed:", err)
      })
    }
  }

  if (filteredParts.length === 0) {
    return buildOriginResult({
      originLanguage,
      rawEtymology,
      wordFamily,
    })
  }

  return {
    originLanguage,
    rawEtymology: rawEtymology || null,
    wordFamily,
    structure: {
      type: "parts",
      parts: toEtymologyParts(filteredParts, wordFamily),
      hook: null,
    },
  }
}