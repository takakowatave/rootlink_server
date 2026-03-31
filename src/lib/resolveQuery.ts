import { normalizeWord } from "./normalize.js"
import { getSupabase } from "../lib/supabase.js"
import { generateDerivatives } from "../lib/generateDerivatives.js"
import { normalizeDictionary } from "../lib/normalizeDictionary.js"
import { buildEtymologyData } from "./buildEtymologyData.js"
import {
  rewriteDictionary,
  type RewrittenDictionary,
} from "../lib/rewriteDictionary.js"
import { getLemma } from "./lemma.js"

/**
 * resolveQuery.ts
 *
 * 責務:
 * - 検索フロー全体の司令塔になる
 * - cache / Oxford / suggestion / rewrite / save を順番に制御する
 * - Oxford raw の深い解釈は normalizeDictionary 側へ渡す
 *
 * やらないこと:
 * - Oxford JSON の詳細パース
 * - senseGroups の組み立て
 * - lexicalUnits の抽出
 * - IPA / etymology の抽出
 */

type SuggestCache = Map<string, string | null>

const BASE_URL = "https://od-api.oxforddictionaries.com/api/v2"
const OPENAI_API_URL =
  process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"
const OPENAI_MODEL =
  process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

type DictionaryCacheRow = {
  payload?: unknown
}

type WordRow = {
  id?: unknown
}

type DatamuseSuggestion = {
  word?: unknown
}

const inFlightResolves = new Map<string, Promise<ResolveResult>>()

/* =========================
   Shared helpers
========================= */

/** 文字列だけを残して trim + 重複除去する。 */
function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    ),
  ]
}

/** unknown から安全に文字列を読む。 */
function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** unknown が object かを判定する。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

class OxfordUsageLimitError extends Error {
  constructor() {
    super("OXFORD_USAGE_LIMIT_EXCEEDED")
    this.name = "OxfordUsageLimitError"
  }
}

function assertOpenAIEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required")
  }
}

/* =========================
   OpenAI
========================= */



/* =========================
   Oxford API
========================= */

/** entries を取得する。Oxford raw は保存せず、正規化処理へ渡す。 */
async function fetchEntries(word: string): Promise<unknown | null> {
  console.log("OXFORD ENTRIES START:", word)

  const url = `${BASE_URL}/entries/en-gb/${encodeURIComponent(word)}`
  const res = await fetch(url, {
    headers: {
      app_id: process.env.OXFORD_APP_ID ?? "",
      app_key: process.env.OXFORD_APP_KEY ?? "",
    },
    cache: "no-store",
  })

  console.log("OXFORD ENTRIES STATUS:", word, res.status)

  if (!res.ok) {
    const text = await res.text()
    console.error("OXFORD ENTRIES FAILED:", {
      word,
      status: res.status,
      body: text,
    })

    if (res.status === 429) {
      throw new OxfordUsageLimitError()
    }

    return null
  }

  const json = await res.json()
  console.log("OXFORD ENTRIES OK:", word)
  return json
}

/** inflections API から活用形だけを抽出して返す。 */
async function fetchInflections(word: string): Promise<string[]> {
  console.log("OXFORD INFLECTIONS:", word)

  const res = await fetch(
    `${BASE_URL}/inflections/en-gb/${encodeURIComponent(word)}`,
    {
      headers: {
        app_id: process.env.OXFORD_APP_ID ?? "",
        app_key: process.env.OXFORD_APP_KEY ?? "",
      },
      cache: "no-store",
    }
  )

  if (!res.ok) return []

  const data: unknown = await res.json()
  if (!isRecord(data)) return []

  const results = Array.isArray(data.results) ? data.results : []

  const forms = results.flatMap((result) => {
    if (!isRecord(result)) return []

    const lexicalEntries = Array.isArray(result.lexicalEntries)
      ? result.lexicalEntries
      : []

    return lexicalEntries.flatMap((lexicalEntry) => {
      if (!isRecord(lexicalEntry)) return []

      const inflections = Array.isArray(lexicalEntry.inflections)
        ? lexicalEntry.inflections
        : []

      return inflections
        .map((inflection) =>
          isRecord(inflection) ? readString(inflection.inflectedForm) : ""
        )
        .filter((value) => value.length > 0)
    })
  })

  return uniqueStrings(forms)
}

/** Oxford entries の results[0].id から実headwordを読む。 */
function extractHeadword(entries: unknown): string | null {
  if (!isRecord(entries)) return null

  const results = Array.isArray(entries.results) ? entries.results : []
  const first = results[0]

  if (!isRecord(first)) return null

  const id = first.id
  return typeof id === "string" ? id.trim().toLowerCase() : null
}

/* =========================
   Datamuse suggestion
========================= */

/** typo 候補を 1 件だけ返す。 */
async function getSuggestion(
  word: string,
  cache: SuggestCache
): Promise<string | null> {
  if (cache.has(word)) {
    return cache.get(word) ?? null
  }

  const res = await fetch(
    `https://api.datamuse.com/sug?s=${encodeURIComponent(word)}&max=1`
  )

  if (!res.ok) {
    cache.set(word, null)
    return null
  }

  const data: unknown = await res.json()
  if (!Array.isArray(data)) {
    cache.set(word, null)
    return null
  }

  const first = data[0]
  const suggestion = isRecord(first)
    ? readString((first as DatamuseSuggestion).word).toLowerCase()
    : ""

  if (!suggestion || suggestion === word) {
    cache.set(word, null)
    return null
  }

  cache.set(word, suggestion)
  return suggestion
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

  if (!isRecord(data)) return null

  const row = data as WordRow
  return typeof row.id === "string" ? row.id : null
}

/** words に語がなければ作って id を返す。 */
async function ensureWordId(word: string): Promise<string> {
  const existingId = await findWordId(word)
  if (existingId) return existingId

  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('words')
    .insert({ word })
    .select('id')
    .single()

  if (error || !isRecord(data) || typeof data.id !== "string") {
    throw new Error(`FAILED TO INSERT WORD: ${word}`)
  }

  return data.id
}

/** dictionary_cache から完成済み payload を読む。 */
async function getCachedDictionary(
  word: string
): Promise<RewrittenDictionary | null> {
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

  if (!isRecord(data)) return null

  const row = data as DictionaryCacheRow
  if (!isRecord(row.payload)) return null

  return row.payload as RewrittenDictionary
}

/** 完成済み payload だけを保存する。 */
async function saveDictionary(
  word: string,
  payload: RewrittenDictionary
): Promise<void> {
  const supabase = getSupabase()
  const wordId = await ensureWordId(word)

  const { error } = await supabase.from("dictionary_cache").upsert({
    word_id: wordId,
    payload,
  })

  if (error) {
    throw error
  }
}

/* =========================
   Resolve helpers
========================= */

/** lookup 候補を作る。phrase を先に試し、だめなら先頭語も試す。 */
function buildLookupCandidates(input: string): string[] {
  const values = [input]

  if (input.includes(" ")) {
    const [headword] = input.split(/\s+/)
    values.push(headword)
  }

  return uniqueStrings(values)
}

/** Oxford から整形に必要な材料を集める。 */
async function buildNormalizedDictionary(candidate: string, entries: unknown) {
  const supabase = getSupabase()

  // 語源パーツ取得
  const { data: partsRowsRaw } = await supabase
    .from("etymology_parts")
    .select("*")
    .eq("is_active", true)
    .order("sort_order")

  const { data: glossRowsRaw } = await supabase
    .from("etymology_part_glosses")
    .select("*")
    .order("sort_order")

  const partsRows = Array.isArray(partsRowsRaw) ? partsRowsRaw : []
  const glossRows = Array.isArray(glossRowsRaw) ? glossRowsRaw : []

  const [inflections, derivatives] = await Promise.all([
    fetchInflections(candidate),
    generateDerivatives(candidate).catch((error: unknown) => {
      console.error("GENERATE DERIVATIVES FAILED:", error)
      return [] as string[]
    }),
  ])

  return await normalizeDictionary({
    word: candidate,
    entries,
    inflections,
    derivatives: uniqueStrings(derivatives),
    lexicalUnits: [],
    partsRows,
    glossRows,
  })
}

/** 候補を順に調べ、cache hit なら返し、miss なら Oxford -> normalize -> rewrite -> 保存する。 */
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
    if (!entries) {
      console.log("OXFORD NO ENTRIES:", candidate)
      continue
    }

    // Oxford が返した実headwordを最優先で使う
    const headword = extractHeadword(entries) ?? candidate
    console.log("OXFORD HEADWORD:", { candidate, headword })

    // もし candidate ではなく headword 側の cache が既にあるならそれを返す
    if (headword !== candidate) {
      const canonicalCached = await getCachedDictionary(headword)
      if (canonicalCached) {
        console.log("DICTIONARY CACHE HIT BY HEADWORD:", headword)
        return { resolved: headword, dictionary: canonicalCached }
      }
    }

    console.log("NORMALIZE START:", headword)
    const normalized = await buildNormalizedDictionary(headword, entries)
    console.log("NORMALIZE DONE:", headword)

    console.log("REWRITE START:", headword)
    const dictionary = await rewriteDictionary(normalized)
    console.log("REWRITE DONE:", headword)

    console.log("CACHE SAVE START:", headword)
    await saveDictionary(headword, dictionary)
    console.log("DICTIONARY CACHE SAVED:", headword)

    return { resolved: headword, dictionary }
  }

  return null
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
  | {
      ok: false
      reason: "NO_RESULT"
    }

/** 検索本体。exact/headword -> suggestion の順で解決する。 */
async function resolveQueryInternal(raw: string): Promise<ResolveResult> {
  try {
    console.log("RESOLVE QUERY START:", raw)

    const input = raw.trim().toLowerCase()

    const normalized = normalizeWord(input)
    const candidates = buildLookupCandidates(normalized)

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

    return { ok: false, reason: "NO_RESULT" }
  } catch (error) {
    if (error instanceof OxfordUsageLimitError) {
      console.error("OXFORD USAGE LIMIT EXCEEDED")
      throw error
    }

    throw error
  }
}

export async function resolveQuery(raw: string): Promise<ResolveResult> {
  const key = normalizeWord(raw.trim().toLowerCase())

  const existing = inFlightResolves.get(key)
  if (existing) {
    console.log("RESOLVE QUERY JOIN:", key)
    return existing
  }

  const promise = resolveQueryInternal(raw).finally(() => {
    inFlightResolves.delete(key)
  })

  inFlightResolves.set(key, promise)
  return promise
}