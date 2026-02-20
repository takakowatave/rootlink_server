// lib/lemma.ts
// wink-lemmatizer を使って「単語→基本形」に正規化する（URL正規化用の最小実装）
//
// 方針（公開前の安全側）
// - まず verb → noun の順で試す（過剰変換を避ける）
// - adjective は誤変換リスクがあるのでデフォルトOFF（必要なら後でON）
// - 入力は "a-z" と "-" のみ想定（guardQueryの後で使う前提）

import lemmatizer from 'wink-lemmatizer'

export function getLemma(input: string): string {
  const w = (input ?? '').trim().toLowerCase()
  if (!w) return w

  // ハイフン語は基本そのままにする（e.g., state-of-the-art）
  // ※将来「協調的に分割して処理したい」ならここを拡張
  if (w.includes('-')) return w

  // 1) Verb first: went -> go, running -> run
  const v = lemmatizer.verb(w)
  if (v && v !== w) return v

  // 2) Noun next: cars -> car
  const n = lemmatizer.noun(w)
  if (n && n !== w) return n

  // 3) Adjective is optional (risk: better -> good 等が混ざるのが嫌ならOFFのまま)
  // const a = lemmatizer.adjective(w)
  // if (a && a !== w) return a

  return w
}
