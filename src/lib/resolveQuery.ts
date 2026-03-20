import { normalizeWord } from "./normalize.js"
import { getSupabase } from "../lib/supabase.js"
import { generateDerivatives } from "../lib/generateDerivatives.js"
import {
  rewriteDictionary,
  type RewrittenDictionary,
} from "../lib/rewriteDictionary.js"

/**
 * resolveQuery.ts
 *
 * 検索時の入口。
 * 1. dictionary_cache を確認
 * 2. なければ Oxford を取得
 * 3. normalizeDictionary で必要項目だけ整形
 * 4. rewriteDictionary で完成済み RootLink JSON に変換する
 * 5. 完成済み JSON を保存して返す
 *
 * ※ Oxford raw は保存しない
 * ※ lexicalUnits は「熟語 / 句」
 * ※ 品詞ごとの sense は senseGroups に分ける
 */

type SuggestCache = Map<string, string | null>

const BASE_URL = "https://od-api-sandbox.oxforddictionaries.com/api/v2"

/** RootLink の 1 sense 表示ブロック（現状は Oxford 側の区切りにかなり近い） */
export type NormalizedSense = {
  senseNumber: string
  definition: string
  example: string | null
}

/** 品詞ごとの sense 群 */
export type NormalizedSenseGroup = {
  partOfSpeech: string
  totalSenseCount: number
  shownSenseCount: number
  hasMoreSenses: boolean
  senses: NormalizedSense[]
}

/** 熟語 / 句 */
export type NormalizedLexicalUnit = {
  lexicalUnitId: string
  text: string
}

/** normalizeDictionary が返す中間形 */
export type NormalizedDictionary = {
  word: string
  ipa: string | null
  inflections: string[]
  senseGroups: NormalizedSenseGroup[]
  lexicalUnits: NormalizedLexicalUnit[]
  derivatives: string[]
  etymology: string | null
}

/* =========================
   Oxford API
========================= */

/** entries を取得。返るのは生レスポンスだが保存はしない。 */
async function fetchEntries(word: string): Promise<any | null> {
  console.log("OXFORD ENTRIES:", word)

  const res = await fetch(
    `${BASE_URL}/entries/en-gb/${encodeURIComponent(word)}`,
    {
      headers: {
        app_id: process.env.OXFORD_APP_ID!,
        app_key: process.env.OXFORD_APP_KEY!,
      },
      cache: "no-store",
    }
  )

  if (!res.ok) return null
  return res.json()
}

/** inflections API から活用形を抽出して返す。 */
async function fetchInflections(word: string): Promise<string[]> {
  console.log("OXFORD INFLECTIONS:", word)

  const res = await fetch(
    `${BASE_URL}/inflections/en-gb/${encodeURIComponent(word)}`,
    {
      headers: {
        app_id: process.env.OXFORD_APP_ID!,
        app_key: process.env.OXFORD_APP_KEY!,
      },
      cache: "no-store",
    }
  )

  if (!res.ok) return []

  const data = await res.json()

  const forms: string[] =
    data?.results
      ?.flatMap((r: any) => r?.lexicalEntries ?? [])
      ?.flatMap((le: any) => le?.inflections ?? [])
      ?.map((i: any) => i?.inflectedForm)
      ?.filter((v: any): v is string => typeof v === "string" && v.trim().length > 0) ?? []

  return uniqueStrings(forms)
}

/* =========================
   Datamuse suggestion
========================= */

/** typo 候補を 1 件だけ返す。 */
async function getSuggestion(
  word: string,
  cache: SuggestCache
): Promise<string | null> {
  if (cache.has(word)) return cache.get(word) ?? null

  const res = await fetch(
    `https://api.datamuse.com/sug?s=${encodeURIComponent(word)}&max=1`
  )

  if (!res.ok) {
    cache.set(word, null)
    return null
  }

  const data = await res.json()
  const cand = (data?.[0]?.word ?? "").toLowerCase()

  if (!cand || cand === word) {
    cache.set(word, null)
    return null
  }

  cache.set(word, cand)
  return cand
}

/* =========================
   Normalizers
========================= */

/** trim・空除外・重複除去。 */
function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(
    values
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  )]
}

/** lexicalUnitId 用の簡易 ID。 */
function toStableId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

/** IPA を 1 つだけ取る。優先: lexicalEntry -> entry */
function extractIPA(data: any): string | null {
  const lexicalEntries: any[] = (data?.results ?? []).flatMap(
    (r: any) => r?.lexicalEntries ?? []
  )

  const fromLexicalEntry = lexicalEntries
    .flatMap((le: any) => le?.pronunciations ?? [])
    .map((p: any) => p?.phoneticSpelling)
    .find((v: any) => typeof v === "string" && v.trim().length > 0)

  if (fromLexicalEntry) return fromLexicalEntry.trim()

  const fromEntry = lexicalEntries
    .flatMap((le: any) => le?.entries ?? [])
    .flatMap((entry: any) => entry?.pronunciations ?? [])
    .map((p: any) => p?.phoneticSpelling)
    .find((v: any) => typeof v === "string" && v.trim().length > 0)

  if (fromEntry) return fromEntry.trim()

  return null
}

/** etymology を 1 つだけ取る。 */
function extractEtymology(data: any): string | null {
  const lexicalEntries: any[] = (data?.results ?? []).flatMap(
    (r: any) => r?.lexicalEntries ?? []
  )

  const fromEntry = lexicalEntries
    .flatMap((le: any) => le?.entries ?? [])
    .flatMap((entry: any) => entry?.etymologies ?? [])
    .find((v: any) => typeof v === "string" && v.trim().length > 0)

  if (fromEntry) return fromEntry.trim()

  const fromLexicalEntry = lexicalEntries
    .flatMap((le: any) => le?.etymologies ?? [])
    .find((v: any) => typeof v === "string" && v.trim().length > 0)

  if (fromLexicalEntry) return fromLexicalEntry.trim()

  return null
}

/** definitions / shortDefinitions から最初の 1 件を取る。 */
function extractPrimaryDefinition(sense: any): string | null {
  const definitions = uniqueStrings([
    ...(sense?.definitions ?? []),
    ...(sense?.shortDefinitions ?? []),
  ])

  return definitions[0] ?? null
}

/** examples[].text から最初の 1 件を取る。 */
function extractPrimaryExample(sense: any): string | null {
  const examples =
    sense?.examples
      ?.map((e: any) => e?.text)
      ?.filter((v: any): v is string => typeof v === "string") ?? []

  const unique = uniqueStrings(examples)
  return unique[0] ?? null
}

/** senses と subsenses を 1 本に並べる。 */
function flattenSenses(le: any): any[] {
  const baseSenses: any[] = (le?.entries ?? []).flatMap(
    (entry: any) => entry?.senses ?? []
  )

  return baseSenses.flatMap((sense: any) => [
    sense,
    ...(sense?.subsenses ?? []),
  ])
}

/** 品詞文字列を吸収して返す。 */
function normalizePartOfSpeech(le: any): string {
  const value =
    le?.lexicalCategory?.text ??
    le?.lexicalCategory?.id ??
    le?.lexicalCategory ??
    le?.category ??
    ""

  return typeof value === "string" ? value.trim() : ""
}

/** 品詞ごとの sense 群を作る。 */
function extractSenseGroups(data: any): NormalizedSenseGroup[] {
  const lexicalEntries: any[] = (data?.results ?? []).flatMap(
    (r: any) => r?.lexicalEntries ?? []
  )

  const posMap = new Map<string, Array<{ definition: string; example: string | null }>>()

  for (const le of lexicalEntries) {
    const partOfSpeech = normalizePartOfSpeech(le)
    if (!partOfSpeech) continue

    const flattened = flattenSenses(le)

    const items = flattened
      .map((sense: any) => {
        const definition = extractPrimaryDefinition(sense)
        const example = extractPrimaryExample(sense)

        if (!definition && !example) return null

        return {
          definition: definition ?? "",
          example,
        }
      })
      .filter((item): item is { definition: string; example: string | null } => item !== null)

    if (items.length === 0) continue

    const existing = posMap.get(partOfSpeech) ?? []
    posMap.set(partOfSpeech, [...existing, ...items])
  }

  return [...posMap.entries()].map(([partOfSpeech, rawSenses]) => {
    const totalSenseCount = rawSenses.length

    return {
      partOfSpeech,
      totalSenseCount,
      shownSenseCount: totalSenseCount,
      hasMoreSenses: false,
      senses: rawSenses.map((sense, index) => ({
        senseNumber: String(index + 1),
        definition: sense.definition,
        example: sense.example,
      })),
    }

    return {
      partOfSpeech,
      totalSenseCount,
      shownSenseCount: totalSenseCount,
      hasMoreSenses: false,
      senses: rawSenses.map((sense, index) => ({
        senseNumber: String(index + 1),
        definition: sense.definition,
        example: sense.example,
      })),
    }
  })
}

/**
 * 熟語 / 句を抽出する。
 * ここでは主に
 * - lexicalEntry.phrases
 * - entry.phrases
 * - sense.constructions
 * を拾う
 */
function extractLexicalUnits(data: any, word: string): NormalizedLexicalUnit[] {
  const lexicalEntries: any[] = (data?.results ?? []).flatMap(
    (r: any) => r?.lexicalEntries ?? []
  )

  const collected: string[] = []

  for (const le of lexicalEntries) {
    const lePhrases =
      le?.phrases
        ?.map((p: any) => p?.text)
        ?.filter((v: any): v is string => typeof v === "string") ?? []

    collected.push(...lePhrases)

    const entryPhrases =
      (le?.entries ?? []).flatMap((entry: any) =>
        entry?.phrases
          ?.map((p: any) => p?.text)
          ?.filter((v: any): v is string => typeof v === "string") ?? []
      ) ?? []

    collected.push(...entryPhrases)

    const constructions =
      flattenSenses(le).flatMap((sense: any) =>
        sense?.constructions
          ?.map((c: any) => c?.text)
          ?.filter((v: any): v is string => typeof v === "string") ?? []
      ) ?? []

    collected.push(...constructions)
  }

  const unique = uniqueStrings(collected).filter(
    (text) => text.toLowerCase() !== word.toLowerCase()
  )

  return unique.map((text) => ({
    lexicalUnitId: toStableId(text),
    text,
  }))
}

/** normalizeDictionary 本体。Oxford raw は保存せず、中間形だけ返す。 */
async function normalizeDictionary(
  word: string,
  entries: any
): Promise<NormalizedDictionary> {
  const inflections = await fetchInflections(word)
  const senseGroups = extractSenseGroups(entries)
  const lexicalUnits = extractLexicalUnits(entries, word)
  const ipa = extractIPA(entries)
  const etymology = extractEtymology(entries)

  let derivatives: string[] = []
  try {
    derivatives = await generateDerivatives(word)
  } catch (error) {
    console.error("GENERATE DERIVATIVES FAILED:", error)
  }

  return {
    word,
    ipa,
    inflections,
    senseGroups,
    lexicalUnits,
    derivatives: uniqueStrings(derivatives),
    etymology,
  }
}

/* =========================
   DB helpers
========================= */

/** words テーブルから word の id を取る。 */
async function findWordId(word: string): Promise<string | null> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from("words")
    .select("id")
    .eq("word", word)
    .maybeSingle()

  if (error) {
    console.error("FIND WORD ID FAILED:", error)
    return null
  }

  return data?.id ?? null
}

/** words に語がなければ作って id を返す。 */
async function ensureWordId(word: string): Promise<string> {
  const existingId = await findWordId(word)
  if (existingId) return existingId

  const supabase = getSupabase()

  const { data, error } = await supabase
    .from("words")
    .insert({ word })
    .select("id")
    .single()

  if (error || !data?.id) {
    throw new Error(`FAILED TO INSERT WORD: ${word}`)
  }

  return data.id
}

/** dictionary_cache から完成済み payload を読む。 */
async function getCachedDictionary(word: string): Promise<RewrittenDictionary | null> {
  const supabase = getSupabase()

  const wordId = await findWordId(word)
  if (!wordId) return null

  const { data, error } = await supabase
    .from("dictionary_cache")
    .select("payload")
    .eq("word_id", wordId)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("CACHE READ FAILED:", error)
    return null
  }

  return (data?.payload as RewrittenDictionary | null) ?? null
}

/** 完成済み payload だけを保存する。 */
async function saveDictionary(word: string, payload: RewrittenDictionary): Promise<void> {
  const supabase = getSupabase()
  const wordId = await ensureWordId(word)

  const { error } = await supabase
    .from("dictionary_cache")
    .upsert({
      word_id: wordId,
      payload,
    })

  if (error) {
    throw error
  }
}

/* =========================
   Public API
========================= */

export type ResolveResult =
  | {
      ok: true
      resolved: string
      changed: boolean
      redirectTo: string
      dictionary: RewrittenDictionary
    }
  | { ok: false; reason: "NO_RESULT" }

/** lookup 候補。phrase を先に試し、だめなら先頭語も試す。 */
function buildLookupCandidates(input: string): string[] {
  const values = [input]

  if (input.includes(" ")) {
    values.push(input.split(/\s+/)[0])
  }

  return uniqueStrings(values)
}

/** 候補を順に調べ、cache にあれば返し、なければ Oxford API で取得する。 */
async function resolveFromCandidates(
  candidates: string[]
): Promise<{ resolved: string; dictionary: RewrittenDictionary } | null> {
  for (const candidate of candidates) {
    const cached = await getCachedDictionary(candidate)

    if (cached) {
      console.log("DICTIONARY CACHE HIT:", candidate)
      return { resolved: candidate, dictionary: cached }
    }

    console.log("DICTIONARY CACHE MISS:", candidate)

    const entries = await fetchEntries(candidate)
    if (!entries) continue

    const normalized = await normalizeDictionary(candidate, entries)
    const dictionary = await rewriteDictionary(normalized)

    await saveDictionary(candidate, dictionary)
    console.log("DICTIONARY CACHE SAVED:", candidate)

    return { resolved: candidate, dictionary }
  }

  return null
}
/**
 * 検索の本体。
 * cache hit なら返す。
 * miss なら Oxford -> normalize -> rewrite -> 保存 -> 返す。
 */
export async function resolveQuery(raw: string): Promise<ResolveResult> {
  console.log("RESOLVE QUERY START:", raw)

  const input = raw.trim().toLowerCase()
  const suggestCache: SuggestCache = new Map()

  const normalized = normalizeWord(input)
  const candidates = buildLookupCandidates(normalized)

  /* 1. exact / headword lookup */
  const direct = await resolveFromCandidates(candidates)

  if (direct) {
    return {
      ok: true,
      resolved: direct.resolved,
      changed: direct.resolved !== input,
      redirectTo: `/word/${direct.resolved}`,
      dictionary: direct.dictionary,
    }
  }

  /* 2. suggestion fallback */
  const suggestionBase =
    normalized.includes(" ") ? normalized.split(/\s+/)[0] : normalized

  const suggestion = await getSuggestion(suggestionBase, suggestCache)
  if (!suggestion) return { ok: false, reason: "NO_RESULT" }

  const suggested = await resolveFromCandidates([suggestion])
  if (!suggested) return { ok: false, reason: "NO_RESULT" }

  return {
    ok: true,
    resolved: suggested.resolved,
    changed: suggested.resolved !== input,
    redirectTo: `/word/${suggested.resolved}`,
    dictionary: suggested.dictionary,
  }
}