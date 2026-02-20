/*
  routeClassifier.ts

  役割：
  - 正規化済みの検索語を受け取る
  - 単語か熟語かを判定する
  - ルーティング決定専用（生成ロジックには関与しない）

  前提：
  - 入力は trim / lowercase 済み
*/

export type RouteType = 'WORD' | 'LEXICAL_UNIT'

export type RouteClassification = {
  type: RouteType
  normalized: string
}

export function classifyRoute(input: string): RouteClassification {
  const normalized = input.trim().toLowerCase()

  // スペースが含まれていれば熟語
  if (normalized.includes(' ')) {
    return {
      type: 'LEXICAL_UNIT',
      normalized,
    }
  }

  // それ以外は単語
  return {
    type: 'WORD',
    normalized,
  }
}
