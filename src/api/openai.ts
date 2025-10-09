export async function callOpenAI(message: string) {
    console.log("🔑 OPENAI_API_KEY prefix:", process.env.OPENAI_API_KEY?.slice(0, 10))

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: message }],
        }),
    })

    console.log("📡 Status:", res.status, res.statusText)

    const data = await res.json().catch((e) => {
        console.error("❌ JSON parse error:", e)
        return null
    })
    console.log("📦 Response:", data)

    if (!res.ok) {
        throw new Error(`OpenAI API error: ${res.status} ${res.statusText}`)
    }

    return data
}
