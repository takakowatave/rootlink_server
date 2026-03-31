/**
 * resolveAmbiguousEtymologyParts
 *
 * 役割:
 * - すでに抽出済みの語源パーツ候補に対して、
 *   複数 gloss 候補を持つ part だけを AI で判定する
 * - meaning / meaningJa を自由生成しない
 * - CSV / Supabase を primary source とし、AI は候補選択だけを行う
 * - 語源文と合う候補がない part は「表示しない」を選べる
 *
 * 前提:
 * - buildEtymologyData の前段で呼ぶ
 * - 各 part はすでに text / partType / glossCandidates を持っている
 * - glossCandidates は primary source 由来の候補配列
 *
 * 内部の流れ:
 * 1. 候補1件の part はそのまま採用
 * 2. 候補複数の part だけ AI に渡す
 * 3. AI は「候補 index を選ぶ」または「非表示」を返す
 * 4. 非表示判定 / 低信頼 / AI失敗の part は落とす
 * 5. 最終的に表示してよい part だけ返す
 */

const OPENAI_API_URL =
  process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"

const OPENAI_MODEL =
  process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"

// 低信頼なら part を出さない。
// 必要なら後で調整しやすいよう定数化。
const MIN_CONFIDENCE = 0.6

export type EtymologyPartType = "prefix" | "root" | "suffix" | "unknown"

export type AmbiguousGlossCandidate = {
  meaning: string
  meaningJa: string | null
}

export type AmbiguousEtymologyPart = {
  text: string
  partType: EtymologyPartType
  relatedWords: string[]
  order: number
  glossCandidates: AmbiguousGlossCandidate[]
}

export type ResolveAmbiguousEtymologyPartsInput = {
  headword: string
  rawEtymology: string | null
  parts: AmbiguousEtymologyPart[]
}

export type ResolvedEtymologyPart = {
  text: string
  partType: EtymologyPartType
  meaning: string | null
  meaningJa: string | null
  relatedWords: string[]
  order: number
}

// AI は「候補 index を選ぶ」か、「表示しない」を返す。
type OpenAISelectedGlossItem = {
  order?: number
  selectedIndex?: number | null
  shouldDisplay?: boolean
  reason?: string
  confidence?: number
}

type OpenAISelectedGlossResponse = {
  items?: OpenAISelectedGlossItem[]
}

type SelectedGlossItem = {
  order: number
  selectedIndex: number | null
  shouldDisplay: boolean
  reason: string
  confidence: number
}

function assertEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required")
  }
}

function stripCodeFence(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
}

function safeJsonParse<T>(text: string): T {
  return JSON.parse(stripCodeFence(text)) as T
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }

  return out
}

function buildPrompt(input: {
  headword: string
  rawEtymology: string | null
  parts: AmbiguousEtymologyPart[]
}): string {
  return [
    "You are resolving ambiguous etymology-part gloss candidates for an English learning product.",
    "",
    "Your job:",
    "- For each part, either choose exactly one candidate from glossCandidates, or decide not to display the part.",
    "- Do NOT invent new meanings.",
    "- Do NOT rewrite the candidates.",
    "- Use the headword and raw etymology as evidence.",
    "- Return JSON only.",
    "",
    "Rules:",
    "- selectedIndex must be a valid zero-based index into glossCandidates when shouldDisplay is true.",
    "- selectedIndex must be null when shouldDisplay is false.",
    "- If the raw etymology supports one candidate clearly, choose it.",
    "- If none of the candidates can be supported confidently, set shouldDisplay to false.",
    "- Do not keep a part just because it looks morphologically plausible.",
    "",
    'Output format: {"items":[{"order":0,"shouldDisplay":true,"selectedIndex":0,"reason":"...","confidence":0.92}]}',
    "",
    "Input:",
    JSON.stringify({
      headword: input.headword,
      rawEtymology: input.rawEtymology,
      parts: input.parts.map((part) => ({
        order: part.order,
        text: part.text,
        partType: part.partType,
        glossCandidates: part.glossCandidates.map((candidate, index) => ({
          index,
          meaning: candidate.meaning,
          meaningJa: candidate.meaningJa,
        })),
      })),
    }),
  ].join("\n")
}

async function postOpenAI(
  messages: { role: "system" | "user"; content: string }[]
): Promise<string> {
  assertEnv()

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.1,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OPENAI_REQUEST_FAILED: ${res.status} ${text}`)
  }

  const data: unknown = await res.json()

  if (
    typeof data !== "object" ||
    data === null ||
    !("choices" in data) ||
    !Array.isArray(data.choices)
  ) {
    throw new Error("OPENAI_INVALID_RESPONSE")
  }

  const firstChoice = data.choices[0]

  if (
    typeof firstChoice !== "object" ||
    firstChoice === null ||
    !("message" in firstChoice) ||
    typeof firstChoice.message !== "object" ||
    firstChoice.message === null ||
    !("content" in firstChoice.message)
  ) {
    throw new Error("OPENAI_EMPTY_MESSAGE")
  }

  const content = firstChoice.message.content

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OPENAI_EMPTY_CONTENT")
  }

  return content
}

// AI返却を安全に正規化する。
// shouldDisplay=false のときは selectedIndex=null を許可する。
function normaliseSelectedGlossItems(
  rawItems: OpenAISelectedGlossItem[],
  parts: AmbiguousEtymologyPart[]
): SelectedGlossItem[] {
  const partByOrder = new Map<number, AmbiguousEtymologyPart>(
    parts.map((part) => [part.order, part])
  )

  return rawItems
    .map((item) => {
      const order = readNumber(item.order)
      const reason = readString(item.reason)
      const confidence = readNumber(item.confidence)
      const shouldDisplay = readBoolean(item.shouldDisplay)

      if (order === null || confidence === null || shouldDisplay === null) {
        return null
      }

      const part = partByOrder.get(order)
      if (!part) return null

      if (!shouldDisplay) {
        return {
          order,
          selectedIndex: null,
          shouldDisplay: false,
          reason,
          confidence,
        }
      }

      const selectedIndex = readNumber(item.selectedIndex)

      if (
        selectedIndex === null ||
        selectedIndex < 0 ||
        selectedIndex >= part.glossCandidates.length ||
        !Number.isInteger(selectedIndex)
      ) {
        return null
      }

      return {
        order,
        selectedIndex,
        shouldDisplay: true,
        reason,
        confidence,
      }
    })
    .filter((item): item is SelectedGlossItem => item !== null)
}

async function resolveChunk(
  headword: string,
  rawEtymology: string | null,
  parts: AmbiguousEtymologyPart[]
): Promise<SelectedGlossItem[]> {
  const content = await postOpenAI([
    {
      role: "system",
      content: [
        "You resolve ambiguous etymology-part gloss candidates.",
        "Choose one candidate index per part, or decide not to display the part.",
        "Do not generate new glosses.",
        "Return JSON only.",
      ].join(" "),
    },
    {
      role: "user",
      content: buildPrompt({
        headword,
        rawEtymology,
        parts,
      }),
    },
  ])

  const parsed = safeJsonParse<OpenAISelectedGlossResponse>(content)

  if (!Array.isArray(parsed.items)) {
    throw new Error("OPENAI_AMBIGUOUS_ETYMOLOGY_INVALID_JSON")
  }

  return normaliseSelectedGlossItems(parsed.items, parts)
}

// 採用候補を最終 part に変換する。
// 非表示なら null を返して呼び出し元で落とす。
function toResolvedPart(
  part: AmbiguousEtymologyPart,
  selection: SelectedGlossItem | undefined
): ResolvedEtymologyPart | null {
  // AI結果がない / 非表示判定 / 低信頼なら出さない。
  if (!selection) return null
  if (!selection.shouldDisplay) return null
  if (selection.confidence < MIN_CONFIDENCE) return null
  if (selection.selectedIndex === null) return null

  const selected = part.glossCandidates[selection.selectedIndex]
  if (!selected) return null

  return {
    text: part.text,
    partType: part.partType,
    meaning: selected.meaning,
    meaningJa: selected.meaningJa,
    relatedWords: part.relatedWords,
    order: part.order,
  }
}

export async function resolveAmbiguousEtymologyParts(
  input: ResolveAmbiguousEtymologyPartsInput
): Promise<ResolvedEtymologyPart[]> {
  const alwaysVisibleParts: ResolvedEtymologyPart[] = []
  const ambiguousParts: AmbiguousEtymologyPart[] = []

  // 1件しか候補がない part はそのまま採用。
  // 複数候補の part だけ AI 判定に回す。
  for (const part of input.parts) {
    if (part.glossCandidates.length <= 1) {
      const first = part.glossCandidates[0]

      alwaysVisibleParts.push({
        text: part.text,
        partType: part.partType,
        meaning: first?.meaning ?? null,
        meaningJa: first?.meaningJa ?? null,
        relatedWords: part.relatedWords,
        order: part.order,
      })
      continue
    }

    ambiguousParts.push(part)
  }

  if (ambiguousParts.length === 0) {
    return [...alwaysVisibleParts].sort((a, b) => a.order - b.order)
  }

  const selectionMap = new Map<number, SelectedGlossItem>()
  const batches = chunk(ambiguousParts, 8)

  // AI は part ごとに
  // - 候補を選ぶ
  // - もしくは非表示を選ぶ
  for (const batch of batches) {
    try {
      const selectedItems = await resolveChunk(
        input.headword,
        input.rawEtymology,
        batch
      )

      for (const item of selectedItems) {
        selectionMap.set(item.order, item)
      }
    } catch {
      // AI失敗時は「勝手に1件目採用」せず、該当 batch を落とす。
      continue
    }
  }

  const resolvedAmbiguousParts = ambiguousParts
    .map((part) => toResolvedPart(part, selectionMap.get(part.order)))
    .filter((part): part is ResolvedEtymologyPart => part !== null)

  return [...alwaysVisibleParts, ...resolvedAmbiguousParts].sort(
    (a, b) => a.order - b.order
  )
}