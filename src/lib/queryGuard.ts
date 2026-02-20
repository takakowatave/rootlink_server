/*
  queryGuard.ts

  このファイルは「検索入力として成立するかどうか」を判定する
  最初の・最も軽いフィルタ。

  原則：
  - ここで ok:false を返すものは「ここで止めてもUXが破綻しない入力」のみ
  - typo / スペルミス / 表記揺れは一切扱わない
  - 英語として正しいか、生成してよいかは判断しない
*/

export type QueryGuardError =
  | 'NON_ALPHABET' // アルファベット・スペース・ハイフン以外を含む
  | 'TOO_LONG'     // 空文字、または想定より長すぎる入力

export type QueryGuardResult =
  | {
      ok: true
      normalized: string
    }
  | {
      ok: false
      reason: QueryGuardError
    }

/*
  guardQuery

  - ユーザーの生入力を受け取り、最低限の正規化を行う
  - 「この入力を処理パイプラインに流して安全か」だけを判定する
  - ok:false の場合、呼び出し側では即座に処理を中断する
*/
export async function guardQuery(
  raw: string,
  maxLength: number
): Promise<QueryGuardResult> {
  // 前後の空白を除去し、小文字に正規化
  const q = raw.trim().toLowerCase()

  /* =========================
     ① 使用可能文字チェック
     - 危険・想定外入力なので止めてよい
  ========================= */
  if (!/^[a-z\s-]+$/.test(q)) {
    return { ok: false, reason: 'NON_ALPHABET' }
  }

  /* =========================
     ② 文字数チェック
     - UX的にこれ以上進める意味がない
  ========================= */
  if (q.length === 0 || q.length > maxLength) {
    return { ok: false, reason: 'TOO_LONG' }
  }

  /* =========================
     ③ typo / スペルミスは一切扱わない
     - 止めない
     - 判定しない
     - suggestion も出さない
  ========================= */

  // ④ ここを通ったものはすべて次のフェーズへ
  return { ok: true, normalized: q }
}
