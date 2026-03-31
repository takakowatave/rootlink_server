export type EtymologyStructureType = "parts" | "origin"

export type EtymologyPartType = "prefix" | "root" | "suffix" | "unknown"

export type OriginLanguage = {
  key: string
}

export type EtymologyPart = {
  text: string
  partType: EtymologyPartType
  meaning: string | null
  relatedWords: string[]
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