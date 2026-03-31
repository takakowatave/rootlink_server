/**
 * rewriteDictionaryLocale
 *
 * 役割:
 * - locales.ja を組み立てる
 * - register label の日本語辞書を返す
 * - originLanguageLabel を日本語へ変換する
 *
 * 注意:
 * - AI 呼び出しはしない
 * - 最終 payload 全体は返さない
 * - partMeanings はこのファイルでは組み立てない
 *   （語源パーツの primary source は CSV / Supabase 側）
 */

import type { NormalizedDictionary } from "./normalizeDictionary.js"
import type {
  AISenseTranslation,
  AIEtymologyTranslation,
} from "./rewriteDictionaryAI.js"

export type LocaleSenseItem = {
  meaning: string
  exampleTranslation: string | null
  grammarTags: string[]
}

export type LocaleEtymologyItem = {
  originLanguageLabel: string | null
  hook: string | null
  sourceMeaning: string | null
  description: string | null
}

export type LocalePayload = {
  senses: Record<string, LocaleSenseItem>
  etymology: LocaleEtymologyItem
  registerLabels: Record<string, string>
}

function buildJaLabelMap(): Record<string, string> {
  const pairs: Array<[string, string]> = [
    ["informal", "口語"],
    ["dated", "古風"],
    ["offensive", "侮蔑的"],
    ["derogatory", "軽蔑的"],
    ["vulgar slang", "卑俗"],
    ["vulgar_slang", "卑俗"],
    ["archaic", "古語"],

    ["phonetics", "音声学"],
    ["grammar", "文法"],

    ["mass noun", "不可算名詞"],
    ["uncountable noun", "不可算名詞"],
    ["count noun", "可算名詞"],
    ["transitive", "他動詞"],
    ["intransitive", "自動詞"],
    ["predicative", "叙述用法"],
    ["attributive", "限定用法"],
    ["no object", "目的語を取らない"],
    ["with object", "目的語を取る"],
    ["passive voice", "受動態"],
    ["active voice", "能動態"],
  ]

  const out: Record<string, string> = {}

  for (const [rawKey, ja] of pairs) {
    const trimmed = rawKey.trim()
    const lower = trimmed.toLowerCase()
    const underscored = lower.replace(/\s+/g, "_")

    out[trimmed] = ja
    out[lower] = ja
    out[underscored] = ja
    out[trimmed.charAt(0).toUpperCase() + trimmed.slice(1)] = ja
  }

  return out
}

function mapOriginLanguageLabel(originLanguageKey: string | null): string | null {
  if (!originLanguageKey) return null

  if (originLanguageKey === "old_english") return "古英語"
  if (originLanguageKey === "middle_english") return "中英語"
  if (originLanguageKey === "old_french") return "古フランス語"
  if (originLanguageKey === "french") return "フランス語"
  if (originLanguageKey === "latin") return "ラテン語"
  if (originLanguageKey === "greek") return "ギリシャ語"
  if (originLanguageKey === "germanic") return "ゲルマン語"
  if (originLanguageKey === "proto_indo_european") return "印欧祖語"
  if (originLanguageKey === "italian") return "イタリア語"
  if (originLanguageKey === "spanish") return "スペイン語"

  return null
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function buildJaLocalePayload(
  data: NormalizedDictionary,
  translatedSenses: Map<string, AISenseTranslation>,
  translatedEtymology: AIEtymologyTranslation
): LocalePayload {
  const jaSenses: Record<string, LocaleSenseItem> = {}

  for (const group of data.senseGroups) {
    for (const sense of group.senses) {
      const translated = translatedSenses.get(sense.senseId)

      jaSenses[sense.senseId] = {
        meaning: readString(translated?.meaning),
        exampleTranslation: translated?.exampleTranslation ?? null,
        grammarTags: sense.grammarTags ?? [],
      }
    }
  }

  const etymologyStructure = data.etymologyData?.structure

  const hook =
    translatedEtymology.hookJa ||
    etymologyStructure?.hook ||
    null

  const sourceMeaning =
    translatedEtymology.sourceMeaningJa ||
    (etymologyStructure?.type === "origin"
      ? etymologyStructure.sourceMeaning
      : null)

  return {
    senses: jaSenses,
    etymology: {
      originLanguageLabel: mapOriginLanguageLabel(
        data.etymologyData?.originLanguage?.key ?? null
      ),
      hook,
      sourceMeaning,
      description: translatedEtymology.descriptionJa,
    },
    registerLabels: buildJaLabelMap(),
  }
}