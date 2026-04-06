# Express Middleware

Rate limit API routes by API key using a fixed window with ban escalation.

```ts
import express from 'express'
import { createClient } from 'redis'
import { Limiter } from 'redlimit'

const redis = createClient()
await redis.connect()

const limiter = new Limiter({
  redis,
  algorithm: 'fixed-window',
  limit: 100,
  window: '1m',
  prefix: 'api',
  ban: {
    escalation: ['5m', '30m', '1h'],
    history: '24h',
  },
})

const app = express()

app.use(async (req, res, next) => {
  const { success, headers } = await limiter.limit(req.headers['authorization'] as string)

  res.set(headers)

  if (!success) {
    return res.status(429).json({ error: 'Too many requests' })
  }

  next()
})

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello!' })
})

app.listen(3000)
```
