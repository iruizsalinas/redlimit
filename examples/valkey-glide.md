# Valkey GLIDE

```ts
import { GlideClient } from '@valkey/valkey-glide'
import { Limiter } from 'redlimit'

const redis = await GlideClient.createClient({
  addresses: [{ host: 'localhost', port: 6379 }],
  requestTimeout: 500,
})

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
  redis.close()
}
```
