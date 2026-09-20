/**
 * Oxford Dictionaries API から単語の音声 URL だけを取得する軽量ヘルパー。
 * /audio ハンドラのバックフィル用途。
 *
 * 呼び出し側 (/audio) は Oxford が "その語には音声がない" を確定的に返したか、
 * 単に一時的に取れなかったかを区別して扱う必要がある (前者だけ OpenAI TTS
 * フォールバックに回す)。そのため戻り値を判別 union にしている。
 *   - found:     Oxford が音声 URL を返した
 *   - no_audio:  Oxford が正常応答したが、この語に audio がなかった
 *                (404 = 見出し無し / 200 だが audioFile なし)。
 *                この場合のみ OpenAI TTS で埋めて cache 保存する。
 *   - transient: budget 超過 / 429 / 5xx / ネットワーク失敗。
 *                Oxford が復活すれば本物の音声が取れる可能性があるので
 *                フォールバックせず、client には retry-able なエラーを返す。
 *
 * この区別を怠ると、2026-09-16 の事故 (Oxford 停止中に OpenAI が
 * dictionary_cache を上書き) を再現しかねない。
 */

import { withOxfordBudget, OxfordBudgetExceededError } from "./oxfordGuard.js"

const BASE_URL = "https://od-api.oxforddictionaries.com/api/v2"

export type OxfordAudioResult =
  | { status: "found"; audioUrl: string }
  | { status: "no_audio" }
  | { status: "transient" }

export async function fetchOxfordAudioUrl(word: string): Promise<OxfordAudioResult> {
  const appId = process.env.OXFORD_APP_ID
  const appKey = process.env.OXFORD_APP_KEY
  if (!appId || !appKey) return { status: "transient" }

  const url = `${BASE_URL}/entries/en-gb/${encodeURIComponent(word)}`

  let res: Response
  try {
    res = await withOxfordBudget(() =>
      fetch(url, {
        headers: { app_id: appId, app_key: appKey },
        cache: "no-store",
      })
    )
  } catch (error) {
    if (error instanceof OxfordBudgetExceededError) {
      console.warn("OXFORD AUDIO SKIPPED (budget):", word)
      return { status: "transient" }
    }
    console.error("fetchOxfordAudioUrl network error:", error)
    return { status: "transient" }
  }

  // 404 = Oxford にこの見出しが無い。確定的に "音声が存在しない" と扱う。
  if (res.status === 404) return { status: "no_audio" }

  // 429 / 5xx = Oxford 側が一時的に失敗。OpenAI に落とすと後で本物が
  // 取れなくなるので transient として上に返す。
  if (!res.ok) {
    console.warn("fetchOxfordAudioUrl upstream error:", res.status, word)
    return { status: "transient" }
  }

  let data: unknown
  try {
    data = await res.json()
  } catch (err) {
    console.error("fetchOxfordAudioUrl parse error:", err)
    return { status: "transient" }
  }

  if (!isRecord(data)) return { status: "no_audio" }
  const results = Array.isArray(data.results) ? data.results : []

  for (const result of results) {
    if (!isRecord(result)) continue
    const lexicalEntries = Array.isArray(result.lexicalEntries) ? result.lexicalEntries : []
    for (const le of lexicalEntries) {
      if (!isRecord(le)) continue

      const fromLe = readAudioFileFrom(le.pronunciations)
      if (fromLe) return { status: "found", audioUrl: fromLe }

      const entries = Array.isArray(le.entries) ? le.entries : []
      for (const entry of entries) {
        if (!isRecord(entry)) continue
        const fromEntry = readAudioFileFrom(entry.pronunciations)
        if (fromEntry) return { status: "found", audioUrl: fromEntry }
      }
    }
  }

  // 見出しは Oxford にあるが、pronunciation.audioFile が無いケース
  // (Oxford Lite の派生形 "paster" など)。これも確定的に "音声無し"。
  return { status: "no_audio" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readAudioFileFrom(pronunciations: unknown): string | null {
  if (!Array.isArray(pronunciations)) return null
  for (const p of pronunciations) {
    if (!isRecord(p)) continue
    if (typeof p.audioFile === "string" && p.audioFile.length > 0) return p.audioFile
  }
  return null
}
