/**
 * rewriteDictionary
 *
 * 役割:
 * - normalizeDictionary の結果を受け取る
 * - definition / example を OpenAI で learner-friendly な英語に書き換える
 * - その結果を、dictionary_cache に保存する完成JSONとして返す
 *
 * 注意:
 * - Oxford raw は扱わない
 * - 保存するのは、この関数が返す最終JSONだけ
 * - 呼び出し側で try/catch してください
 */

export type NormalizedSense = {
    senseNumber: string
    definition: string
    example: string | null
  }
  
  export type NormalizedSenseGroup = {
    partOfSpeech: string
    totalSenseCount: number
    shownSenseCount: number
    hasMoreSenses: boolean
    senses: NormalizedSense[]
  }
  
  export type NormalizedLexicalUnit = {
    lexicalUnitId: string
    text: string
  }
  
  export type NormalizedDictionary = {
    word: string
    ipa: string | null
    inflections: string[]
    senseGroups: NormalizedSenseGroup[]
    lexicalUnits: NormalizedLexicalUnit[]
    derivatives: string[]
    etymology: string | null
  }
  
  export type RewrittenSense = {
    senseNumber: string
    definition: string
    example: string | null
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
    lexicalUnits: NormalizedLexicalUnit[]
    derivatives: string[]
    etymology: string | null
  }
  
  type RewriteSourceItem = {
    id: string
    sourceDefinition: string
    sourceExample: string | null
  }
  
  type OpenAIRewriteItem = {
    id: string
    definition: string
    example?: string | null
  }
  
  type OpenAIRewriteResponse = {
    items?: OpenAIRewriteItem[]
  }
  
  const OPENAI_API_URL =
    process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions"
  
  const OPENAI_MODEL =
    process.env.OPENAI_TEXT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"
  
  const CHUNK_SIZE = 12
  const SCHEMA_VERSION = 1
  
  function assertEnv() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required")
    }
  }
  
  function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = []
  
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size))
    }
  
    return out
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
  
  function buildRewriteSources(data: NormalizedDictionary): RewriteSourceItem[] {
    const items: RewriteSourceItem[] = []
  
    for (const group of data.senseGroups) {
      for (const sense of group.senses) {
        if (!sense.definition?.trim()) continue
  
        items.push({
          id: `${group.partOfSpeech}-${sense.senseNumber}`,
          sourceDefinition: sense.definition,
          sourceExample: sense.example ?? null,
        })
      }
    }
  
    return items
  }
  
  function buildPrompt(items: RewriteSourceItem[]): string {
    return [
      "Rewrite English dictionary definitions and examples for an English-learning product.",
      "Rules:",
      "- Keep the meaning faithful.",
      "- Use plain British English.",
      "- Make the definition shorter and easier to understand.",
      "- Do not copy the source wording too closely.",
      "- If example is empty, return null for example.",
      "- Return JSON only.",
      "",
      'Output format: {"items":[{"id":"...","definition":"...","example":"..."|null}]}',
      "",
      "Input:",
      JSON.stringify(
        items.map((item) => ({
          id: item.id,
          definition: item.sourceDefinition,
          example: item.sourceExample,
        }))
      ),
    ].join("\n")
  }
  
  async function rewriteChunk(items: RewriteSourceItem[]): Promise<OpenAIRewriteItem[]> {
    assertEnv()
  
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You rewrite dictionary definitions and examples into simpler learner-friendly British English. Return JSON only.",
          },
          {
            role: "user",
            content: buildPrompt(items),
          },
        ],
        temperature: 0.3,
      }),
    })
  
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`OPENAI_REWRITE_FAILED: ${res.status} ${text}`)
    }
  
    const data = await res.json()
  
    const content = data?.choices?.[0]?.message?.content
  
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("OPENAI_REWRITE_EMPTY")
    }
  
    const parsed = safeJsonParse<OpenAIRewriteResponse>(content)
  
    if (!Array.isArray(parsed?.items)) {
      throw new Error("OPENAI_REWRITE_INVALID_JSON")
    }
  
    return parsed.items
  }
  
  export async function rewriteDictionary(
    data: NormalizedDictionary
  ): Promise<RewrittenDictionary> {
    const sourceItems = buildRewriteSources(data)
  
    if (sourceItems.length === 0) {
      return {
        schemaVersion: SCHEMA_VERSION,
        word: data.word,
        ipa: data.ipa,
        inflections: data.inflections,
        senseGroups: data.senseGroups.map((group) => ({
          ...group,
          senses: group.senses.map((sense) => ({
            senseNumber: sense.senseNumber,
            definition: sense.definition,
            example: sense.example ?? null,
          })),
        })),
        lexicalUnits: data.lexicalUnits,
        derivatives: data.derivatives,
        etymology: data.etymology,
      }
    }
  
    const rewrittenMap = new Map<string, OpenAIRewriteItem>()
  
    for (const group of chunk(sourceItems, CHUNK_SIZE)) {
      const rewrittenItems = await rewriteChunk(group)
  
      for (const item of rewrittenItems) {
        if (!item?.id) continue
        if (typeof item?.definition !== "string" || !item.definition.trim()) continue
  
        rewrittenMap.set(item.id, {
          id: item.id,
          definition: item.definition.trim(),
          example:
            typeof item?.example === "string" && item.example.trim().length > 0
              ? item.example.trim()
              : null,
        })
      }
    }
  
    return {
      schemaVersion: SCHEMA_VERSION,
      word: data.word,
      ipa: data.ipa,
      inflections: data.inflections,
      senseGroups: data.senseGroups.map((group) => ({
        partOfSpeech: group.partOfSpeech,
        totalSenseCount: group.totalSenseCount,
        shownSenseCount: group.shownSenseCount,
        hasMoreSenses: group.hasMoreSenses,
        senses: group.senses.map((sense) => {
          const rewritten = rewrittenMap.get(
            `${group.partOfSpeech}-${sense.senseNumber}`
          )
  
          return {
            senseNumber: sense.senseNumber,
            definition: rewritten?.definition ?? sense.definition,
            example: rewritten?.example ?? sense.example ?? null,
          }
        }),
      })),
      lexicalUnits: data.lexicalUnits,
      derivatives: data.derivatives,
      etymology: data.etymology,
    }
  }