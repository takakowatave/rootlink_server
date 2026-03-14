import { normalizeWord } from "./normalize.js"
import { getSupabase } from "../lib/supabase.js"
import { generateDerivatives } from "../lib/generateDerivatives.js"

/**
 * resolveQuery.ts
 *
 * 検索時の入口。
 * 1. dictionary_cache を確認
 * 2. なければ Oxford を取得
 * 3. 必要項目だけ整形
 * 4. 整形済み JSON を保存して返す
 *
 * ※ Oxford raw は保存しない
 */

type SuggestCache = Map<string, string | null>

const BASE_URL = "https://od-api-sandbox.oxforddictionaries.com/api/v2"

/** sense 単位の整形データ */
type NormalizedSense = {
  senseNumber: string
  definitions: string[]
  examples: string[]
}

/** 品詞単位の整形データ */
type NormalizedLexicalUnit = {
  partOfSpeech: string
  senses: NormalizedSense[]
}

/** dictionary_cache.payload に保存する最終形 */
type NormalizedDictionary = {
  word: string
  ipa: string | null
  inflections: string[]
  lexicalUnits: NormalizedLexicalUnit[]
  derivatives: string[]
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

  return [...new Set(forms.map((v) => v.trim()))]
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

/** definitions / shortDefinitions をまとめる。 */
function extractDefinitions(sense: any): string[] {
  return uniqueStrings([
    ...(sense?.definitions ?? []),
    ...(sense?.shortDefinitions ?? []),
  ])
}

/** examples[].text を抜く。 */
function extractExamples(sense: any): string[] {
  const examples =
    sense?.examples
      ?.map((e: any) => e?.text)
      ?.filter((v: any): v is string => typeof v === "string") ?? []

  return uniqueStrings(examples)
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

/** Oxford の lexicalEntries を RootLink 用 lexicalUnits に変換。 */
function extractLexicalUnits(data: any): NormalizedLexicalUnit[] {
  const lexicalEntries: any[] = (data?.results ?? []).flatMap(
    (r: any) => r?.lexicalEntries ?? []
  )

  return lexicalEntries
    .map((le: any) => {
      const partOfSpeech = normalizePartOfSpeech(le)
      const flattened = flattenSenses(le)

      const senses: NormalizedSense[] = flattened
        .map((sense: any, index: number) => {
          const definitions = extractDefinitions(sense)
          const examples = extractExamples(sense)

          return {
            senseNumber: String(index + 1),
            definitions,
            examples,
          }
        })
        .filter(
          (sense: NormalizedSense) =>
            sense.definitions.length > 0 || sense.examples.length > 0
        )

      return {
        partOfSpeech,
        senses,
      }
    })
    .filter(
      (unit: NormalizedLexicalUnit) =>
        unit.partOfSpeech.length > 0 && unit.senses.length > 0
    )
}

/** 保存用 payload を組み立てる。 */
async function buildDictionaryPayload(
  word: string,
  entries: any
): Promise<NormalizedDictionary> {
  const inflections = await fetchInflections(word)
  const lexicalUnits = extractLexicalUnits(entries)
  const ipa = extractIPA(entries)

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
    lexicalUnits,
    derivatives: uniqueStrings(derivatives),
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

/** dictionary_cache から整形済み payload を読む。 */
async function getCachedDictionary(word: string): Promise<NormalizedDictionary | null> {
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

  return (data?.payload as NormalizedDictionary | null) ?? null
}

/** 整形済み payload だけを保存する。 */
async function saveDictionary(word: string, payload: NormalizedDictionary): Promise<void> {
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
      dictionary: NormalizedDictionary
    }
  | { ok: false; reason: "NO_RESULT" }

/**
 * 検索の本体。
 * cache hit なら返す。
 * miss なら Oxford -> 整形 -> 保存 -> 返す。
 */
export async function resolveQuery(raw: string): Promise<ResolveResult> {
  console.log("RESOLVE QUERY START:", raw)

  const input = raw.trim().toLowerCase()
  const suggestCache: SuggestCache = new Map()

  const normalized = normalizeWord(input)
  const lookup = normalized.split(/\s+/)[0]

  /* 1. cache check */

  const cached = await getCachedDictionary(lookup)

  if (cached) {
    console.log("DICTIONARY CACHE HIT:", lookup)

    return {
      ok: true,
      resolved: lookup,
      changed: lookup !== input,
      redirectTo: `/word/${lookup}`,
      dictionary: cached,
    }
  }

  /* 2. Oxford lookup */

  let entries = await fetchEntries(lookup)

  if (entries) {
    const dictionary = await buildDictionaryPayload(lookup, entries)
    await saveDictionary(lookup, dictionary)

    return {
      ok: true,
      resolved: lookup,
      changed: lookup !== input,
      redirectTo: `/word/${lookup}`,
      dictionary,
    }
  }

  /* 3. suggestion fallback */

  const suggestion = await getSuggestion(normalized, suggestCache)
  if (!suggestion) return { ok: false, reason: "NO_RESULT" }

  entries = await fetchEntries(suggestion)
  if (!entries) return { ok: false, reason: "NO_RESULT" }

  const dictionary = await buildDictionaryPayload(suggestion, entries)
  await saveDictionary(suggestion, dictionary)

  return {
    ok: true,
    resolved: suggestion,
    changed: suggestion !== input,
    redirectTo: `/word/${suggestion}`,
    dictionary,
  }
}