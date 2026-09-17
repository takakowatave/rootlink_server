import { getSupabase } from "./supabase.js"

const WORD_BUCKET = "word-audio"
const PHRASE_BUCKET = "phrase-audio"

const GENERIC_WORD_INSTRUCTIONS = (word: string) =>
  `Say only the English word '${word}' in a natural British accent. Speak as one continuous word. Never spell out any letter. Do not say any other word.`

/**
 * IPA から発音 instructions を gpt-4o-mini で1文生成する。
 *
 * 2026-09-16 事故: 旧プロンプトが「rhymes with 'writer'」のように
 * 別の単語を例示させていたため、gpt-4o-mini-tts がその単語を読み上げてしまった。
 * 対策として instruction 中に絶対に他の単語を出さないルールに変更する。
 * 情報として渡すのは強勢の位置だけ。
 */
export async function generateTTSInstructions(word: string, ipa: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return GENERIC_WORD_INSTRUCTIONS(word)

  const system = [
    "You write a pronunciation instruction for an English text-to-speech engine.",
    "Given an English word and its British IPA, produce ONE sentence (under 40 words) telling the TTS how to pronounce it.",
    "STRICT RULES:",
    "- The instruction MUST refer only to the given word. NEVER mention, quote, spell, respell, hint at, or rhyme with any other word.",
    "- NEVER include IPA, phonetic respellings, or invented spellings (never write things like 'di-SIGH-fuh', 'kay-oss', or 'rhymes with X').",
    "- You may state which syllable is stressed (e.g. 'stress on the second syllable') and describe the vowel abstractly (e.g. 'a long \"ee\" sound', 'a short \"a\" sound') but never by comparison to another word.",
    "- Begin the sentence with: Say only the English word '<the given word>'",
    "- End the sentence with: British accent. Speak as one continuous word. Never spell out any letter. Do not say any other word.",
    "Output ONLY the instruction sentence, no quotes, no preamble.",
    "",
    "Example:",
    "Word: decipher  IPA: /dɪˈsʌɪfə/",
    "→ Say only the English word 'decipher' with stress on the second syllable and a long \"eye\" sound in the middle. British accent. Speak as one continuous word. Never spell out any letter. Do not say any other word.",
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
    if (!content) return GENERIC_WORD_INSTRUCTIONS(word)

    // 安全網: 出力に "Say only the English word '<word>'" が含まれていなければ generic に落とす。
    // AI が指示を無視して他語を混ぜてくるパターンに対する最終ガード。
    if (!content.toLowerCase().includes(`say only the english word '${word.toLowerCase()}'`)) {
      console.warn("generateTTSInstructions: safety fallback (missing prefix)", word, content)
      return GENERIC_WORD_INSTRUCTIONS(word)
    }
    return content
  } catch (err) {
    console.error("generateTTSInstructions: unexpected error", err)
    return GENERIC_WORD_INSTRUCTIONS(word)
  }
}

/**
 * headword の mp3 を OpenAI TTS で生成し、Supabase Storage に保存する。
 * 成功時は audioPath（例: "word-audio/agree.mp3"）を返す。
 * 失敗時は null を返す（辞書表示は落とさない）。
 * instructions が渡されればそれを使う。
 *
 * 2026-09-16 事故対策:
 * - 既にストレージに mp3 があれば再生成せずそのパスを返す（上書き禁止）
 * - 並列で同じ単語が来た場合は同じ Promise を共有する（二重生成防止）
 * - upload は upsert:false（race で通り抜けた側も既存を潰さない）
 */
export async function generateTTS(word: string, instructions?: string): Promise<string | null> {
  const storagePath = `${word}.mp3`
  const audioPath = `${WORD_BUCKET}/${storagePath}`

  if (await storageObjectExists(WORD_BUCKET, storagePath)) {
    console.log("TTS SKIP (exists):", audioPath)
    return audioPath
  }

  return withInFlight(audioPath, () =>
    runTTS({
      input: word,
      instructions: instructions || GENERIC_WORD_INSTRUCTIONS(word),
      bucket: WORD_BUCKET,
      storagePath,
      audioPath,
    }),
  )
}

/**
 * example 文の mp3 を OpenAI TTS で生成し phrase-audio bucket に保存する。
 * ファイル名は phrase_card_id 固定。既存があればスキップ。
 */
export async function generatePhraseTTS(
  phraseCardId: string,
  exampleText: string,
): Promise<string | null> {
  const storagePath = `${phraseCardId}.mp3`
  const audioPath = `${PHRASE_BUCKET}/${storagePath}`

  if (await storageObjectExists(PHRASE_BUCKET, storagePath)) {
    console.log("TTS SKIP (exists):", audioPath)
    return audioPath
  }

  const instructions = `Read the following English sentence in a natural, clear British English accent. Speak it as a whole sentence with natural intonation and pacing — not word by word.`

  return withInFlight(audioPath, () =>
    runTTS({
      input: exampleText,
      instructions,
      bucket: PHRASE_BUCKET,
      storagePath,
      audioPath,
    }),
  )
}

/**
 * 単語の sense 例文の mp3 を生成し word-audio bucket に保存する。
 * ファイル名は `example_${senseId}.mp3` 固定。既存があればスキップ。
 */
export async function generateWordExampleTTS(
  senseId: string,
  exampleText: string,
): Promise<string | null> {
  const storagePath = `example_${senseId}.mp3`
  const audioPath = `${WORD_BUCKET}/${storagePath}`

  if (await storageObjectExists(WORD_BUCKET, storagePath)) {
    console.log("TTS SKIP (exists):", audioPath)
    return audioPath
  }

  const instructions = `Read the following English sentence in a natural, clear British English accent. Speak it as a whole sentence with natural intonation and pacing — not word by word.`

  return withInFlight(audioPath, () =>
    runTTS({
      input: exampleText,
      instructions,
      bucket: WORD_BUCKET,
      storagePath,
      audioPath,
    }),
  )
}

/**
 * phrase 見出し（タイトル）の mp3 を生成し phrase-audio bucket に保存する。
 * ファイル名は `${phrase_card_id}_headword.mp3` 固定。既存があればスキップ。
 */
export async function generatePhraseHeadwordTTS(
  phraseCardId: string,
  phraseText: string,
): Promise<string | null> {
  const storagePath = `${phraseCardId}_headword.mp3`
  const audioPath = `${PHRASE_BUCKET}/${storagePath}`

  if (await storageObjectExists(PHRASE_BUCKET, storagePath)) {
    console.log("TTS SKIP (exists):", audioPath)
    return audioPath
  }

  const instructions = `Speak the following English phrase clearly in a British English accent. Say it as one natural chunk — not word by word.`

  return withInFlight(audioPath, () =>
    runTTS({
      input: phraseText,
      instructions,
      bucket: PHRASE_BUCKET,
      storagePath,
      audioPath,
    }),
  )
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
        // 2026-09-16 事故: upsert:true で並列生成が既存を上書きしていた。
        // 既に存在するなら潰さない。存在チェックを通り抜けた側もここで止まる。
        upsert: false,
      })

    if (uploadError) {
      if (isDuplicateStorageError(uploadError)) {
        console.log("TTS EXISTS (race):", audioPath)
        return audioPath
      }
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

/**
 * Supabase Storage に指定パスのオブジェクトが存在するかを確認する。
 * word-audio / phrase-audio はフラットな構造で、ファイル名だけ渡す。
 */
async function storageObjectExists(bucket: string, storagePath: string): Promise<boolean> {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase.storage.from(bucket).list("", {
      search: storagePath,
      limit: 1,
    })
    if (error) {
      console.warn("storageObjectExists: list error, treating as not exists", bucket, storagePath, error)
      return false
    }
    return Array.isArray(data) && data.some((entry) => entry.name === storagePath)
  } catch (err) {
    console.warn("storageObjectExists: unexpected error", bucket, storagePath, err)
    return false
  }
}

function isDuplicateStorageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const err = error as { message?: unknown; statusCode?: unknown; error?: unknown }
  const message = typeof err.message === "string" ? err.message.toLowerCase() : ""
  const statusCode = typeof err.statusCode === "string" ? err.statusCode : ""
  const errorField = typeof err.error === "string" ? err.error.toLowerCase() : ""
  return (
    message.includes("already exists") ||
    message.includes("duplicate") ||
    statusCode === "409" ||
    errorField.includes("duplicate")
  )
}

/**
 * 同じキーの生成 Promise を共有して二重呼び出しを防ぐ。
 * Cloud Run のインスタンスをまたぐ dedupe はできないが、同一インスタンス
 * 内の並列 request（実際の観測ケース）はここで畳める。
 * インスタンス間のレースは storageObjectExists + upsert:false で防ぐ。
 */
const inFlight = new Map<string, Promise<string | null>>()

function withInFlight(
  key: string,
  fn: () => Promise<string | null>,
): Promise<string | null> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = fn().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, promise)
  return promise
}
