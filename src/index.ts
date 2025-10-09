import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'

const app = new Hono()

app.use('*', cors())

app.get('/', (c) => c.text('Hono server is running!'))

app.post('/chat', async (c) => {
  const { message } = await c.req.json()

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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

  const data = await response.json()
  return c.json(data)
})

// ✅ Cloud Runが期待する形でlisten
const port = Number(process.env.PORT) || 8080
console.log(`🚀 Server running on port ${port}`)

serve({
  fetch: app.fetch,
  port,
})
