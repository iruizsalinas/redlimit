# redis

```ts
import { createClient } from 'redis'
import { Limiter } from 'redlimit'

const redis = createClient({ url: 'redis://localhost:6379' })
redis.on('error', console.error)
await redis.connect()

const limiter = new Limiter({
  redis,
  algorithm: 'token-bucket',
  limit: 100,
  refill: { amount: 10, interval: '6s' },
  prefix: 'api',
  ban: {
    escalation: ['1m', '5m', '1h'],
    history: '24h',
    shared: 'shared-bans',
  },
})

try {
  const result = await limiter.limit('user_123')
  console.log(result)
} finally {
  await redis.close()
}
```
