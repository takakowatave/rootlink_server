import { getSupabase } from "./supabase.js"

type Payload = Record<string, unknown>

/**
 * dictionary_cache.payload に対する非破壊的な部分更新。
 *
 * 呼ぶ側は現在の payload を受け取って新しい payload を返す patcher を渡す。
 * この関数は「書き込む直前に」最新の payload を再読込するので、
 * /audio と /audio/word/example のように並列で走る書き込み同士で
 * 古いスナップショットで丸ごと上書きする事故を防ぐ。
 *
 * 注意: DB 側の atomic transaction ではないため、read → write の間に
 * 別リクエストが書いた分は失われうる（数ミリ秒の窓）。
 * ただし従来の「関数開始時のスナップショットで数百ミリ秒後に丸上書き」よりは
 * 桁違いに安全。完全な race-free が要る場合は PostgreSQL 側で
 * jsonb_set の RPC を用意する。
 */
export async function updateDictionaryCachePayload(
  wordId: string,
  patcher: (current: Payload | null) => Payload,
): Promise<{ ok: boolean; payload: Payload | null }> {
  const supabase = getSupabase()

  const { data: latestRow, error: readError } = await supabase
    .from("dictionary_cache")
    .select("payload")
    .eq("word_id", wordId)
    .maybeSingle()

  if (readError) {
    console.error("updateDictionaryCachePayload: read error", readError)
    return { ok: false, payload: null }
  }

  const current = (latestRow?.payload as Payload | null) ?? null
  const next = patcher(current)

  const { error: writeError } = await supabase
    .from("dictionary_cache")
    .upsert(
      { word_id: wordId, payload: next },
      { onConflict: "word_id" },
    )

  if (writeError) {
    console.error("updateDictionaryCachePayload: write error", writeError)
    return { ok: false, payload: null }
  }

  return { ok: true, payload: next }
}

/**
 * /audio 系ハンドラで並列書き込みされうるフィールド。
 * saveDictionary が全体書き換えする際にはこれらを維持する。
 */
export const AUDIO_PRESERVED_KEYS = ["audio", "ttsInstructions", "senseAudioPaths"] as const
