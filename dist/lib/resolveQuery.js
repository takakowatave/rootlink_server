// lib/resolveQuery.ts
import { normalizeWord, normalizeLexicalUnit } from "./normalize.js";
function isSingleWord(s) {
    return /^[a-z]+$/.test(s);
}
function isWordToken(s) {
    return /^[a-z]+$/.test(s);
}
/* =========================
   Oxford Sandbox Base URL
========================= */
const BASE_URL = "https://od-api.oxforddictionaries.com/api/v2";
/* =========================
   Oxford API 呼び出し
========================= */
async function fetchDictionary(word, cache) {
    if (cache.has(word)) {
        return cache.get(word) ?? null;
    }
    try {
        console.log("=== OXFORD FETCH START ===", word);
        console.log("APP_ID exists:", !!process.env.OXFORD_APP_ID);
        console.log("APP_KEY exists:", !!process.env.OXFORD_APP_KEY);
        const res = await fetch(`${BASE_URL}/entries/en-gb/${encodeURIComponent(word)}`, {
            headers: {
                app_id: process.env.OXFORD_APP_ID,
                app_key: process.env.OXFORD_APP_KEY,
            },
            cache: "no-store",
        });
        console.log("OXFORD STATUS:", res.status);
        const rawText = await res.text();
        console.log("OXFORD RAW TEXT:", rawText);
        if (!res.ok) {
            cache.set(word, null);
            return null;
        }
        const data = JSON.parse(rawText);
        console.log("OXFORD RAW JSON:", JSON.stringify(data, null, 2));
        if (!data?.results?.length) {
            cache.set(word, null);
            return null;
        }
        cache.set(word, data);
        return data;
    }
    catch (e) {
        console.error("OXFORD FETCH ERROR:", e);
        cache.set(word, null);
        return null;
    }
}
/* =========================
   Datamuse typo suggestion
========================= */
async function getSuggestion(word, cache) {
    if (cache.has(word))
        return cache.get(word) ?? null;
    const res = await fetch(`https://api.datamuse.com/sug?s=${encodeURIComponent(word)}&max=1`, { cache: "no-store" });
    if (!res.ok) {
        cache.set(word, null);
        return null;
    }
    const data = await res.json();
    const cand = (data?.[0]?.word ?? "").toLowerCase();
    if (!cand || !isSingleWord(cand) || cand === word) {
        cache.set(word, null);
        return null;
    }
    cache.set(word, cand);
    return cand;
}
/* =========================
   単語解決
========================= */
async function resolveWord(raw, dictCache, suggestCache) {
    const normalized = normalizeWord(raw);
    if (!isSingleWord(normalized))
        return null;
    const dict = await fetchDictionary(normalized, dictCache);
    if (dict) {
        return { resolved: normalized, dictionary: dict };
    }
    const suggestion = await getSuggestion(normalized, suggestCache);
    if (!suggestion)
        return null;
    const dict2 = await fetchDictionary(suggestion, dictCache);
    if (dict2) {
        return { resolved: suggestion, dictionary: dict2 };
    }
    return null;
}
/* =========================
   熟語解決
========================= */
async function resolveLexicalUnit(raw, dictCache, suggestCache) {
    const normalized = normalizeLexicalUnit(raw);
    const tokens = normalized.split(/(\s+|-)/);
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.trim() === "" || t === "-" || /^\s+$/.test(t))
            continue;
        if (!isWordToken(t))
            continue;
        const exists = await fetchDictionary(t, dictCache);
        if (exists)
            continue;
        const suggestion = await getSuggestion(t, suggestCache);
        if (!suggestion)
            return null;
        const exists2 = await fetchDictionary(suggestion, dictCache);
        if (!exists2)
            return null;
        tokens[i] = suggestion;
    }
    return tokens.join("");
}
export async function resolveQuery(raw) {
    const input = raw.trim().toLowerCase();
    const dictCache = new Map();
    const suggestCache = new Map();
    if (isSingleWord(input)) {
        const result = await resolveWord(input, dictCache, suggestCache);
        if (!result)
            return { ok: false, reason: "NO_SUGGESTION" };
        return {
            ok: true,
            resolved: result.resolved,
            changed: result.resolved !== input,
            kind: "word",
            redirectTo: `/word/${result.resolved}`,
            dictionary: result.dictionary,
        };
    }
    const resolvedLU = await resolveLexicalUnit(input, dictCache, suggestCache);
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
