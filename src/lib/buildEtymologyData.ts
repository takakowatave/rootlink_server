import type {
    EtymologyData,
    EtymologyPart,
    EtymologyPartType,
  } from "../types/etymology.js"
  
  export type AiJsonGenerator = <T>(_input: {
    systemPrompt: string
    userPrompt: string
  }) => Promise<T>
  
  type BuildEtymologyDataInput = {
    headword: string
    rawEtymology: string | null
    wordFamily: string[]
    aiGenerateJson?: AiJsonGenerator
  }
  
  type EtymologyPartOutput = {
    text: string
    type: EtymologyPartType
    meaning: string
    relatedWords: string[]
  }
  
  type AffixHint = {
    text: string
    type: "prefix" | "suffix"
    meaning: string
  }
  
  const ORIGIN_LANGUAGE_PATTERNS: Array<{
    key: string
    labelEn: string
    labelJa: string
    pattern: RegExp
  }> = [
    {
      key: "latin",
      labelEn: "Latin",
      labelJa: "ラテン語",
      pattern: /\bLatin\b/i,
    },
    {
      key: "greek",
      labelEn: "Greek",
      labelJa: "ギリシャ語",
      pattern: /\bGreek\b/i,
    },
    {
      key: "old_english",
      labelEn: "Old English",
      labelJa: "古英語",
      pattern: /\bOld English\b/i,
    },
    {
      key: "middle_english",
      labelEn: "Middle English",
      labelJa: "中英語",
      pattern: /\bMiddle English\b/i,
    },
    {
      key: "old_french",
      labelEn: "Old French",
      labelJa: "古フランス語",
      pattern: /\bOld French\b/i,
    },
    {
      key: "french",
      labelEn: "French",
      labelJa: "フランス語",
      pattern: /\bFrench\b/i,
    },
    {
      key: "germanic",
      labelEn: "Germanic",
      labelJa: "ゲルマン語",
      pattern: /\bGermanic\b/i,
    },
    {
      key: "proto_indo_european",
      labelEn: "Proto-Indo-European",
      labelJa: "印欧祖語",
      pattern: /\bProto-Indo-European\b|\bPIE\b/i,
    },
    {
      key: "italian",
      labelEn: "Italian",
      labelJa: "イタリア語",
      pattern: /\bItalian\b/i,
    },
    {
      key: "spanish",
      labelEn: "Spanish",
      labelJa: "スペイン語",
      pattern: /\bSpanish\b/i,
    },
  ]
  
  const PREFIX_HINTS: AffixHint[] = [
    { text: "com", type: "prefix", meaning: "together / with" },
    { text: "con", type: "prefix", meaning: "together / with" },
    { text: "co", type: "prefix", meaning: "together / with" },
    { text: "re", type: "prefix", meaning: "again / back" },
    { text: "un", type: "prefix", meaning: "not / opposite" },
    { text: "dis", type: "prefix", meaning: "apart / not" },
    { text: "mis", type: "prefix", meaning: "wrongly / badly" },
    { text: "pre", type: "prefix", meaning: "before" },
    { text: "sub", type: "prefix", meaning: "under / below" },
    { text: "trans", type: "prefix", meaning: "across / through" },
    { text: "inter", type: "prefix", meaning: "between" },
  ]
  
  const SUFFIX_HINTS: AffixHint[] = [
    { text: "ment", type: "suffix", meaning: "result / state / action" },
    { text: "tion", type: "suffix", meaning: "act / process / result" },
    { text: "sion", type: "suffix", meaning: "act / process / result" },
    { text: "ation", type: "suffix", meaning: "act / process / result" },
    { text: "ition", type: "suffix", meaning: "act / process / result" },
    { text: "ity", type: "suffix", meaning: "state / quality" },
    { text: "ness", type: "suffix", meaning: "state / quality" },
    { text: "able", type: "suffix", meaning: "capable of / able to" },
    { text: "ible", type: "suffix", meaning: "capable of / able to" },
    { text: "ful", type: "suffix", meaning: "full of" },
    { text: "less", type: "suffix", meaning: "without" },
  ]
  
  // null / undefined を空文字にそろえる。
  function readString(value: string | null | undefined): string {
    return typeof value === "string" ? value.trim() : ""
  }
  
  // 空文字を除いて重複文字列を取り除く。
  function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
  }
  
  // Oxford 由来の引用符と空白を見やすい形にそろえる。
  function normalizeQuotes(text: string): string {
    return text
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, " ")
      .trim()
  }
  
  // パーツ比較用に token を小文字化して末尾ハイフンを外す。
  function normalizeToken(text: string): string {
    return text.trim().replace(/-+$/, "").toLowerCase()
  }
  
  // token から英字以外を落として比較しやすくする。
  function normalizeLettersOnly(text: string): string {
    return normalizeToken(text).replace(/[^a-z]/g, "")
  }
  
  // 同じ text / meaning / type の重複パーツを取り除く。
  function dedupeParts(parts: EtymologyPartOutput[]): EtymologyPartOutput[] {
    const seen = new Set<string>()
    const result: EtymologyPartOutput[] = []
  
    for (const part of parts) {
      const key = `${part.text.toLowerCase()}__${part.meaning.toLowerCase()}__${part.type}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(part)
    }
  
    return result
  }
  
  // word family からそのパーツを含む関連語だけを拾う。
  function buildRelatedWords(text: string, wordFamily: string[]): string[] {
    const lower = text.toLowerCase()
  
    return uniqueStrings(
      wordFamily.filter((word) => {
        const candidate = word.toLowerCase()
        return candidate !== lower && candidate.includes(lower)
      })
    )
  }
  
  // raw etymology の中から主要な起源言語ラベルを拾う。
  function detectOriginLanguage(
    rawEtymology: string
  ): EtymologyData["originLanguage"] {
    const matched = ORIGIN_LANGUAGE_PATTERNS.find((item) =>
      item.pattern.test(rawEtymology)
    )
  
    if (!matched) {
      return null
    }
  
    return {
      key: matched.key,
      labelEn: matched.labelEn,
      labelJa: matched.labelJa,
    }
  }
  
  // quoted token を prefix / root / suffix のどれとして扱うか決める。
  function classifyQuotedPart(rawToken: string, headword: string): "prefix" | "root" | "suffix" {
    const token = normalizeToken(rawToken)
    const lowerHeadword = headword.toLowerCase()
  
    if (/-\s*$/.test(rawToken) || PREFIX_HINTS.some((hint) => hint.text === token)) {
      return "prefix"
    }
  
    if (SUFFIX_HINTS.some((hint) => hint.text === token) && lowerHeadword.endsWith(token)) {
      return "suffix"
    }
  
    return "root"
  }
  
  // token が headword そのものか、その直近祖語っぽい近さかを判定する。
  function isNearHeadword(token: string, headword: string): boolean {
    const normalizedToken = normalizeLettersOnly(token)
    const normalizedHeadword = normalizeLettersOnly(headword)
  
    if (!normalizedToken || !normalizedHeadword) return false
    if (normalizedToken === normalizedHeadword) return true
  
    const lengthDiff = Math.abs(normalizedToken.length - normalizedHeadword.length)
    if (lengthDiff > 2) return false
  
    return (
      normalizedHeadword.startsWith(normalizedToken) ||
      normalizedToken.startsWith(normalizedHeadword)
    )
  }
  
  // meaning が部品の核意味ではなく説明文っぽいかを判定する。
  function isExplanationLikeMeaning(meaning: string): boolean {
    const normalized = meaning.trim().toLowerCase()
    const wordCount = normalized.split(/\s+/).filter(Boolean).length
  
    if (normalized.includes("core idea in the word")) return true
    if (/^(to|be|being|become|becoming|putting|forming|making|having)\b/.test(normalized)) {
      return true
    }
    if (wordCount >= 3) return true
  
    return false
  }
  
  // パーツとして弱い候補を最初の段階で落とす。
  function isWeakPartCandidate(
    part: EtymologyPartOutput,
    headword: string
  ): boolean {
    const token = normalizeLettersOnly(part.text)
  
    if (token.length <= 1) return true
    if (part.meaning.trim().length === 0) return true
    if (part.meaning.includes("core idea in the word")) return true
  
    if (isNearHeadword(part.text, headword) && isExplanationLikeMeaning(part.meaning)) {
      return true
    }
  
    return false
  }
  
  // 子パーツで説明できる whole-word 候補を UI 用採用から外す。
  function suppressParentLikeParts(
    parts: EtymologyPartOutput[],
    headword: string
  ): EtymologyPartOutput[] {
    return parts.filter((part) => {
      if (!isNearHeadword(part.text, headword)) {
        return true
      }
  
      const childParts = parts.filter((candidate) => {
        if (candidate.text === part.text) return false
        if (normalizeLettersOnly(candidate.text).length >= normalizeLettersOnly(part.text).length) {
          return false
        }
  
        const isUsefulAffix = candidate.type === "prefix" || candidate.type === "suffix"
        const isUsefulRoot =
          candidate.type === "root" &&
          !isNearHeadword(candidate.text, headword) &&
          !isExplanationLikeMeaning(candidate.meaning)
  
        return isUsefulAffix || isUsefulRoot
      })
  
      return childParts.length === 0
    })
  }
  
  // UI に残す価値の高い順にパーツを並べる。
  function scorePart(part: EtymologyPartOutput, headword: string): number {
    let score = 0
  
    if (part.type === "prefix" || part.type === "suffix") score += 4
    if (part.type === "root") score += 2
    if (part.relatedWords.length > 0) score += 2
    if (!isNearHeadword(part.text, headword)) score += 2
    if (!isExplanationLikeMeaning(part.meaning)) score += 2
  
    const tokenLength = normalizeLettersOnly(part.text).length
    if (tokenLength >= 2 && tokenLength <= 6) score += 1
    if (tokenLength >= 10) score -= 1
  
    return score
  }
  
  // 抽出候補から UI に出す強いパーツだけを選び直す。
  function selectUsefulParts(
    headword: string,
    parts: EtymologyPartOutput[]
  ): EtymologyPartOutput[] {
    const filtered = dedupeParts(parts).filter((part) => !isWeakPartCandidate(part, headword))
    const suppressed = suppressParentLikeParts(filtered, headword)
  
    return [...suppressed]
      .sort((a, b) => scorePart(b, headword) - scorePart(a, headword))
      .slice(0, 3)
  }
  
  // parts 表示に十分な強さがあるかをざっくり判定する。
  function shouldUsePartsStructure(
    headword: string,
    parts: EtymologyPartOutput[]
  ): boolean {
    if (parts.length >= 2) return true
  
    if (parts.length === 1) {
      const [part] = parts
      return (
        part.type === "root" &&
        !isNearHeadword(part.text, headword) &&
        !isExplanationLikeMeaning(part.meaning)
      )
    }
  
    return false
  }
  
  // raw etymology の quoted token からパーツ候補を機械的に抜き出す。
  function extractQuotedParts(
    headword: string,
    rawEtymology: string,
    wordFamily: string[]
  ): EtymologyPartOutput[] {
    const text = normalizeQuotes(rawEtymology)
    const parts: EtymologyPartOutput[] = []
  
    const regex = /([A-Za-z]+(?:-)?)(?:\s*-\s*)?\s*'([^']+)'/g
    let match: RegExpExecArray | null = null
  
    while ((match = regex.exec(text)) !== null) {
      const rawToken = match[1] ?? ""
      const meaning = readString(match[2])
  
      const token = normalizeToken(rawToken)
      if (!token || !meaning) continue
  
      parts.push({
        text: token,
        type: classifyQuotedPart(rawToken, headword),
        meaning,
        relatedWords: buildRelatedWords(token, wordFamily),
      })
    }
  
    return dedupeParts(parts)
  }
  
  // quoted が弱いときにだけ使う prefix / suffix の補助候補を作る。
  function extractAffixFallback(
    headword: string,
    wordFamily: string[]
  ): EtymologyPartOutput[] {
    const lowerHeadword = headword.toLowerCase()
    const parts: EtymologyPartOutput[] = []
  
    const prefix = PREFIX_HINTS.find(
      (hint) => lowerHeadword.startsWith(hint.text) && lowerHeadword.length > hint.text.length + 2
    )
  
    if (prefix) {
      parts.push({
        text: prefix.text,
        type: prefix.type,
        meaning: prefix.meaning,
        relatedWords: buildRelatedWords(prefix.text, wordFamily),
      })
    }
  
    const suffix = SUFFIX_HINTS.find(
      (hint) => lowerHeadword.endsWith(hint.text) && lowerHeadword.length > hint.text.length + 2
    )
  
    if (suffix) {
      parts.push({
        text: suffix.text,
        type: suffix.type,
        meaning: suffix.meaning,
        relatedWords: buildRelatedWords(suffix.text, wordFamily),
      })
    }
  
    return dedupeParts(parts)
  }
  
// raw etymology を parts か origin のどちらで返すか最終決定する。
export async function buildEtymologyData(
    input: BuildEtymologyDataInput
  ): Promise<EtymologyData | null> {
    const headword = readString(input.headword)
    const rawEtymology = readString(input.rawEtymology)
    const wordFamily = uniqueStrings(input.wordFamily)
  
    if (!headword) return null
  
    const originLanguage = rawEtymology
      ? detectOriginLanguage(rawEtymology)
      : null
  
    const quotedParts =
      rawEtymology.length > 0
        ? extractQuotedParts(headword, rawEtymology, wordFamily)
        : []
  
    const fallbackParts = extractAffixFallback(headword, wordFamily)
  
    const selectedParts = selectUsefulParts(headword, [
      ...quotedParts,
      ...fallbackParts,
    ])
  
    if (!shouldUsePartsStructure(headword, selectedParts)) {
      return {
        originLanguage,
        rawEtymology: rawEtymology || null,
        wordFamily,
        structure: {
          type: "origin",
          sourceWord: null,
          sourceMeaning: null,
          hook: null,
        },
      }
    }
  
    // EtymologyPartOutput[] を UI 用の EtymologyPart[] に変換する。
    const parts: EtymologyPart[] = selectedParts.map((part, index) => ({
      text: part.text,
      partType: part.type,
      meaning: part.meaning || null,
      meaningJa: null,
      relatedWords: part.relatedWords,
      order: index,
    }))
  
    return {
      originLanguage,
      rawEtymology: rawEtymology || null,
      wordFamily,
      structure: {
        type: "parts",
        parts,
        hook: null,
      },
    }
  }