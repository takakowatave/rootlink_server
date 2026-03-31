/**
 * normalizeDictionary.ts
 *
 * resolveQuery.ts から受け取った Oxford raw と補助データを、
 * rewriteDictionary に渡すための NormalizedDictionary に整形する。
 *
 * このファイルの役割
 * - Oxford raw を安全に読む
 * - ipa / etymology を抽出する
 * - senseGroups を UI 用に整形する
 * - sense ごとの patterns を抽出する
 * - inflections / derivatives を正規化する
 * - etymologyData を buildEtymologyData で生成する
 *
 * 注意
 * - lexicalUnits の抽出はこのファイルでは行わない
 * - lexicalUnits は外側で生成して input から受け取る
 */

import { buildEtymologyData, type AiJsonGenerator } from "./buildEtymologyData.js"
import type { EtymologyData } from "../types/etymology.js"

export type NormalizedSense = {
  // sense をピン留め・クイズ出題するための安定ID
  senseId: string
  senseNumber: string
  definition: string
  example: string | null
  patterns: string[]
}

export type NormalizedSenseGroup = {
  partOfSpeech: string
  totalSenseCount: number
  shownSenseCount: number
  hasMoreSenses: boolean
  senses: NormalizedSense[]
}

export type NormalizedLexicalUnitContext = {
  sourceType: "construction" | "wordFormNote" | "example"
  sourceText: string | null
  parentDefinition: string | null
  parentExample: string | null
  partOfSpeech: string | null
}

export type NormalizedLexicalUnit = {
  lexicalUnitId: string
  text: string
  contexts: NormalizedLexicalUnitContext[]
}

export type NormalizedDictionary = {
  word: string
  ipa: string | null
  inflections: string[]
  senseGroups: NormalizedSenseGroup[]
  lexicalUnits: NormalizedLexicalUnit[]
  derivatives: string[]
  etymology: string | null
  etymologyData: EtymologyData | null
}

export type NormalizeDictionaryInput = {
  word: string
  entries: unknown
  inflections: string[]
  derivatives: string[]
  lexicalUnits: NormalizedLexicalUnit[]
  aiGenerateJson?: AiJsonGenerator
}

/**
 * Oxford raw をこのファイル内で扱いやすい形に寄せた内部型。
 * 外部APIの入口 entries は unknown のまま受け、
 * ここから先だけ安全に整形して使う。
 */
type OxfordTextValue = {
  text?: string
  id?: string
}

type OxfordPronunciation = {
  phoneticSpelling?: string
}

type OxfordNote = {
  type?: string
  text?: string
}

type OxfordExample = {
  text?: string
  notes?: OxfordNote[]
}

type OxfordSense = {
  definitions?: string[]
  shortDefinitions?: string[]
  examples?: OxfordExample[]
  notes?: OxfordNote[]
  subsenses?: OxfordSense[]
  registers?: OxfordTextValue[]
  domains?: OxfordTextValue[]
}

type OxfordEntry = {
  pronunciations?: OxfordPronunciation[]
  etymologies?: string[]
  senses?: OxfordSense[]
}

type OxfordLexicalEntry = {
  text?: string
  pronunciations?: OxfordPronunciation[]
  etymologies?: string[]
  entries?: OxfordEntry[]
  lexicalCategory?: OxfordTextValue
  category?: string
  partOfSpeech?: string
}

type OxfordResult = {
  id?: string
  word?: string
  text?: string
  lexicalEntries?: OxfordLexicalEntry[]
}

/**
 * unknown から string を安全に読む。
 */
function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * object かどうかの基本ガード。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * unknown な配列を、mapper を通して安全な配列に変換する。
 * 読めなかった要素は落とす。
 */
function readArray<T>(
  value: unknown,
  mapper: (item: unknown) => T | null
): T[] {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => mapper(item))
    .filter((item): item is T => item !== null)
}

/**
 * 空文字を除きつつ重複排除する。
 */
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

/**
 * unknown から string[] を安全に読む。
 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return uniqueStrings(
    value.map((item) => readString(item)).filter((item) => item.length > 0)
  )
}

/**
 * Oxford の { text, id } 系または string を内部型に寄せる。
 * registers / domains / lexicalCategory で使う。
 */
function readTextValue(value: unknown): OxfordTextValue | null {
  if (typeof value === "string") {
    const text = value.trim()
    return text ? { text } : null
  }

  if (!isRecord(value)) return null

  const text = readString(value.text)
  const id = readString(value.id)

  if (!text && !id) return null

  return {
    text: text || undefined,
    id: id || undefined,
  }
}

/**
 * pronunciation を読む。
 */
function readPronunciation(value: unknown): OxfordPronunciation | null {
  if (!isRecord(value)) return null

  const phoneticSpelling = readString(value.phoneticSpelling)
  if (!phoneticSpelling) return null

  return { phoneticSpelling }
}

/**
 * note を読む。
 */
function readNote(value: unknown): OxfordNote | null {
  if (!isRecord(value)) return null

  const type = readString(value.type)
  const text = readString(value.text)

  if (!type && !text) return null

  return {
    type: type || undefined,
    text: text || undefined,
  }
}

/**
 * example を読む。
 */
function readExample(value: unknown): OxfordExample | null {
  if (!isRecord(value)) return null

  const text = readString(value.text)
  const notes = readArray(value.notes, readNote)

  if (!text && notes.length === 0) return null

  return {
    text: text || undefined,
    notes: notes.length > 0 ? notes : undefined,
  }
}

/**
 * sense を読む。
 * definitions / examples / notes / subsenses /
 * registers / domains をここで安全な内部型に寄せる。
 */
function readSense(value: unknown): OxfordSense | null {
  if (!isRecord(value)) return null

  const definitions = readStringArray(value.definitions)
  const shortDefinitions = readStringArray(value.shortDefinitions)
  const examples = readArray(value.examples, readExample)
  const notes = readArray(value.notes, readNote)
  const subsenses = readArray(value.subsenses, readSense)
  const registers = readArray(value.registers, readTextValue)
  const domains = readArray(value.domains, readTextValue)

  if (
    definitions.length === 0 &&
    shortDefinitions.length === 0 &&
    examples.length === 0 &&
    notes.length === 0 &&
    subsenses.length === 0 &&
    registers.length === 0 &&
    domains.length === 0
  ) {
    return null
  }

  return {
    definitions: definitions.length > 0 ? definitions : undefined,
    shortDefinitions: shortDefinitions.length > 0 ? shortDefinitions : undefined,
    examples: examples.length > 0 ? examples : undefined,
    notes: notes.length > 0 ? notes : undefined,
    subsenses: subsenses.length > 0 ? subsenses : undefined,
    registers: registers.length > 0 ? registers : undefined,
    domains: domains.length > 0 ? domains : undefined,
  }
}

/**
 * entry を読む。
 */
function readEntry(value: unknown): OxfordEntry | null {
  if (!isRecord(value)) return null

  const pronunciations = readArray(value.pronunciations, readPronunciation)
  const etymologies = readStringArray(value.etymologies)
  const senses = readArray(value.senses, readSense)

  if (
    pronunciations.length === 0 &&
    etymologies.length === 0 &&
    senses.length === 0
  ) {
    return null
  }

  return {
    pronunciations: pronunciations.length > 0 ? pronunciations : undefined,
    etymologies: etymologies.length > 0 ? etymologies : undefined,
    senses: senses.length > 0 ? senses : undefined,
  }
}

/**
 * lexicalEntry を読む。
 */
function readLexicalEntry(value: unknown): OxfordLexicalEntry | null {
  if (!isRecord(value)) return null

  const text = readString(value.text)
  const pronunciations = readArray(value.pronunciations, readPronunciation)
  const etymologies = readStringArray(value.etymologies)
  const entries = readArray(value.entries, readEntry)
  const lexicalCategory = readTextValue(value.lexicalCategory)
  const category = readString(value.category)
  const partOfSpeech = readString(value.partOfSpeech)

  if (
    !text &&
    pronunciations.length === 0 &&
    etymologies.length === 0 &&
    entries.length === 0 &&
    !lexicalCategory &&
    !category &&
    !partOfSpeech
  ) {
    return null
  }

  return {
    text: text || undefined,
    pronunciations: pronunciations.length > 0 ? pronunciations : undefined,
    etymologies: etymologies.length > 0 ? etymologies : undefined,
    entries: entries.length > 0 ? entries : undefined,
    lexicalCategory: lexicalCategory ?? undefined,
    category: category || undefined,
    partOfSpeech: partOfSpeech || undefined,
  }
}

/**
 * result を読む。
 */
function readResult(value: unknown): OxfordResult | null {
  if (!isRecord(value)) return null

  const id = readString(value.id)
  const word = readString(value.word)
  const text = readString(value.text)
  const lexicalEntries = readArray(value.lexicalEntries, readLexicalEntry)

  if (!id && !word && !text && lexicalEntries.length === 0) return null

  return {
    id: id || undefined,
    word: word || undefined,
    text: text || undefined,
    lexicalEntries: lexicalEntries.length > 0 ? lexicalEntries : undefined,
  }
}

/**
 * Oxford raw 全体から results を読む。
 */
function getResults(data: unknown): OxfordResult[] {
  if (!isRecord(data)) return []
  return readArray(data.results, readResult)
}

function getResultHeadword(result: OxfordResult): string {
  return result.id ?? result.word ?? result.text ?? ""
}

function getLexicalEntryHeadword(lexicalEntry: OxfordLexicalEntry): string {
  return lexicalEntry.text ?? ""
}

/**
 * result レベルで対象 headword に近いものを絞る。
 * ADD 混入対策として、まず完全一致を優先する。
 */
function selectMatchingResults(data: unknown, targetWord: string): OxfordResult[] {
  const results = getResults(data)
  if (results.length === 0) return []

  const target = targetWord.trim()
  if (!target) return results

  const exactCase = results.filter((result) => getResultHeadword(result) === target)
  if (exactCase.length > 0) return exactCase

  const lowerTarget = target.toLowerCase()
  const caseInsensitive = results.filter(
    (result) => getResultHeadword(result).toLowerCase() === lowerTarget
  )
  if (caseInsensitive.length > 0) return caseInsensitive

  return results
}

/**
 * lexicalEntry レベルでも対象 headword に近いものを絞る。
 */
function getLexicalEntries(data: unknown, targetWord: string): OxfordLexicalEntry[] {
  const lexicalEntries = selectMatchingResults(data, targetWord).flatMap(
    (result) => result.lexicalEntries ?? []
  )

  if (lexicalEntries.length === 0) return []

  const target = targetWord.trim()
  if (!target) return lexicalEntries

  const entriesWithHeadword = lexicalEntries.filter(
    (lexicalEntry) => getLexicalEntryHeadword(lexicalEntry).length > 0
  )

  if (entriesWithHeadword.length === 0) return lexicalEntries

  const exactCase = entriesWithHeadword.filter(
    (lexicalEntry) => getLexicalEntryHeadword(lexicalEntry) === target
  )
  if (exactCase.length > 0) return exactCase

  const lowerTarget = target.toLowerCase()
  const caseInsensitive = entriesWithHeadword.filter(
    (lexicalEntry) => getLexicalEntryHeadword(lexicalEntry).toLowerCase() === lowerTarget
  )
  if (caseInsensitive.length > 0) return caseInsensitive

  return lexicalEntries
}

function getEntries(lexicalEntry: OxfordLexicalEntry): OxfordEntry[] {
  return lexicalEntry.entries ?? []
}

function getSenses(entry: OxfordEntry): OxfordSense[] {
  return entry.senses ?? []
}

function getTextValueText(value: OxfordTextValue): string {
  return value.text ?? value.id ?? ""
}

/**
 * ipa を抽出する。
 * lexicalEntry 側を先に見て、なければ entry 側を見る。
 */
function extractIPA(lexicalEntries: OxfordLexicalEntry[]): string | null {
  const fromLexicalEntry = lexicalEntries
    .flatMap((lexicalEntry) => lexicalEntry.pronunciations ?? [])
    .map((pronunciation) => pronunciation.phoneticSpelling ?? "")
    .find((value) => value.length > 0)

  if (fromLexicalEntry) return fromLexicalEntry

  const fromEntry = lexicalEntries
    .flatMap((lexicalEntry) => getEntries(lexicalEntry))
    .flatMap((entry) => entry.pronunciations ?? [])
    .map((pronunciation) => pronunciation.phoneticSpelling ?? "")
    .find((value) => value.length > 0)

  return fromEntry ?? null
}

/**
 * etymology を抽出する。
 * entry 側優先、なければ lexicalEntry 側。
 */
function extractEtymology(lexicalEntries: OxfordLexicalEntry[]): string | null {
  const fromEntry = lexicalEntries
    .flatMap((lexicalEntry) => getEntries(lexicalEntry))
    .flatMap((entry) => entry.etymologies ?? [])
    .find((value) => value.length > 0)

  if (fromEntry) return fromEntry

  const fromLexicalEntry = lexicalEntries
    .flatMap((lexicalEntry) => lexicalEntry.etymologies ?? [])
    .find((value) => value.length > 0)

  return fromLexicalEntry ?? null
}

/**
 * sense から代表 definition を1つ取る。
 */
function extractPrimaryDefinition(sense: OxfordSense): string | null {
  const definitions = uniqueStrings([
    ...(sense.definitions ?? []),
    ...(sense.shortDefinitions ?? []),
  ])

  return definitions[0] ?? null
}

/**
 * sense から代表 example を1つ取る。
 */
function extractPrimaryExample(sense: OxfordSense): string | null {
  const examples = uniqueStrings(
    (sense.examples ?? [])
      .map((example) => example.text ?? "")
      .filter((value) => value.length > 0)
  )

  return examples[0] ?? null
}

/**
 * patterns ラベル表示用の軽い正規化。
 */
function normalizePatternsLabel(text: string): string {
  return text.replace(/"/g, "").replace(/\s+/g, " ").trim()
}

/**
 * base sense + subsense を1本化する。
 * ここでは深掘り再帰せず、現在の1段 flatten を維持する。
 */
function flattenSenses(lexicalEntry: OxfordLexicalEntry): OxfordSense[] {
  const baseSenses = getEntries(lexicalEntry).flatMap((entry) => getSenses(entry))
  return baseSenses.flatMap((sense) => [sense, ...(sense.subsenses ?? [])])
}

/**
 * 品詞ラベルを lexicalCategory / category / partOfSpeech から解決する。
 */
function normalizePartOfSpeech(lexicalEntry: OxfordLexicalEntry): string {
  const value =
    lexicalEntry.lexicalCategory?.text ??
    lexicalEntry.lexicalCategory?.id ??
    lexicalEntry.category ??
    lexicalEntry.partOfSpeech ??
    ""

  return value.trim()
}

/**
 * sense ごとの patterns ラベルを作る。
 *
 * 方針
 * - sense ラベルには補助情報だけ残す
 * - lexicalUnit として見せたい constructions はここでは混ぜない
 *
 * 残すもの
 * - registers
 * - domains
 * - notes
 */
function extractPatternsLabels(sense: OxfordSense, word: string): string[] {
  const lowerWord = word.trim().toLowerCase()

  const registers = (sense.registers ?? [])
    .map((item) => normalizePatternsLabel(getTextValueText(item)))
    .filter((value) => value.length > 0)

  const domains = (sense.domains ?? [])
    .map((item) => normalizePatternsLabel(getTextValueText(item)))
    .filter((value) => value.length > 0)

  const noteLabels = (sense.notes ?? [])
    .map((note) => normalizePatternsLabel(note.text ?? ""))
    .filter((value) => value.length > 0)

  return uniqueStrings([
    ...registers,
    ...domains,
    ...noteLabels,
  ]).filter((value) => value.toLowerCase() !== lowerWord)
}

/**
 * Oxford raw を senseGroups に整形する。
 * ここで definition / example / patterns を sense 単位にまとめる。
 */
function extractSenseGroups(
  lexicalEntries: OxfordLexicalEntry[],
  word: string
): NormalizedSenseGroup[] {
  const posMap = new Map<
    string,
    Array<{ definition: string; example: string; patterns: string[] }>
  >()

  for (const lexicalEntry of lexicalEntries) {
    const partOfSpeech = normalizePartOfSpeech(lexicalEntry)
    if (!partOfSpeech) continue

    let bucket = posMap.get(partOfSpeech)
    if (!bucket) {
      bucket = []
      posMap.set(partOfSpeech, bucket)
    }

    for (const sense of flattenSenses(lexicalEntry)) {
      const definition = extractPrimaryDefinition(sense)
      const example = extractPrimaryExample(sense)
      const patterns = extractPatternsLabels(sense, word)

      // 例文がない sense は UI に出さない
      if (!example) continue

      bucket.push({
        definition: definition ?? "",
        example,
        patterns,
      })
    }
  }

  return [...posMap.entries()].map(([partOfSpeech, rawSenses]) => {
    const totalSenseCount = rawSenses.length

    return {
      partOfSpeech,
      totalSenseCount,
      shownSenseCount: totalSenseCount,
      hasMoreSenses: false,
      senses: rawSenses.map((sense, index) => ({
        // headword + pos + index ベースの安定ID
        senseId: `${word.trim().toLowerCase()}__${partOfSpeech.trim().toLowerCase()}__${index + 1}`,
        senseNumber: String(index + 1),
        definition: sense.definition,
        example: sense.example,
        patterns: sense.patterns,
      })),
    }
  })
}

/**
 * lexicalUnit context を安全な shape に寄せる。
 */
function normalizeExternalLexicalUnitContext(
  context: NormalizedLexicalUnitContext
): NormalizedLexicalUnitContext | null {
  const { sourceType } = context

  if (
    sourceType !== "construction" &&
    sourceType !== "wordFormNote" &&
    sourceType !== "example"
  ) {
    return null
  }

  return {
    sourceType,
    sourceText: context.sourceText ?? null,
    parentDefinition: context.parentDefinition ?? null,
    parentExample: context.parentExample ?? null,
    partOfSpeech: context.partOfSpeech ?? null,
  }
}

/**
 * lexicalUnit context の重複判定キーを作る。
 */
function buildLexicalUnitContextKey(
  context: NormalizedLexicalUnitContext
): string {
  return [
    context.sourceType,
    context.sourceText ?? "",
    context.parentDefinition ?? "",
    context.parentExample ?? "",
    context.partOfSpeech ?? "",
  ].join("||")
}

/**
 * lexicalUnits は外部生成なので、このファイルでは
 * - 文字列の基本正規化
 * - context の重複排除
 * だけを行う。
 */
function normalizeExternalLexicalUnits(
  lexicalUnits: NormalizedLexicalUnit[]
): NormalizedLexicalUnit[] {
  const grouped = new Map<string, NormalizedLexicalUnit>()

  for (const lexicalUnit of lexicalUnits) {
    const lexicalUnitId = readString(lexicalUnit.lexicalUnitId)
    const text = readString(lexicalUnit.text)

    if (!lexicalUnitId || !text) continue

    const incomingContexts = Array.isArray(lexicalUnit.contexts)
      ? lexicalUnit.contexts
          .map((context) => normalizeExternalLexicalUnitContext(context))
          .filter(
            (context): context is NormalizedLexicalUnitContext => context !== null
          )
      : []

    const existing = grouped.get(lexicalUnitId)

    if (!existing) {
      const seen = new Set<string>()
      const dedupedContexts: NormalizedLexicalUnitContext[] = []

      for (const context of incomingContexts) {
        const key = buildLexicalUnitContextKey(context)
        if (seen.has(key)) continue
        seen.add(key)
        dedupedContexts.push(context)
      }

      grouped.set(lexicalUnitId, {
        lexicalUnitId,
        text,
        contexts: dedupedContexts,
      })
      continue
    }

    const seen = new Set(
      existing.contexts.map((context) => buildLexicalUnitContextKey(context))
    )

    const mergedContexts = [...existing.contexts]

    for (const context of incomingContexts) {
      const key = buildLexicalUnitContextKey(context)
      if (seen.has(key)) continue
      seen.add(key)
      mergedContexts.push(context)
    }

    grouped.set(lexicalUnitId, {
      lexicalUnitId,
      text: existing.text,
      contexts: mergedContexts,
    })
  }

  return [...grouped.values()]
}

/**
 * normalizeDictionary の本体。
 * Oxford raw + 補助データを RootLink 用の NormalizedDictionary にまとめる。
 *
 * 注意
 * - buildEtymologyData を await するため async
 * - lexicalUnits は input から受け取る
 */
export async function normalizeDictionary(
  input: NormalizeDictionaryInput
): Promise<NormalizedDictionary> {
  const {
    word,
    entries,
    inflections,
    derivatives,
    lexicalUnits,
    aiGenerateJson,
  } = input

  const lexicalEntries = getLexicalEntries(entries, word)
  const normalizedInflections = uniqueStrings(inflections)
  const normalizedDerivatives = uniqueStrings(derivatives)
  const normalizedLexicalUnits = normalizeExternalLexicalUnits(lexicalUnits)
// Oxford から語源文を取る
const extractedEtymology = extractEtymology(lexicalEntries)

// Oxford に語源文がなくても memory hook 生成を止めない
const etymology = extractedEtymology || `from ${word}`

// etymologyData を常に生成する（AIは使わない）
const etymologyData = await buildEtymologyData({
  headword: word,
  rawEtymology: etymology,
  wordFamily: normalizedDerivatives,
})

  return {
    word,
    ipa: extractIPA(lexicalEntries),
    inflections: normalizedInflections,
    senseGroups: extractSenseGroups(lexicalEntries, word),
    lexicalUnits: normalizedLexicalUnits,
    derivatives: normalizedDerivatives,
    etymology,
    etymologyData,
  }
}