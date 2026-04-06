# Next.js App Router

Rate limit a route handler by user ID using a token bucket.

```ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from 'redis'
import { Limiter } from 'redlimit'

const redis = createClient()
await redis.connect()

const limiter = new Limiter({
  redis,
  algorithm: 'token-bucket',
  limit: 20,
  refill: { amount: 1, interval: '3s' },
  prefix: 'api',
})

export async function GET(req: NextRequest) {
  const userId = req.headers.get('x-user-id')
  const { success, headers } = await limiter.limit(userId!)

  if (!success) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers },
    )
  }

  return NextResponse.json(
    { message: 'Hello!' },
    { headers },
  )
}
```
