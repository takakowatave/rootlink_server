import { getSupabase } from "./supabase.js"

const WORD_BUCKET = "word-audio"
const PHRASE_BUCKET = "phrase-audio"

const GENERIC_WORD_INSTRUCTIONS = (word: string) =>
  `Say the English word '${word}' in a natural British accent. Speak as one continuous word. Never spell out any letter.`

/**
 * IPA から発音 instructions を gpt-4o-mini で1文生成する。
 * respelling / IPA は書かせず、実在する英単語との押韻で誘導する（gpt-4o-mini-tts が respelling を綴り読みするのを回避）。
 */
export async function generateTTSInstructions(word: string, ipa: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return GENERIC_WORD_INSTRUCTIONS(word)

  const system = [
    "You write a pronunciation instruction for an English text-to-speech engine.",
    "Given a word and its British IPA, produce ONE sentence (under 40 words) that will make the TTS say it correctly.",
    "STRICT RULES:",
    "- Reference a REAL COMMON English word that rhymes or shares the key vowel sound (e.g. 'rhymes with writer', 'the second syllable sounds like nine').",
    "- NEVER include phonetic respellings, IPA, or quoted made-up spellings (never write things like 'di-SIGH-fuh' or 'kay-oss').",
    "- State which syllable is stressed.",
    "- Always end with: 'British accent. Speak as one continuous word. Never spell out any letter.'",
    "Output ONLY the instruction sentence, no quotes, no preamble.",
    "",
    "Example:",
    "Word: decipher  IPA: /dɪˈsʌɪfə/",
    "→ Say the English word 'decipher' with stress on the second syllable; it rhymes with 'writer'. British accent. Speak as one continuous word. Never spell out any letter.",
  ].join("\n")

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Word: ${word}  IPA: /${ipa}/` },
        ],
      }),
    })
    if (!res.ok) {
      console.error("generateTTSInstructions: OpenAI error", await res.text())
      return GENERIC_WORD_INSTRUCTIONS(word)
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content?.trim()
    return content || GENERIC_WORD_INSTRUCTIONS(word)
  } catch (err) {
    console.error("generateTTSInstructions: unexpected error", err)
    return GENERIC_WORD_INSTRUCTIONS(word)
  }
}

/**
 * headword の mp3 を OpenAI TTS で生成し、Supabase Storage に保存する。
 * 成功時は audioPath（例: "word-audio/agree.mp3"）を返す。
 * 失敗時は null を返す（辞書表示は落とさない）。
 * instructions が渡されればそれを使う（呼び出し側でキャッシュ管理）。渡されなければ generic を使う。
 */
export async function generateTTS(word: string, instructions?: string): Promise<string | null> {
  const storagePath = `${word}.mp3`
  const audioPath = `${WORD_BUCKET}/${storagePath}`

  return runTTS({
    input: word,
    instructions: instructions || GENERIC_WORD_INSTRUCTIONS(word),
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

/**
 * 単語の sense 例文の mp3 を生成し word-audio bucket に保存する。
 * ファイル名は `example_${senseId}.mp3` 固定。
 */
export async function generateWordExampleTTS(
  senseId: string,
  exampleText: string,
): Promise<string | null> {
  const storagePath = `example_${senseId}.mp3`
  const audioPath = `${WORD_BUCKET}/${storagePath}`

  const instructions = `Read the following English sentence in a natural, clear British English accent. Speak it as a whole sentence with natural intonation and pacing — not word by word.`

  return runTTS({
    input: exampleText,
    instructions,
    bucket: WORD_BUCKET,
    storagePath,
    audioPath,
  })
}

/**
 * phrase 見出し（タイトル）の mp3 を生成し phrase-audio bucket に保存する。
 * ファイル名は `${phrase_card_id}_headword.mp3` 固定。
 */
export async function generatePhraseHeadwordTTS(
  phraseCardId: string,
  phraseText: string,
): Promise<string | null> {
  const storagePath = `${phraseCardId}_headword.mp3`
  const audioPath = `${PHRASE_BUCKET}/${storagePath}`

  const instructions = `Speak the following English phrase clearly in a British English accent. Say it as one natural chunk — not word by word.`

  return runTTS({
    input: phraseText,
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
