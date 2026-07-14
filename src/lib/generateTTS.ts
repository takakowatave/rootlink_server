import { getSupabase } from "./supabase.js"

const WORD_BUCKET = "word-audio"
const PHRASE_BUCKET = "phrase-audio"

/**
 * headword の mp3 を OpenAI TTS で生成し、Supabase Storage に保存する。
 * 成功時は audioPath（例: "word-audio/agree.mp3"）を返す。
 * 失敗時は null を返す（辞書表示は落とさない）。
 */
export async function generateTTS(word: string, ipa?: string): Promise<string | null> {
  const storagePath = `${word}.mp3`
  const audioPath = `${WORD_BUCKET}/${storagePath}`

  const instructions = ipa
    ? `Pronounce the single English word "${word}" in British English. IPA: /${ipa}/. Speak it as one word — do not split into parts.`
    : `Speak the single English word "${word}" in a clear British English accent. Say it as one whole word.`

  return runTTS({
    input: word,
    instructions,
    bucket: WORD_BUCKET,
    storagePath,
    audioPath,
  })
}

/**
 * example 文の mp3 を OpenAI TTS で生成し phrase-audio bucket に保存する。
 * ファイル名は phrase_card_id 固定。
 */
export async function generatePhraseTTS(
  phraseCardId: string,
  exampleText: string,
): Promise<string | null> {
  const storagePath = `${phraseCardId}.mp3`
  const audioPath = `${PHRASE_BUCKET}/${storagePath}`

  const instructions = `Read the following English sentence in a natural, clear British English accent. Speak it as a whole sentence with natural intonation and pacing — not word by word.`

  return runTTS({
    input: exampleText,
    instructions,
    bucket: PHRASE_BUCKET,
    storagePath,
    audioPath,
  })
}

type RunTTSArgs = {
  input: string
  instructions: string
  bucket: string
  storagePath: string
  audioPath: string
}

async function runTTS({ input, instructions, bucket, storagePath, audioPath }: RunTTSArgs): Promise<string | null> {
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
        input,
        voice: "shimmer",
        instructions,
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
      .from(bucket)
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
