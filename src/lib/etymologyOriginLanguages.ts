// 語源の由来言語を日英ラベル付きで管理する
export type OriginLanguageKey =
  | "proto-indo-european"
  | "proto-germanic"
  | "late-latin"
  | "medieval-latin"
  | "vulgar-latin"
  | "old-english"
  | "middle-english"
  | "old-french"
  | "middle-french"
  | "old-norse"
  | "old-high-german"
  | "middle-low-german"
  | "old-saxon"
  | "old-irish"
  | "old-church-slavonic"
  | "anglo-norman"
  | "germanic"
  | "latin"
  | "greek"
  | "french"
  | "german"
  | "italian"
  | "spanish"
  | "dutch"
  | "arabic"
  | "persian"
  | "sanskrit"
  | "celtic"

export type OriginLanguageMeta = {
  key: OriginLanguageKey
  labelEn: string
  labelJa: string
  aliases: string[]
}

export type OriginLanguageResult = {
  key: OriginLanguageKey
  labelEn: string
  labelJa: string
}

// raw etymology を読むための正規化辞書
export const ORIGIN_LANGUAGES: OriginLanguageMeta[] = [
  {
    key: "proto-indo-european",
    labelEn: "Proto-Indo-European",
    labelJa: "印欧祖語",
    aliases: ["Proto-Indo-European", "PIE"],
  },
  {
    key: "proto-germanic",
    labelEn: "Proto-Germanic",
    labelJa: "ゲルマン祖語",
    aliases: ["Proto-Germanic"],
  },
  {
    key: "late-latin",
    labelEn: "Late Latin",
    labelJa: "後期ラテン語",
    aliases: ["Late Latin"],
  },
  {
    key: "medieval-latin",
    labelEn: "Medieval Latin",
    labelJa: "中世ラテン語",
    aliases: ["Medieval Latin"],
  },
  {
    key: "vulgar-latin",
    labelEn: "Vulgar Latin",
    labelJa: "俗ラテン語",
    aliases: ["Vulgar Latin"],
  },
  {
    key: "old-english",
    labelEn: "Old English",
    labelJa: "古英語",
    aliases: ["Old English"],
  },
  {
    key: "middle-english",
    labelEn: "Middle English",
    labelJa: "中英語",
    aliases: ["Middle English"],
  },
  {
    key: "old-french",
    labelEn: "Old French",
    labelJa: "古フランス語",
    aliases: ["Old French"],
  },
  {
    key: "middle-french",
    labelEn: "Middle French",
    labelJa: "中期フランス語",
    aliases: ["Middle French"],
  },
  {
    key: "old-norse",
    labelEn: "Old Norse",
    labelJa: "古ノルド語",
    aliases: ["Old Norse"],
  },
  {
    key: "old-high-german",
    labelEn: "Old High German",
    labelJa: "古高ドイツ語",
    aliases: ["Old High German"],
  },
  {
    key: "middle-low-german",
    labelEn: "Middle Low German",
    labelJa: "中低ドイツ語",
    aliases: ["Middle Low German"],
  },
  {
    key: "old-saxon",
    labelEn: "Old Saxon",
    labelJa: "古ザクセン語",
    aliases: ["Old Saxon"],
  },
  {
    key: "old-irish",
    labelEn: "Old Irish",
    labelJa: "古アイルランド語",
    aliases: ["Old Irish"],
  },
  {
    key: "old-church-slavonic",
    labelEn: "Old Church Slavonic",
    labelJa: "古代教会スラヴ語",
    aliases: ["Old Church Slavonic"],
  },
  {
    key: "anglo-norman",
    labelEn: "Anglo-Norman",
    labelJa: "アングロ・ノルマン語",
    aliases: ["Anglo-Norman"],
  },
  {
    key: "germanic",
    labelEn: "Germanic",
    labelJa: "ゲルマン語系",
    aliases: ["Germanic"],
  },
  {
    key: "latin",
    labelEn: "Latin",
    labelJa: "ラテン語",
    aliases: ["Latin"],
  },
  {
    key: "greek",
    labelEn: "Greek",
    labelJa: "ギリシャ語",
    aliases: ["Greek"],
  },
  {
    key: "french",
    labelEn: "French",
    labelJa: "フランス語",
    aliases: ["French"],
  },
  {
    key: "german",
    labelEn: "German",
    labelJa: "ドイツ語",
    aliases: ["German"],
  },
  {
    key: "italian",
    labelEn: "Italian",
    labelJa: "イタリア語",
    aliases: ["Italian"],
  },
  {
    key: "spanish",
    labelEn: "Spanish",
    labelJa: "スペイン語",
    aliases: ["Spanish"],
  },
  {
    key: "dutch",
    labelEn: "Dutch",
    labelJa: "オランダ語",
    aliases: ["Dutch"],
  },
  {
    key: "arabic",
    labelEn: "Arabic",
    labelJa: "アラビア語",
    aliases: ["Arabic"],
  },
  {
    key: "persian",
    labelEn: "Persian",
    labelJa: "ペルシャ語",
    aliases: ["Persian"],
  },
  {
    key: "sanskrit",
    labelEn: "Sanskrit",
    labelJa: "サンスクリット語",
    aliases: ["Sanskrit"],
  },
  {
    key: "celtic",
    labelEn: "Celtic",
    labelJa: "ケルト語系",
    aliases: ["Celtic"],
  },
]

// raw etymology から最初に見つかった由来言語を返す
// raw etymology から source 寄りの由来言語を返す
export function extractOriginLanguage(
    rawEtymology: string
  ): OriginLanguageResult | null {
    const lower = rawEtymology.toLowerCase()
  
    // まず "from Latin", "based on Greek", "via Old French" のような
    // source 導入句の直後に出る言語を優先する
    for (const language of ORIGIN_LANGUAGES) {
      const matched = language.aliases.some((alias) => {
        const escaped = escapeRegExp(alias.toLowerCase())
        const pattern = new RegExp(
          `\\b(?:from|based on|related to|ultimately from|via)\\s+${escaped}\\b`,
          "i"
        )
        return pattern.test(lower)
      })
  
      if (matched) {
        return {
          key: language.key,
          labelEn: language.labelEn,
          labelJa: language.labelJa,
        }
      }
    }
  
    // 導入句で取れなければ従来どおり全体から拾う
    for (const language of ORIGIN_LANGUAGES) {
      const matched = language.aliases.some((alias) =>
        lower.includes(alias.toLowerCase())
      )
  
      if (matched) {
        return {
          key: language.key,
          labelEn: language.labelEn,
          labelJa: language.labelJa,
        }
      }
    }
  
    return null
  }
  
  function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

// buildEtymologyData 側で sourceWord の前置き除去に使う
export function getOriginLanguageAliases(): string[] {
  return ORIGIN_LANGUAGES.flatMap((language) => language.aliases)
}