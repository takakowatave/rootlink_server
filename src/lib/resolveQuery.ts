// lib/resolveQuery.ts
import { normalizeWord, normalizeLexicalUnit } from "./normalize.js"

/*
  resolveQuery

  責務:
  - ユーザー入力(raw query)を「保存してよい正規形」に解決する（単語 / 熟語両対応）
  - 生成(AI)の前段で呼ばれ、typo をDBに入れない
  - typo の場合は「近い正しい語」を見つけて返す
  - 最終的な redirect 先を決定する（実行はしない）
*/

type ExistsCache = Map<string, boolean>
type SuggestCache = Map<string, string | null>

function isSingleWord(s: string) {
  return /^[a-z]+$/.test(s)
}
function isWordToken(s: string) {
  return /^[a-z]+$/.test(s)
}

/** 辞書APIで「その単語が実在するか」だけを判定する */
async function wordExists(word: string, cache: ExistsCache): Promise<boolean> {
  const key = word
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const res = await fetch(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
    { cache: "no-store" }
  )
  const ok = res.status === 200
  cache.set(key, ok)
  return ok
}

/** Datamuseで「近い候補」を1件だけ取る */
async function getSuggestion(word: string, cache: SuggestCache): Promise<string | null> {
  const key = word
  if (cache.has(key)) return cache.get(key) ?? null

  const res = await fetch(
    `https://api.datamuse.com/sug?s=${encodeURIComponent(word)}&max=1`,
    { cache: "no-store" }
  )

  if (!res.ok) {
    cache.set(key, null)
    return null
  }

  const data = await res.json()
  const cand = (data?.[0]?.word ?? "").toLowerCase()

  if (!cand || !isSingleWord(cand) || cand === word) {
    cache.set(key, null)
    return null
  }

  cache.set(key, cand)
  return cand
}

/** 単語を解決 */
async function resolveWord(
  raw: string,
  existsCache: ExistsCache,
  suggestCache: SuggestCache
): Promise<string | null> {
  const normalized = normalizeWord(raw)

  if (isSingleWord(normalized) && (await wordExists(normalized, existsCache))) {
    return normalized
  }

  if (!isSingleWord(normalized)) return null

  const suggestion = await getSuggestion(normalized, suggestCache)
  if (!suggestion) return null

  if (await wordExists(suggestion, existsCache)) return suggestion

  return null
}

/** 熟語を解決 */
async function resolveLexicalUnit(
  raw: string,
  existsCache: ExistsCache,
  suggestCache: SuggestCache
): Promise<string | null> {
  const normalized = normalizeLexicalUnit(raw)
  const tokens = normalized.split(/(\s+|-)/)

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]

    if (t.trim() === "" || t === "-" || /^\s+$/.test(t)) continue
    if (!isWordToken(t)) continue

    if (await wordExists(t, existsCache)) continue

    const suggestion = await getSuggestion(t, suggestCache)
    if (!suggestion) return null

    if (!(await wordExists(suggestion, existsCache))) return null

    tokens[i] = suggestion
  }

  return tokens.join("")
}

export type ResolveResult =
  | {
      ok: true
      resolved: string
      changed: boolean
      kind: "word" | "lexical_unit"
      redirectTo: string
    }
  | { ok: false; reason: "NO_SUGGESTION" }

export async function resolveQuery(raw: string): Promise<ResolveResult> {
  const input = raw.trim().toLowerCase()

  const existsCache: ExistsCache = new Map()
  const suggestCache: SuggestCache = new Map()

  // 単語
  if (isSingleWord(input)) {
    const resolved = await resolveWord(input, existsCache, suggestCache)
    if (!resolved) return { ok: false, reason: "NO_SUGGESTION" }

    return {
      ok: true,
      resolved,
      changed: resolved !== input,
      kind: "word",
      redirectTo: `/word/${resolved}`,
    }
  }

  // 熟語
  const resolvedLU = await resolveLexicalUnit(input, existsCache, suggestCache)
  if (!resolvedLU) return { ok: false, reason: "NO_SUGGESTION" }

  return {
    ok: true,
    resolved: resolvedLU,
    changed: resolvedLU !== input,
    kind: "lexical_unit",
    redirectTo: `/lexical-unit/${resolvedLU.replace(/\s+/g, "-")}`,
  }
}