// lib/resolveQuery.ts
import { normalizeWord, normalizeLexicalUnit } from "./normalize.js";
function isSingleWord(s) {
    return /^[a-z]+$/.test(s);
}
function isWordToken(s) {
    return /^[a-z]+$/.test(s);
}
/** 辞書APIで「その単語が実在するか」だけを判定する */
async function wordExists(word, cache) {
    const key = word;
    const hit = cache.get(key);
    if (hit !== undefined)
        return hit;
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { cache: "no-store" });
    const ok = res.status === 200;
    cache.set(key, ok);
    return ok;
}
/** Datamuseで「近い候補」を1件だけ取る */
async function getSuggestion(word, cache) {
    const key = word;
    if (cache.has(key))
        return cache.get(key) ?? null;
    const res = await fetch(`https://api.datamuse.com/sug?s=${encodeURIComponent(word)}&max=1`, { cache: "no-store" });
    if (!res.ok) {
        cache.set(key, null);
        return null;
    }
    const data = await res.json();
    const cand = (data?.[0]?.word ?? "").toLowerCase();
    if (!cand || !isSingleWord(cand) || cand === word) {
        cache.set(key, null);
        return null;
    }
    cache.set(key, cand);
    return cand;
}
/** 単語を解決 */
async function resolveWord(raw, existsCache, suggestCache) {
    const normalized = normalizeWord(raw);
    if (isSingleWord(normalized) && (await wordExists(normalized, existsCache))) {
        return normalized;
    }
    if (!isSingleWord(normalized))
        return null;
    const suggestion = await getSuggestion(normalized, suggestCache);
    if (!suggestion)
        return null;
    if (await wordExists(suggestion, existsCache))
        return suggestion;
    return null;
}
/** 熟語を解決 */
async function resolveLexicalUnit(raw, existsCache, suggestCache) {
    const normalized = normalizeLexicalUnit(raw);
    const tokens = normalized.split(/(\s+|-)/);
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.trim() === "" || t === "-" || /^\s+$/.test(t))
            continue;
        if (!isWordToken(t))
            continue;
        if (await wordExists(t, existsCache))
            continue;
        const suggestion = await getSuggestion(t, suggestCache);
        if (!suggestion)
            return null;
        if (!(await wordExists(suggestion, existsCache)))
            return null;
        tokens[i] = suggestion;
    }
    return tokens.join("");
}
export async function resolveQuery(raw) {
    const input = raw.trim().toLowerCase();
    const existsCache = new Map();
    const suggestCache = new Map();
    // 単語
    if (isSingleWord(input)) {
        const resolved = await resolveWord(input, existsCache, suggestCache);
        if (!resolved)
            return { ok: false, reason: "NO_SUGGESTION" };
        return {
            ok: true,
            resolved,
            changed: resolved !== input,
            kind: "word",
            redirectTo: `/word/${resolved}`,
        };
    }
    // 熟語
    const resolvedLU = await resolveLexicalUnit(input, existsCache, suggestCache);
    if (!resolvedLU)
        return { ok: false, reason: "NO_SUGGESTION" };
    return {
        ok: true,
        resolved: resolvedLU,
        changed: resolvedLU !== input,
        kind: "lexical_unit",
        redirectTo: `/lexical-unit/${resolvedLU.replace(/\s+/g, "-")}`,
    };
}
