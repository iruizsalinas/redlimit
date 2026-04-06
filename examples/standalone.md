# Standalone

All available methods.

```ts
import { createClient } from 'redis'
import { Limiter } from 'redlimit'

const redis = createClient()
await redis.connect()

const limiter = new Limiter({
  redis,
  algorithm: 'token-bucket',
  limit: 10,
  refill: { amount: 1, interval: '1s' },
})

// basic check
const { success, remaining, headers } = await limiter.limit('user_123')

// check without consuming
const state = await limiter.peek('user_123')

// weighted request (costs 3 tokens)
const heavy = await limiter.limit('user_123', { cost: 3 })

// manually block a user for 1 hour
await limiter.block('bad_actor', '1h')

// clear all state for a user
await limiter.reset('user_123')

await redis.quit()
```
