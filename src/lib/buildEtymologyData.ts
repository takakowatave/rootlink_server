import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type {
  EtymologyData,
  EtymologyPart,
  EtymologyPartType,
} from "../types/etymology.js"
import {
  extractOriginLanguage,
  getOriginLanguageAliases,
} from "./etymologyOriginLanguages.js"

/**
 * 既存 caller 互換のために残す。
 * このファイルでは使わない。
 */
export type AiJsonGeneratorArgs = {
  systemPrompt: string
  userPrompt: string
  temperature?: number
}

export type AiJsonGenerator = (
  args: AiJsonGeneratorArgs
) => Promise<unknown>

/**
 * buildEtymologyData の入力。
 * aiGenerateJson は caller 互換のためだけに残している。
 */
export type BuildEtymologyDataParams = {
  headword: string
  rawEtymology: string | null | undefined
  wordFamily?: string[] | null | undefined
  aiGenerateJson?: AiJsonGenerator
}

type PartRow = {
  part_key: string
  type: "prefix" | "root"
  value: string
  sort_order: number | null
  is_active: boolean | null
}

type GlossRow = {
  part_key: string
  gloss_en: string
  gloss_ja: string
  priority: 1 | 2
  sort_order: number | null
}

type SeedGloss = {
  glossEn: string
  glossJa: string
  priority: 1 | 2
  sortOrder: number
}

type SeedPart = {
  partKey: string
  partType: Extract<EtymologyPartType, "prefix" | "root">
  value: string
  sortOrder: number
  glosses: SeedGloss[]
}

type SeedCache = {
  prefixes: SeedPart[]
  roots: SeedPart[]
}

type PartMatch = {
  part: SeedPart
  start: number
  end: number
}

type RuntimeEtymologyPart = EtymologyPart & {
  // 既存 EtymologyPart shape を壊さず、BE JSON には日本語も載せる
  meaningJa: string | null
}

const ETYMOLOGY_PARTS_TABLE = "etymology_parts"
const ETYMOLOGY_PART_GLOSSES_TABLE = "etymology_part_glosses"
const MAX_MEANINGS_PER_PART = 2
const MAX_ROOT_MATCHES = 2
const MIN_AUTO_PREFIX_LENGTH = 2
const MIN_AUTO_ROOT_LENGTH = 3

let supabaseAdminClient: SupabaseClient | null | undefined
let seedCachePromise: Promise<SeedCache | null> | null = null

/**
 * Oxford raw etymology + Supabase seed から RootLink 用 etymologyData を作る。
 * AI 生成は使わない。
 */
export async function buildEtymologyData(
  params: BuildEtymologyDataParams
): Promise<EtymologyData | null> {
  const headword = sanitiseText(params.headword)
  const rawEtymology = sanitiseText(params.rawEtymology)
  const wordFamily = normaliseWordFamily(params.wordFamily)

  if (!headword) {
    return null
  }

  const seedCache = await loadSeedCache()
  const matches = seedCache ? matchSeedParts(headword, seedCache) : []

  if (matches.length > 0) {
    return buildPartsData({
      rawEtymology,
      wordFamily,
      matches,
    })
  }

  if (!rawEtymology) {
    return null
  }

  return buildOriginData({
    rawEtymology,
    wordFamily,
  })
}

/**
 * parts 型のレスポンスを組み立てる。
 * 既存 shape を壊さないため meaning は英語1本にし、複数意味は " / " で束ねる。
 */
function buildPartsData(input: {
  rawEtymology: string | null
  wordFamily: string[]
  matches: PartMatch[]
}): EtymologyData {
  const parts: RuntimeEtymologyPart[] = input.matches.map((match, index) => ({
    // どこのパートか分かるように prefix はハイフン付きで返す
    text: match.part.partType === "prefix" ? `${match.part.value}-` : match.part.value,
    partType: match.part.partType,
    meaning: joinGlossesEn(match.part.glosses),
    meaningJa: joinGlossesJa(match.part.glosses),
    relatedWords: [],
    order: index + 1,
  }))

  return {
    originLanguage: input.rawEtymology
      ? extractOriginLanguage(input.rawEtymology)
      : null,
    rawEtymology: input.rawEtymology ?? "",
    wordFamily: input.wordFamily,
    structure: {
      type: "parts",
      parts,
      // AI hook は廃止。必要なら FE で rawEtymology を見せる。
      hook: null,
    },
  }
}

/**
 * parts が取れない語は Oxford raw をそのまま活かす。
 */
function buildOriginData(input: {
  rawEtymology: string
  wordFamily: string[]
}): EtymologyData {
  const originLanguage = extractOriginLanguage(input.rawEtymology)
  const origin = extractOriginFromRaw(input.rawEtymology)

  return {
    originLanguage,
    rawEtymology: input.rawEtymology,
    wordFamily: input.wordFamily,
    structure: {
      type: "origin",
      sourceWord: origin.sourceWord,
      sourceMeaning: origin.sourceMeaning,
      hook: null,
    },
  }
}

/**
 * Supabase から seed を一度だけ読む。
 * Cloud Run の env を前提に service role key を使う。
 */
async function loadSeedCache(): Promise<SeedCache | null> {
  if (seedCachePromise) {
    return seedCachePromise
  }

  seedCachePromise = (async () => {
    const supabase = getSupabaseAdminClient()
    if (!supabase) {
      return null
    }

    const [partsResult, glossesResult] = await Promise.all([
      supabase
        .from(ETYMOLOGY_PARTS_TABLE)
        .select("part_key, type, value, sort_order, is_active")
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      supabase
        .from(ETYMOLOGY_PART_GLOSSES_TABLE)
        .select("part_key, gloss_en, gloss_ja, priority, sort_order")
        .order("part_key", { ascending: true })
        .order("priority", { ascending: true })
        .order("sort_order", { ascending: true }),
    ])

    if (partsResult.error || glossesResult.error) {
      return null
    }

    const partsRows = (partsResult.data ?? []) as PartRow[]
    const glossRows = (glossesResult.data ?? []) as GlossRow[]
    const glossesByPartKey = groupGlossesByPartKey(glossRows)

    const seedParts = partsRows
      .filter((row) => row.is_active !== false)
      .map((row) => {
        const partType = normaliseSeedPartType(row.type)
        if (!partType) {
          return null
        }

        const value = sanitiseText(row.value)
        const partKey = sanitiseText(row.part_key)

        if (!value || !partKey) {
          return null
        }

        const glosses = glossesByPartKey.get(partKey) ?? []
        if (glosses.length === 0) {
          return null
        }

        return {
          partKey,
          partType,
          value: value.toLowerCase(),
          sortOrder: typeof row.sort_order === "number" ? row.sort_order : 0,
          glosses,
        } satisfies SeedPart
      })
      .filter((item): item is SeedPart => item !== null)

    const prefixes = seedParts
      .filter((item) => item.partType === "prefix")
      .sort(compareSeedParts)

    const roots = seedParts
      .filter((item) => item.partType === "root")
      .sort(compareSeedParts)

    return {
      prefixes,
      roots,
    }
  })()

  return seedCachePromise
}

/**
 * headword から seed パーツ候補を決める。
 * - prefix は先頭一致の最長1件
 * - root は語中一致で最長優先、最大2件
 */
function matchSeedParts(headword: string, seedCache: SeedCache): PartMatch[] {
  const word = headword.toLowerCase()
  const matches: PartMatch[] = []
  const occupiedRanges: Array<{ start: number; end: number }> = []

  const prefixMatch = findBestPrefixMatch(word, seedCache.prefixes)
  if (prefixMatch) {
    matches.push(prefixMatch)
    occupiedRanges.push({ start: prefixMatch.start, end: prefixMatch.end })
  }

  const rootMatches = findRootMatches(word, seedCache.roots, occupiedRanges)
  matches.push(...rootMatches)

  return matches.sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * prefix は longest match 1件だけ取る。
 * 1文字 prefix は誤爆しやすいので自動抽出しない。
 */
function findBestPrefixMatch(word: string, prefixes: SeedPart[]): PartMatch | null {
  for (const prefix of prefixes) {
    if (prefix.value.length < MIN_AUTO_PREFIX_LENGTH) {
      continue
    }

    if (word.startsWith(prefix.value)) {
      return {
        part: prefix,
        start: 0,
        end: prefix.value.length,
      }
    }
  }

  return null
}

/**
 * root は語中一致を許す。
 * ただし、短すぎる root と prefix との重なりは切る。
 */
function findRootMatches(
  word: string,
  roots: SeedPart[],
  occupiedRanges: Array<{ start: number; end: number }>
): PartMatch[] {
  const matches: PartMatch[] = []

  for (const root of roots) {
    if (matches.length >= MAX_ROOT_MATCHES) {
      break
    }

    if (root.value.length < MIN_AUTO_ROOT_LENGTH) {
      continue
    }

    let fromIndex = 0
    while (fromIndex < word.length) {
      const start = word.indexOf(root.value, fromIndex)
      if (start < 0) {
        break
      }

      const end = start + root.value.length
      const overlapsTakenRange = occupiedRanges.some((range) =>
        rangesOverlap(range.start, range.end, start, end)
      )
      const alreadySelected = matches.some(
        (match) => match.part.partKey === root.partKey
      )

      if (!overlapsTakenRange && !alreadySelected) {
        const nextMatch = {
          part: root,
          start,
          end,
        }

        matches.push(nextMatch)
        occupiedRanges.push({ start, end })
        break
      }

      fromIndex = start + 1
    }
  }

  return matches.sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * gloss を part_key ごとに束ねる。
 */
function groupGlossesByPartKey(rows: GlossRow[]): Map<string, SeedGloss[]> {
  const result = new Map<string, SeedGloss[]>()

  for (const row of rows) {
    const partKey = sanitiseText(row.part_key)
    const glossEn = sanitiseText(row.gloss_en)
    const glossJa = sanitiseText(row.gloss_ja)
    const priority = row.priority === 2 ? 2 : 1
    const sortOrder = typeof row.sort_order === "number" ? row.sort_order : 0

    if (!partKey || !glossEn || !glossJa) {
      continue
    }

    const current = result.get(partKey) ?? []
    current.push({
      glossEn,
      glossJa,
      priority,
      sortOrder,
    })
    result.set(partKey, current)
  }

  for (const [key, glosses] of result) {
    result.set(
      key,
      glosses
        .sort((a, b) => a.priority - b.priority || a.sortOrder - b.sortOrder)
        .slice(0, MAX_MEANINGS_PER_PART)
    )
  }

  return result
}

/**
 * 既存 meaning:string に収めるため、英語 gloss を最大2件だけ束ねる。
 */
function joinGlossesEn(glosses: SeedGloss[]): string | null {
  const values = glosses
    .slice()
    .sort((a, b) => a.priority - b.priority || a.sortOrder - b.sortOrder)
    .slice(0, MAX_MEANINGS_PER_PART)
    .map((item) => item.glossEn)
    .filter(Boolean)

  if (values.length === 0) {
    return null
  }

  return values.join(" / ")
}

/**
 * 日本語 gloss も最大2件だけ束ねる。
 */
function joinGlossesJa(glosses: SeedGloss[]): string | null {
  const values = glosses
    .slice()
    .sort((a, b) => a.priority - b.priority || a.sortOrder - b.sortOrder)
    .slice(0, MAX_MEANINGS_PER_PART)
    .map((item) => item.glossJa)
    .filter(Boolean)

  if (values.length === 0) {
    return null
  }

  return values.join(" / ")
}

/**
 * Oxford raw から sourceWord / sourceMeaning をざっくり拾う。
 */
function extractOriginFromRaw(rawEtymology: string): {
  sourceWord: string | null
  sourceMeaning: string | null
} {
  const raw = normaliseQuotes(rawEtymology)

  const quoteMatch =
    raw.match(
      /\b(?:from|based on|related to|ultimately from|via)\s+([^']+?)\s+'([^']+)'/i
    ) ?? raw.match(/([^']+?)\s+'([^']+)'/)

  if (!quoteMatch) {
    return {
      sourceWord: null,
      sourceMeaning: null,
    }
  }

  const sourceWord = cleanSourceWordCandidate(quoteMatch[1] ?? "")
  const sourceMeaning = sanitiseText(quoteMatch[2] ?? "")

  return {
    sourceWord,
    sourceMeaning,
  }
}

/**
 * sourceWord 候補の余計な前置きを落とす。
 */
function cleanSourceWordCandidate(value: string): string | null {
  let result = normaliseWhitespace(value)
    .replace(
      /^(?:from|based on|related to|plural of|ultimately from|via|the original .*? was)\s+/i,
      ""
    )
    .trim()

  for (const alias of getOriginLanguageAliases()) {
    const prefix = new RegExp(`^${escapeRegExp(alias)}\\s+`, "i")
    result = result.replace(prefix, "").trim()
  }

  result = result
    .replace(/[()[\],;:.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!result) {
    return null
  }

  return result
}

/**
 * Cloud Run env から service role client を作る。
 */
function getSupabaseAdminClient(): SupabaseClient | null {
  if (supabaseAdminClient !== undefined) {
    return supabaseAdminClient
  }

  const supabaseUrl = sanitiseText(process.env.SUPABASE_URL)
  const serviceRoleKey =
    sanitiseText(process.env.SUPABASE_SERVICE_ROLE_KEY) ??
    sanitiseText(process.env.SUPABASE_SERVICE_KEY)

  if (!supabaseUrl || !serviceRoleKey) {
    supabaseAdminClient = null
    return supabaseAdminClient
  }

  supabaseAdminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  return supabaseAdminClient
}

function compareSeedParts(a: SeedPart, b: SeedPart): number {
  return (
    b.value.length - a.value.length ||
    a.sortOrder - b.sortOrder ||
    a.value.localeCompare(b.value)
  )
}

function normaliseSeedPartType(
  value: unknown
): Extract<EtymologyPartType, "prefix" | "root"> | null {
  if (value === "prefix" || value === "root") {
    return value
  }

  return null
}

function rangesOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number
): boolean {
  return startA < endB && startB < endA
}

function sanitiseText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }

  const text = normaliseWhitespace(normaliseQuotes(value)).trim()
  return text.length > 0 ? text : null
}

function normaliseQuotes(value: string): string {
  return value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
}

function normaliseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ")
}

function normaliseWordFamily(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const result: string[] = []

  for (const item of value) {
    const text = sanitiseText(item)
    if (!text) {
      continue
    }

    const key = text.toLowerCase()
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(text)
  }

  return result
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}