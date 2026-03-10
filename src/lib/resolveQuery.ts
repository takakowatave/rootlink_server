import { normalizeWord } from "./normalize.js"
import { getSupabase } from "../lib/supabase.js"
import { generateDerivatives } from "../lib/generateDerivatives.js"

type SuggestCache = Map<string, string | null>

const BASE_URL = "https://od-api-sandbox.oxforddictionaries.com/api/v2"

/* Oxford entries */
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

/* Oxford inflections */
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
      ?.flatMap((r: any) => r.lexicalEntries ?? [])
      ?.flatMap((le: any) => le.inflections ?? [])
      ?.map((i: any) => i?.inflectedForm)
      ?.filter((v: any): v is string => typeof v === "string") ?? []

  return [...new Set(forms)]
}

/* Datamuse typo suggestion */
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
   Oxford derivatives
========================= */

function extractDerivatives(data: any): string[] {
  const lexicalEntries: any[] = (data?.results ?? []).flatMap(
    (r: any) => r?.lexicalEntries ?? []
  )

  const nodes: any[] = lexicalEntries.flatMap((le: any) => [
    le,
    ...(le?.entries ?? []),
    ...(le?.entries ?? []).flatMap((e: any) => e?.senses ?? []),
    ...(le?.entries ?? [])
      .flatMap((e: any) => e?.senses ?? [])
      .flatMap((s: any) => s?.subsenses ?? []),
  ])

  const derivatives: string[] = nodes
    .flatMap((node: any) => node?.derivatives ?? [])
    .map((d: any) => d?.text)
    .filter((v: any) => typeof v === "string" && v.trim().length > 0)
    .map((v: string) => v.trim())

  return [...new Set(derivatives)]
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
      dictionary: any
    }
  | { ok: false; reason: "NO_RESULT" }

export async function resolveQuery(raw: string): Promise<ResolveResult> {

  const supabase = getSupabase()

  console.log("RESOLVE QUERY START:", raw)

  const input = raw.trim().toLowerCase()
  const suggestCache: SuggestCache = new Map()

  const normalized = normalizeWord(input)
  const lookup = normalized.split(/\s+/)[0]

  /* cache check */

  const { data: cachedWord } = await supabase
    .from("words")
    .select("id")
    .eq("word", lookup)
    .maybeSingle()

  if (cachedWord) {
    const { data: cached } = await supabase
      .from("oxford_raw")
      .select("payload")
      .eq("word_id", cachedWord.id)
      .limit(1)
      .maybeSingle()

    if (cached?.payload) {
      console.log("OXFORD CACHE HIT:", lookup)

      return {
        ok: true,
        resolved: lookup,
        changed: lookup !== input,
        redirectTo: `/word/${lookup}`,
        dictionary: cached.payload,
      }
    }
  }

  /* Oxford lookup */

  let entries = await fetchEntries(lookup)

  if (entries) {

    const inflections = await fetchInflections(lookup)

    const etymology =
      entries?.results?.[0]?.lexicalEntries?.[0]?.entries?.[0]?.etymologies?.[0]

    let derivatives = extractDerivatives(entries)

    if (derivatives.length === 0) {
      console.log("OXFORD DERIVATIVES EMPTY → AI GENERATION")
      derivatives = await generateDerivatives(lookup)
    }

    console.log("RESOLVE DERIVATIVES", derivatives)

    const dictionary = {
      ...entries,
      inflections,
      etymology,
      derivatives,
    }

    let wordId = cachedWord?.id

    if (!wordId) {
      const { data } = await supabase
        .from("words")
        .insert({ word: lookup })
        .select("id")
        .single()

      wordId = data!.id
    }

    await supabase.from("oxford_raw").upsert({
      word_id: wordId,
      payload: dictionary,
    })

    return {
      ok: true,
      resolved: lookup,
      changed: lookup !== input,
      redirectTo: `/word/${lookup}`,
      dictionary,
    }
  }

  /* suggestion fallback */

  const suggestion = await getSuggestion(normalized, suggestCache)

  if (!suggestion) return { ok: false, reason: "NO_RESULT" }

  entries = await fetchEntries(suggestion)
  if (!entries) return { ok: false, reason: "NO_RESULT" }

  const inflections = await fetchInflections(suggestion)

  const etymology =
    entries?.results?.[0]?.lexicalEntries?.[0]?.entries?.[0]?.etymologies?.[0]

  let derivatives = extractDerivatives(entries)

  if (derivatives.length === 0) {
    derivatives = await generateDerivatives(suggestion)
  }

  const dictionary = {
    ...entries,
    inflections,
    etymology,
    derivatives,
  }

  const { data: wordRow } = await supabase
    .from("words")
    .select("id")
    .eq("word", suggestion)
    .maybeSingle()

  let wordId = wordRow?.id

  if (!wordId) {
    const { data } = await supabase
      .from("words")
      .insert({ word: suggestion })
      .select("id")
      .single()

    wordId = data!.id
  }

  await supabase.from("oxford_raw").upsert({
    word_id: wordId,
    payload: dictionary,
  })

  return {
    ok: true,
    resolved: suggestion,
    changed: suggestion !== input,
    redirectTo: `/word/${suggestion}`,
    dictionary,
  }
}