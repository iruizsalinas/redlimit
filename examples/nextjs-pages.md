# Next.js Pages Router

Rate limit an API route by client IP (Cloudflare) using a sliding window.

```ts
import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from 'redis'
import { Limiter } from 'redlimit'

const redis = createClient()
await redis.connect()

const limiter = new Limiter({
  redis,
  algorithm: 'sliding-window',
  limit: 60,
  window: '1m',
  prefix: 'api',
})

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ip = req.headers['cf-connecting-ip'] as string
  const { success, headers } = await limiter.limit(ip)

  for (const [key, value] of Object.entries(headers)) {
    if (value) res.setHeader(key, value)
  }

  if (!success) {
    return res.status(429).json({ error: 'Too many requests' })
  }

  res.json({ message: 'Hello!' })
}
```
