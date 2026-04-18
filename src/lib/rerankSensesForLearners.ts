import type { NormalizedDictionary, NormalizedSenseGroup, NormalizedSense } from "./normalizeDictionary.js"

const MAX_SENSES_PER_POS = 6

/**
 * 英語学習者（中〜上級者）の視点で重要な sense を上位6件に絞る。
 * Oxford のコーパス頻度順ではなく「日常英語での重要度」を基準に rerank する。
 */
export async function rerankSensesForLearners(
  dict: NormalizedDictionary
): Promise<NormalizedDictionary> {
  const rerankedGroups = await Promise.all(
    dict.senseGroups.map((group) => rerankGroup(dict.word, group))
  )

  return { ...dict, senseGroups: rerankedGroups }
}

async function rerankGroup(
  word: string,
  group: NormalizedSenseGroup
): Promise<NormalizedSenseGroup> {
  // 既に6件以下なら rerank 不要
  if (group.senses.length <= MAX_SENSES_PER_POS) {
    return group
  }

  try {
    const sensesJson = group.senses.map((s, i) => ({
      index: i,
      senseId: s.senseId,
      definition: s.definition,
      example: s.example ?? "",
      registerCodes: s.registerCodes,
    }))

    const userPrompt = `You are helping build an English vocabulary app for intermediate to advanced learners (people who use English-English dictionaries).

Word: "${word}" (${group.partOfSpeech})

Below are all the senses returned by Oxford Dictionaries API, ordered by their written corpus frequency.
Your task: select and reorder the TOP ${MAX_SENSES_PER_POS} senses that are most important for English learners in everyday communication.

Criteria:
- Prioritize senses commonly encountered in daily conversation, reading, and writing
- Include emotional/relational meanings even if they appear late in Oxford's list (e.g. "I miss you" for "miss")
- Deprioritize highly technical, domain-specific, archaic, or vulgar senses
- Do NOT include senses with registerCodes like ["vulgar_slang"] unless essential
- Return exactly ${MAX_SENSES_PER_POS} senseId values in order of importance (most important first)

Senses:
${JSON.stringify(sensesJson, null, 2)}

Respond with ONLY valid JSON: {"senseIds": ["id1", "id2", "id3", "id4", "id5", "id6"]}`

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You return only valid JSON. No markdown. No explanation.",
          },
          {
            role: "user",
            content: userPrompt,
          },
        ],
      }),
    })

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status}`)
    }

    const json = await res.json() as { choices: { message: { content: string } }[] }
    const raw = json.choices[0]?.message?.content ?? ""
    const parsed = JSON.parse(raw) as { senseIds: string[] }
    const selectedIds = parsed.senseIds

    if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
      throw new Error("Invalid rerank response")
    }

    // selectedIds の順序で senses を並べ替え
    const senseMap = new Map<string, NormalizedSense>(
      group.senses.map((s) => [s.senseId, s])
    )

    const reranked: NormalizedSense[] = []
    for (const id of selectedIds) {
      const sense = senseMap.get(id)
      if (sense) reranked.push(sense)
    }

    // selectedIds に含まれなかった senses を後ろに追加（念のため）
    for (const sense of group.senses) {
      if (!selectedIds.includes(sense.senseId)) {
        reranked.push(sense)
      }
    }

    const shown = reranked.slice(0, MAX_SENSES_PER_POS)

    return {
      ...group,
      senses: shown,
      shownSenseCount: shown.length,
      hasMoreSenses: group.totalSenseCount > shown.length,
    }
  } catch (error) {
    console.error("RERANK FAILED, falling back to Oxford order:", error)
    // fallback: Oxford 順で上位6件
    const fallback = group.senses.slice(0, MAX_SENSES_PER_POS)
    return {
      ...group,
      senses: fallback,
      shownSenseCount: fallback.length,
      hasMoreSenses: group.totalSenseCount > fallback.length,
    }
  }
}
