// lib/normalize.ts

import { getLemma } from './lemma.js'

/**
 * 単語ページ用の正規化
 * - 小文字化
 * - lemma適用
 */
export function normalizeWord(raw: string): string {
  const lower = raw.trim().toLowerCase()
  return getLemma(lower)
}

/**
 * 熟語ページ用の正規化
 * - 小文字化
 * - ハイフン分割
 * - 最初の単語だけlemma適用（phrasal verb想定）
 */
export function normalizeLexicalUnit(raw: string): string {
  const lower = raw.trim().toLowerCase()

  const parts = lower.split('-')

  if (parts.length > 1) {
    parts[0] = getLemma(parts[0])
  }

  return parts.join('-')
}
