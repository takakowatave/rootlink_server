import { getSupabase } from "./supabase.js"

const TTS_BUCKET = "word-audio"

/**
 * headword の mp3 を OpenAI TTS で生成し、Supabase Storage に保存する。
 * 成功時は audioPath（例: "word-audio/agree.mp3"）を返す。
 * 失敗時は null を返す（辞書表示は落とさない）。
 */
export async function generateTTS(word: string): Promise<string | null> {
  const storagePath = `${word}.mp3`
  const audioPath = `${TTS_BUCKET}/${storagePath}`

  try {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      console.warn("generateTTS: OPENAI_API_KEY not set")
      return null
    }

    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        input: word,
        voice: "alloy",
        instructions: "Speak in British English accent.",
        response_format: "mp3",
      }),
    })

    if (!ttsRes.ok) {
      console.error("generateTTS: OpenAI TTS error", await ttsRes.text())
      return null
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer())

    const supabase = getSupabase()
    const { error: uploadError } = await supabase.storage
      .from(TTS_BUCKET)
      .upload(storagePath, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      })

    if (uploadError) {
      console.error("generateTTS: Storage upload error", uploadError)
      return null
    }

    console.log("TTS SAVED:", audioPath)
    return audioPath
  } catch (err) {
    console.error("generateTTS: unexpected error", err)
    return null
  }
}
