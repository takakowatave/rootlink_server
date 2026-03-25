export type EtymologyStructureType = "parts" | "origin"

export type EtymologyPartType = "prefix" | "root" | "suffix" | "unknown"

export type OriginLanguage = {
  key: string
  labelEn: string
  labelJa: string
}

export type EtymologyPart = {
  // パーツ文字列そのもの
  text: string
  // prefix / root / suffix / unknown
  partType: EtymologyPartType
  // 英英の短い意味
  meaning: string | null
  // 日英トグル用の短い日本語意味
  meaningJa?: string | null
  // 親族語・関連語
  relatedWords: string[]
  // 表示順
  order: number
}

export type PartsEtymologyStructure = {
  type: "parts"
  // 分類付きパーツ配列
  parts: EtymologyPart[]
  // 学習フック
  hook: string | null
}

export type OriginEtymologyStructure = {
  type: "origin"
  // 分解しない語源語・由来語
  sourceWord: string | null
  // その短い意味
  sourceMeaning: string | null
  // 学習フック
  hook: string | null
}

export type EtymologyData = {
  // Oxford 由来の語源言語
  originLanguage: OriginLanguage | null
  // Oxford raw etymology
  rawEtymology: string | null
  // 語族・派生語のまとまり
  wordFamily: string[]
  // parts か origin か
  structure: PartsEtymologyStructure | OriginEtymologyStructure
}