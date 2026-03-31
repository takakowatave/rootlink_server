/**
 * rewriteDictionary
 *
 * 役割:
 * - normalizeDictionary の結果を受け取る
 * - rewriteDictionaryAI の結果を受け取る
 * - locale payload を組み立てる
 * - dictionary_cache に保存する完成 JSON を返す
 *
 * 注意:
 * - このファイルでは OpenAI を直接呼ばない
 * - 語源パーツの primary source は CSV / Supabase 側
 * - 英語 example は rewrite しない。必ず sourceExample を保持する
 */

import type { NormalizedDictionary } from "./normalizeDictionary.js"
import type { EtymologyData } from "../types/etymology.js"
import { rewriteDictionaryAI } from "./rewriteDictionaryAI.js"
import {
  buildJaLocalePayload,
  type LocalePayload,
} from "./rewriteDictionaryLocale.js"

// MVP で使う対応言語。
type SupportedLocale = "ja"

export type RewrittenSense = {
  senseId: string
  senseNumber: string
  definition: string
  example: string | null

  /**
   * patterns は現時点では空配列固定。
   * 以前 grammar 系へ混入していたため、この段階では復活させない。
   */
  patterns: string[]

  registerCodes: string[]
}

export type RewrittenSenseGroup = {
  partOfSpeech: string
  totalSenseCount: number
  shownSenseCount: number
  hasMoreSenses: boolean
  senses: RewrittenSense[]
}

export type RewrittenDictionary = {
  schemaVersion: number
  word: string
  ipa: string | null
  inflections: string[]
  senseGroups: RewrittenSenseGroup[]
  derivatives: string[]
  etymology: string | null
  etymologyData: EtymologyData | null
  locales: Partial<Record<SupportedLocale, LocalePayload>>
}

const SCHEMA_VERSION = 3

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export async function rewriteDictionary(
  data: NormalizedDictionary
): Promise<RewrittenDictionary> {
  const aiResult = await rewriteDictionaryAI(data)

  const senseGroups: RewrittenSenseGroup[] = data.senseGroups.map((group) => ({
    partOfSpeech: group.partOfSpeech,
    totalSenseCount: group.totalSenseCount,
    shownSenseCount: group.shownSenseCount,
    hasMoreSenses: group.hasMoreSenses,
    senses: group.senses.map((sense) => {
      const rewrittenDefinition =
        readString(aiResult.rewrittenDefinitions.get(sense.senseId)) ||
        sense.definition

      return {
        senseId: sense.senseId,
        senseNumber: sense.senseNumber,
        definition: rewrittenDefinition,

        // example は必ず Oxford 原文を保持する
        example: sense.example || null,

        // patterns は今は無効化
        patterns: [],

        registerCodes: sense.registerCodes,
      }
    }),
  }))

  const jaLocale = buildJaLocalePayload(
    data,
    aiResult.translatedSenses,
    aiResult.translatedEtymology
  )

  return {
    schemaVersion: SCHEMA_VERSION,
    word: data.word,
    ipa: data.ipa,
    inflections: data.inflections,
    senseGroups,
    derivatives: data.derivatives,
    etymology: data.etymology,
    etymologyData: data.etymologyData,
    locales: {
      ja: jaLocale,
    },
  }
}