/**
 * Oxford Dictionaries API から単語の音声 URL だけを取得する軽量ヘルパー。
 * /audio ハンドラのバックフィル用途。
 * Oxford が返す最初の pronunciation.audioFile を返す。無ければ null。
 */

const BASE_URL = "https://od-api.oxforddictionaries.com/api/v2"

export async function fetchOxfordAudioUrl(word: string): Promise<string | null> {
  const appId = process.env.OXFORD_APP_ID
  const appKey = process.env.OXFORD_APP_KEY
  if (!appId || !appKey) return null

  try {
    const url = `${BASE_URL}/entries/en-gb/${encodeURIComponent(word)}`
    const res = await fetch(url, {
      headers: { app_id: appId, app_key: appKey },
      cache: "no-store",
    })
    if (!res.ok) return null

    const data = (await res.json()) as unknown

    if (!isRecord(data)) return null
    const results = Array.isArray(data.results) ? data.results : []

    for (const result of results) {
      if (!isRecord(result)) continue
      const lexicalEntries = Array.isArray(result.lexicalEntries) ? result.lexicalEntries : []
      for (const le of lexicalEntries) {
        if (!isRecord(le)) continue

        const fromLe = readAudioFileFrom(le.pronunciations)
        if (fromLe) return fromLe

        const entries = Array.isArray(le.entries) ? le.entries : []
        for (const entry of entries) {
          if (!isRecord(entry)) continue
          const fromEntry = readAudioFileFrom(entry.pronunciations)
          if (fromEntry) return fromEntry
        }
      }
    }

    return null
  } catch (err) {
    console.error("fetchOxfordAudioUrl error:", err)
    return null
  }
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
