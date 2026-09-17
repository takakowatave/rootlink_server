import { normalizeWord } from "./normalize.js"
import { getSupabase } from "../lib/supabase.js"
import { generateDerivatives } from "../lib/generateDerivatives.js"
import { normalizeDictionary, type NormalizedSenseGroup } from "../lib/normalizeDictionary.js"
import { buildEtymologyData } from "./buildEtymologyData.js"
import {
  rewriteDictionary,
  type RewrittenDictionary,
} from "../lib/rewriteDictionary.js"
import { getLemma } from "./lemma.js"
import { generateSensesAI } from "./generateSensesAI.js"
import { rerankSensesForLearners } from "./rerankSensesForLearners.js"
import { regenerateMissingExamples } from "./rewriteDictionaryAI.js"
import { generateHookForDictionary } from "./generateHookAI.js"
import {
  withOxfordBudget,
  getNegativeEntry,
  saveNegativeEntry,
  bumpNegativeHit,
  OxfordBudgetExceededError,
} from "./oxfordGuard.js"
import { updateDictionaryCachePayload, AUDIO_PRESERVED_KEYS } from "./dictionaryCache.js"

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

/** OpenAI にスペル補正を依頼する。正しいスペルなら null を返す。 */
async function correctSpelling(word: string): Promise<string | null> {
  assertOpenAIEnv()

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a spelling corrector. If the input word is misspelled, return only the correctly spelled English word in lowercase. If it is already correct or not a real English word, return null. Respond with JSON: {\"corrected\": \"word\"} or {\"corrected\": null}.",
        },
        { role: "user", content: word },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  })

  if (!res.ok) return null

  const data: unknown = await res.json()
  if (!isRecord(data)) return null

  const choices = Array.isArray(data.choices) ? data.choices : []
  const message = isRecord(choices[0]) ? choices[0].message : null
  if (!isRecord(message)) return null

  const content = readString(message.content)
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) return null
    const corrected = parsed.corrected
    if (typeof corrected !== "string" || corrected === word) return null
    return corrected.toLowerCase().trim()
  } catch {
    return null
  }
}

/* =========================
   Oxford API
========================= */

/**
 * entries 取得の結果。
 * "not_found" は Oxford に見出しが無いことが確定した状態（ネガティブキャッシュ可）。
 * "error" は通信・サーバー側の一過性障害（ネガティブキャッシュ不可）。
 */
type EntriesResult =
  | { status: "ok"; json: unknown }
  | { status: "not_found" }
  | { status: "error" }

/** entries を取得する。Oxford raw は保存せず、正規化処理へ渡す。 */
async function fetchEntries(word: string): Promise<EntriesResult> {
  console.log("OXFORD ENTRIES START:", word)

  const url = `${BASE_URL}/entries/en-gb/${encodeURIComponent(word)}`

  let res: Response
  try {
    res = await withOxfordBudget(() =>
      fetch(url, {
        headers: {
          app_id: process.env.OXFORD_APP_ID ?? "",
          app_key: process.env.OXFORD_APP_KEY ?? "",
        },
        cache: "no-store",
      })
    )
  } catch (error) {
    // 上限超過は呼び出し側まで伝播させる（キャッシュのみで応答させるため）。
    if (error instanceof OxfordBudgetExceededError) throw error
    console.error("OXFORD ENTRIES THREW:", word, error)
    return { status: "error" }
  }

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

    // 404 のみ「この語は存在しない」と確定できる。
    // 5xx / ネットワーク由来は一過性なので確定扱いにしない。
    if (res.status === 404) return { status: "not_found" }

    return { status: "error" }
  }

  const json = await res.json()
  console.log("OXFORD ENTRIES OK:", word)
  return { status: "ok", json }
}

/** inflections API から活用形だけを抽出して返す。 */
async function fetchInflections(word: string): Promise<string[]> {
  console.log("OXFORD INFLECTIONS:", word)

  let res: Response
  try {
    res = await withOxfordBudget(() =>
      fetch(`${BASE_URL}/inflections/en-gb/${encodeURIComponent(word)}`, {
        headers: {
          app_id: process.env.OXFORD_APP_ID ?? "",
          app_key: process.env.OXFORD_APP_KEY ?? "",
        },
        cache: "no-store",
      })
    )
  } catch (error) {
    // 活用形は無くても辞書は組める。上限超過でも検索自体は続行させる。
    if (error instanceof OxfordBudgetExceededError) {
      console.warn("OXFORD INFLECTIONS SKIPPED (budget):", word)
      return []
    }
    console.error("OXFORD INFLECTIONS THREW:", word, error)
    return []
  }

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

/**
 * dictionary_cache.payload.inflections から入力語を含むエントリーを探す。
 * 米/英綴りの差異（anesthesia ↔ anaesthesia など）を吸収するための救済用。
 */
async function findByInflection(
  input: string
): Promise<{ headword: string; dictionary: RewrittenDictionary } | null> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from("dictionary_cache")
    .select("payload, words(word)")
    .filter("payload->inflections", "cs", JSON.stringify([input]))
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("INFLECTION LOOKUP FAILED:", error)
    return null
  }
  if (!isRecord(data)) return null

  const wordsRel = (data as { words?: unknown }).words
  const headword = isRecord(wordsRel) ? readString(wordsRel.word) : ""
  if (!headword) return null

  const payload = (data as { payload?: unknown }).payload
  if (!isRecord(payload)) return null

  return { headword, dictionary: payload as RewrittenDictionary }
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

/** 完成済み payload だけを保存する。
 *
 * 2026-09-16 事故対策: /audio と /audio/word/example が payload に
 * 追加する audio / ttsInstructions / senseAudioPaths は、この関数の
 * 書き込みで消えないよう、書き込む直前に最新 payload を読み直して
 * 該当キーを引き継いだうえで upsert する。
 */
async function saveDictionary(
  word: string,
  payload: RewrittenDictionary
): Promise<void> {
  const wordId = await ensureWordId(word)

  const { ok } = await updateDictionaryCachePayload(wordId, (latest) => {
    const merged: Record<string, unknown> = { ...(payload as unknown as Record<string, unknown>) }
    if (latest) {
      for (const key of AUDIO_PRESERVED_KEYS) {
        // 入力 payload に無く、DB 側に値があるなら維持する。
        // 入力 payload に既にあるならそちらを尊重する（意図的な差替を許す）。
        if (!(key in merged) && latest[key] !== undefined) {
          merged[key] = latest[key]
        }
      }
    }
    return merged
  })
  if (!ok) {
    throw new Error(`saveDictionary: failed to persist ${word}`)
  }

  // 語源パーツ × 単語のマッピングを蓄積
  if (payload.etymologyData?.structure.type === "parts") {
    const rows = payload.etymologyData.structure.parts
      .map((p) => p.text.toLowerCase().trim())
      .filter((t) => t.length > 0)
      .map((part_text) => ({ part_text, word: word.toLowerCase() }))

    if (rows.length > 0) {
      const supabase = getSupabase()
      await supabase
        .from("etymology_part_words")
        .upsert(rows, { onConflict: "part_text,word" })
    }
  }
}

/**
 * キャッシュ hit した辞書に null example が残っていれば AI で埋めて保存する。
 * Oxford は叩かない。失敗しても original dictionary を返して検索は続行する。
 */
async function hydrateCachedDictionary(
  headword: string,
  dictionary: RewrittenDictionary
): Promise<RewrittenDictionary> {
  const hasMissing = dictionary.senseGroups.some((group) =>
    group.senses.some((sense) => !sense.example || sense.example.trim().length === 0)
  )
  if (!hasMissing) return dictionary

  try {
    const { dictionary: hydrated, regenerated } = await regenerateMissingExamples(
      headword,
      dictionary
    )
    if (regenerated === 0) return dictionary

    await saveDictionary(headword, hydrated)
    console.log("DICTIONARY HYDRATED:", headword, regenerated, "examples added")
    return hydrated
  } catch (error) {
    console.error("HYDRATE CACHED DICTIONARY FAILED:", headword, error)
    return dictionary
  }
}

/**
 * payload.locales.ja.etymology.hook が空なら AI で 1 行フックを生成して保存する。
 * 既存 hook があれば noop。失敗時は元 dictionary を返す。
 */
async function hydrateHookIfMissing(
  headword: string,
  dictionary: RewrittenDictionary
): Promise<RewrittenDictionary> {
  const existing = dictionary.locales?.ja?.etymology?.hook
  if (existing && existing.trim().length > 0) {
    return dictionary
  }

  const jaLocale = dictionary.locales?.ja
  if (!jaLocale) return dictionary

  try {
    const hook = await generateHookForDictionary(headword, dictionary)
    if (!hook) return dictionary

    const updated: RewrittenDictionary = {
      ...dictionary,
      locales: {
        ...dictionary.locales,
        ja: {
          ...jaLocale,
          etymology: {
            ...(jaLocale.etymology ?? {
              originLanguageLabel: null,
              sourceMeaning: null,
              description: null,
              hook: null,
            }),
            hook,
          },
        },
      },
    }

    await saveDictionary(headword, updated)
    console.log("HOOK HYDRATED:", headword, `"${hook}"`)
    return updated
  } catch (error) {
    console.error("HOOK HYDRATION FAILED:", headword, error)
    return dictionary
  }
}

/** キャッシュ hit 時の 2 種の hydration をまとめて実行する。 */
async function hydrateFromCache(
  headword: string,
  dictionary: RewrittenDictionary
): Promise<RewrittenDictionary> {
  const withExamples = await hydrateCachedDictionary(headword, dictionary)
  const withHook = await hydrateHookIfMissing(headword, withExamples)
  return withHook
}

/**
 * /hook endpoint 用のエントリーポイント。
 * キャッシュされている単語について hook 欠落時のみ生成→保存する。
 * OGP 生成側から fire-and-forget で呼ぶことを想定。
 */
export type EnsureHookResult =
  | { ok: true; generated: boolean; hook: string | null }
  | { ok: false; reason: "NOT_CACHED" | "NO_CONTEXT" | "GENERATION_FAILED" }

export async function ensureHookForCachedWord(
  rawWord: string
): Promise<EnsureHookResult> {
  const headword = rawWord.trim().toLowerCase()
  if (!headword) return { ok: false, reason: "NOT_CACHED" }

  const dictionary = await getCachedDictionary(headword)
  if (!dictionary) return { ok: false, reason: "NOT_CACHED" }

  const existing = dictionary.locales?.ja?.etymology?.hook?.trim()
  if (existing) {
    return { ok: true, generated: false, hook: existing }
  }

  const jaLocale = dictionary.locales?.ja
  if (!jaLocale) return { ok: false, reason: "NO_CONTEXT" }

  try {
    const hook = await generateHookForDictionary(headword, dictionary)
    if (!hook) return { ok: false, reason: "GENERATION_FAILED" }

    const updated: RewrittenDictionary = {
      ...dictionary,
      locales: {
        ...dictionary.locales,
        ja: {
          ...jaLocale,
          etymology: {
            ...(jaLocale.etymology ?? {
              originLanguageLabel: null,
              sourceMeaning: null,
              description: null,
              hook: null,
            }),
            hook,
          },
        },
      },
    }

    await saveDictionary(headword, updated)
    console.log("HOOK HYDRATED (endpoint):", headword, `"${hook}"`)
    return { ok: true, generated: true, hook }
  } catch (error) {
    console.error("ENSURE HOOK FAILED:", headword, error)
    return { ok: false, reason: "GENERATION_FAILED" }
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

  // ハイフン語はアンダースコア形式も試す（Oxford は well_known 形式で登録）
  if (input.includes("-")) {
    values.push(input.replace(/-/g, "_"))
  }

  // ハイフンなし複合語 → ハイフンあり形式を試す（pileup → pile-up）
  if (!input.includes("-") && !input.includes(" ") && !input.includes("_")) {
    const COMPOUND_SUFFIXES = [
      "up", "out", "in", "on", "off", "down", "over", "away", "back", "by", "through",
    ]
    for (const suffix of COMPOUND_SUFFIXES) {
      if (input.endsWith(suffix) && input.length > suffix.length + 2) {
        const stem = input.slice(0, input.length - suffix.length)
        values.push(`${stem}-${suffix}`)
      }
    }
  }

  return uniqueStrings(values)
}

/**
 * Oxford の sense データが不十分かどうか判定する。
 *
 * 以下のいずれかに該当する場合に GPT 補完を発動する:
 * 1. senseGroups が空（turtle のように Oxford が何も返さなかった場合）
 * 2. 全 sense に registerCodes があり、中立な sense が一つもない
 *    （goat のように informal/derogatory しか返さなかった場合）
 */
function needsSenseFallback(senseGroups: NormalizedSenseGroup[]): boolean {
  if (senseGroups.length === 0) return true

  const allSenses = senseGroups.flatMap((g) => g.senses)
  if (allSenses.length === 0) return true

  // registerCodes が空 = 中立な sense（informal/derogatory でない）
  const hasNeutralSense = allSenses.some((s) => s.registerCodes.length === 0)
  return !hasNeutralSense
}

/** Oxford entries から最初の lexicalCategory.id を取り出す */
function extractPrimaryPos(entries: unknown): string | undefined {
  try {
    const results = (entries as { results?: unknown[] })?.results
    if (!Array.isArray(results)) return undefined
    for (const result of results) {
      const lexicalEntries = (result as { lexicalEntries?: unknown[] })?.lexicalEntries
      if (!Array.isArray(lexicalEntries)) continue
      for (const le of lexicalEntries) {
        const id = (le as { lexicalCategory?: { id?: string } })?.lexicalCategory?.id
        if (id) return id.toLowerCase()
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Oxford から整形に必要な材料を集める。 */
async function buildNormalizedDictionary(candidate: string, entries: unknown) {
  const supabase = getSupabase()

  const primaryPos = extractPrimaryPos(entries)

  const [inflections, derivatives] = await Promise.all([
    fetchInflections(candidate),
    generateDerivatives(candidate, primaryPos).catch((error: unknown) => {
      console.error("GENERATE DERIVATIVES FAILED:", error)
      return [] as string[]
    }),
  ])

  const normalized = await normalizeDictionary({
    word: candidate,
    entries,
    inflections,
    derivatives: uniqueStrings(derivatives),
    lexicalUnits: [],
    upsertNewParts: async (newParts) => {
      for (const p of newParts) {
        // parts: 既存があればスキップ（first write wins）
        await supabase
          .from("etymology_parts")
          .upsert(
            {
              part_key: p.part_key,
              type: p.type,
              value: p.value,
              sort_order: 999,
              is_active: true,
            },
            { onConflict: "part_key", ignoreDuplicates: true }
          )

        // glosses: 既存があればスキップ（first write wins）
        await supabase
          .from("etymology_part_glosses")
          .upsert(
            [
              {
                part_key: p.part_key,
                locale: "en",
                gloss: p.meaning,
                priority: 1,
                sort_order: 1,
              },
              {
                part_key: p.part_key,
                locale: "ja",
                gloss: p.meaningJa,
                priority: 1,
                sort_order: 1,
              },
            ],
            { onConflict: "part_key,locale,priority", ignoreDuplicates: true }
          )

        console.log("ETYMOLOGY PART SAVED:", p.part_key, p.value, p.type)
      }
    },
  })

  // Oxford データが貧弱な場合は GPT で sense を補完する
  // 生成した sense を先頭に置き、Oxford の register 付き sense を後ろに続ける
  if (needsSenseFallback(normalized.senseGroups)) {
    console.log("SENSE FALLBACK TRIGGERED:", candidate)
    const generatedGroups = await generateSensesAI({
      word: candidate,
      etymologyHint: normalized.etymology,
    })
    return {
      ...normalized,
      senseGroups: [...generatedGroups, ...normalized.senseGroups],
    }
  }

  return normalized
}

type CandidateResolution = {
  result: { resolved: string; dictionary: RewrittenDictionary } | null
  /**
   * 一過性エラー（5xx・通信断）が混ざったか。
   * true のときは「この語は存在しない」と確定できないのでネガティブキャッシュに書かない。
   */
  transientError: boolean
}

/** 候補を順に調べ、cache hit なら返し、miss なら Oxford -> normalize -> rewrite -> 保存する。 */
async function resolveFromCandidates(
  candidates: string[]
): Promise<CandidateResolution> {
  let transientError = false

  for (const candidate of candidates) {
    const cached = await getCachedDictionary(candidate)

    if (cached) {
      console.log("DICTIONARY CACHE HIT:", candidate)
      const hydrated = await hydrateFromCache(candidate, cached)
      return { result: { resolved: candidate, dictionary: hydrated }, transientError }
    }

    console.log("DICTIONARY CACHE MISS:", candidate)

    const entriesResult = await fetchEntries(candidate)

    if (entriesResult.status === "error") {
      // 一過性障害。存在しないと断定できないので記録して次へ。
      console.warn("OXFORD ENTRIES TRANSIENT ERROR:", candidate)
      transientError = true
      continue
    }

    if (entriesResult.status === "not_found") {
      console.log("OXFORD NO ENTRIES:", candidate)
      continue
    }

    const entries = entriesResult.json

    // Oxford が返した実headwordを確認する（"regimented" → "regiment" のようなケース）
    const headword = extractHeadword(entries) ?? candidate
    console.log("OXFORD HEADWORD:", { candidate, headword })

    // headword が candidate と異なる場合（活用形・派生語）:
    // candidate 側にキャッシュがあればそれを使う
    if (headword !== candidate) {
      const candidateCached = await getCachedDictionary(candidate)
      if (candidateCached) {
        console.log("DICTIONARY CACHE HIT BY CANDIDATE:", candidate)
        const hydrated = await hydrateFromCache(candidate, candidateCached)
        return { result: { resolved: candidate, dictionary: hydrated }, transientError }
      }
      // headword 側にキャッシュがあっても candidate で別途保存する（後述）
    }

    // headword 側のキャッシュ確認（headword == candidate の場合はここで return）
    if (headword === candidate) {
      const cached = await getCachedDictionary(headword)
      if (cached) {
        console.log("DICTIONARY CACHE HIT BY HEADWORD:", headword)
        const hydrated = await hydrateFromCache(headword, cached)
        return { result: { resolved: headword, dictionary: hydrated }, transientError }
      }
    }

    // candidate をベースに正規化する。
    // Oxford のデータには "regimented" の形容詞 sense も含まれるため、
    // headword ではなく candidate で正規化することで派生形固有の品詞情報を保持する。
    console.log("NORMALIZE START:", candidate)
    const normalized = await buildNormalizedDictionary(candidate, entries)
    console.log("NORMALIZE DONE:", candidate)

    console.log("RERANK START:", candidate)
    const reranked = await rerankSensesForLearners(normalized)
    console.log("RERANK DONE:", candidate)

    console.log("REWRITE START:", candidate)
    const dictionary = await rewriteDictionary(reranked)
    console.log("REWRITE DONE:", candidate)

    // candidate で保存（例: "regimented"）
    console.log("CACHE SAVE START:", candidate)
    await saveDictionary(candidate, dictionary)
    console.log("DICTIONARY CACHE SAVED:", candidate)

    return { result: { resolved: candidate, dictionary }, transientError }
  }

  return { result: null, transientError }
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
      correctedFrom?: string
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

    // 直近に「該当なし」と確定した入力は、Oxford も OpenAI も叩かずに即返す。
    // ここが無いと、存在しない語がアクセスのたびに従量課金される。
    const negative = await getNegativeEntry(input)
    if (negative) {
      void bumpNegativeHit(input)

      if (negative.outcome === "no_result") {
        console.log("NEGATIVE CACHE HIT (no_result):", input)
        return { ok: false, reason: "NO_RESULT" }
      }

      if (negative.outcome === "corrected" && negative.resolvedTo) {
        const cached = await getCachedDictionary(negative.resolvedTo)
        if (cached) {
          console.log(
            "NEGATIVE CACHE HIT (corrected):",
            input,
            "->",
            negative.resolvedTo
          )
          const hydrated = await hydrateFromCache(negative.resolvedTo, cached)
          return {
            ok: true,
            resolved: negative.resolvedTo,
            changed: true,
            redirectTo: `/word/${negative.resolvedTo}`,
            dictionary: hydrated,
            correctedFrom: input,
          }
        }
        // 補正先のキャッシュが消えている場合のみ通常フローへ落とす。
      }
    }

    // クエリされた原形を最優先で試す。Oxford に独立した見出しがある語
    // （pleading / meeting / building など、-ing/-ed 形が名詞・形容詞でもある語）は
    // その形のまま解決し、固有の品詞・語義を保持する。
    // Oxford に見出しがなければ lemma（基本形）にフォールバックする。
    const lemma = normalizeWord(input)
    const candidates = uniqueStrings([
      ...buildLookupCandidates(input),
      ...(lemma !== input ? buildLookupCandidates(lemma) : []),
    ])

    const direct = await resolveFromCandidates(candidates)

    if (direct.result) {
      return {
        ok: true,
        resolved: direct.result.resolved,
        changed: direct.result.resolved !== input,
        redirectTo: `/word/${direct.result.resolved}`,
        dictionary: direct.result.dictionary,
      }
    }

    // Oxford に該当がない場合、既存の dictionary_cache.inflections から
    // 米/英綴りの差異を吸収する（例: anesthesia → anaesthesia）。
    console.log("INFLECTION LOOKUP ATTEMPT:", input)
    const byInflection = await findByInflection(input)
    if (byInflection) {
      console.log("INFLECTION HIT:", input, "->", byInflection.headword)
      const hydrated = await hydrateFromCache(
        byInflection.headword,
        byInflection.dictionary
      )
      return {
        ok: true,
        resolved: byInflection.headword,
        changed: byInflection.headword !== input,
        redirectTo: `/word/${byInflection.headword}`,
        dictionary: hydrated,
      }
    }

    // Oxford に見つからない場合、OpenAI でスペル補正を試みる
    console.log("SPELL CORRECTION ATTEMPT:", input)
    const corrected = await correctSpelling(input).catch((error: unknown) => {
      console.error("SPELL CORRECTION FAILED:", error)
      return null
    })

    let correctionTransientError = false

    if (corrected && corrected !== input) {
      console.log("SPELL CORRECTED:", input, "->", corrected)
      const correctedCandidates = buildLookupCandidates(corrected)
      const correctedResult = await resolveFromCandidates(correctedCandidates)
      correctionTransientError = correctedResult.transientError

      if (correctedResult.result) {
        // 次回から OpenAI のスペル補正を省けるよう、入力 -> 補正先を記録する。
        await saveNegativeEntry(
          input,
          "corrected",
          correctedResult.result.resolved
        )

        return {
          ok: true,
          resolved: correctedResult.result.resolved,
          changed: true,
          redirectTo: `/word/${correctedResult.result.resolved}`,
          dictionary: correctedResult.result.dictionary,
          correctedFrom: input,
        }
      }
    }

    // 一過性エラーが混ざっていた場合は「存在しない」と確定できないので記録しない。
    if (!direct.transientError && !correctionTransientError) {
      await saveNegativeEntry(input, "no_result")
    } else {
      console.warn("NEGATIVE CACHE SKIPPED (transient error):", input)
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