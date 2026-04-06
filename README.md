# redlimit

Redis rate limiting with fixed window, sliding window, and token bucket algorithms

```bash
npm install redlimit redis
# or: npm install redlimit ioredis
```

## Quick Start

```ts
import { Limiter } from 'redlimit'
import { createClient } from 'redis'

const redis = createClient()
await redis.connect()

const limiter = new Limiter({
  redis,
  algorithm: 'sliding-window',
  limit: 10,
  window: '30s',
})

const { success, headers } = await limiter.limit('user_123')

if (!success) {
  return res.status(429).set(headers).end()
}
```

Or with ioredis:

```ts
import { Limiter } from 'redlimit'
import Redis from 'ioredis'

const redis = new Redis()

const limiter = new Limiter({
  redis,
  algorithm: 'sliding-window',
  limit: 10,
  window: '30s',
})
```

## Algorithms

All algorithms run as atomic Lua scripts inside Redis.

```ts
// Fixed window - counts requests in fixed time buckets
{ algorithm: 'fixed-window', limit: 100, window: '1m' }

// Sliding window - smooths out bursts at window boundaries
{ algorithm: 'sliding-window', limit: 100, window: '1m' }

// Token bucket - allows bursts, then enforces a steady rate
{ algorithm: 'token-bucket', limit: 100, refill: { amount: 10, interval: '6s' } }
```

## Config

| Option | Type | Default | Description |
|---|---|---|---|
| `redis` | `ioredis` or `node-redis` | | Redis client, auto-detected |
| `algorithm` | `'fixed-window'` `'sliding-window'` `'token-bucket'` | | Algorithm to use |
| `limit` | `number` | | Max requests per window, or bucket capacity |
| `window` | `string` | | Time window: `'30s'`, `'5m'`, `'1h'`, `'1d'` |
| `refill` | `{ amount, interval }` | | Refill config: how many tokens to add and how often (token bucket only) |
| `prefix` | `string` | `'rl'` | Redis key prefix |
| `fail` | `'open'` or `'closed'` | `'closed'` | What happens when Redis is down |
| `ban` | `object` | | Ban escalation (see below) |

## Methods

```ts
await limiter.limit('key')              // check + consume 1 token
await limiter.limit('key', { cost: 5 }) // consume multiple tokens
await limiter.peek('key')               // check without consuming
await limiter.reset('key')              // clear all state for a key
await limiter.block('key', '1h')        // manually block a key
```

Every `limit()` and `peek()` call returns:

```ts
{
  success: boolean           // allowed or denied
  remaining: number          // how many requests are left
  reset: number              // when the limit resets (unix ms)
  limit: number              // the configured max
  headers: {                 // ready to set on your HTTP response
    'RateLimit-Limit': string
    'RateLimit-Remaining': string
    'RateLimit-Reset': string
    'Retry-After'?: string   // only included when denied
  }
}
```

## Ban Escalation

Automatically block repeat offenders with increasing ban durations:

```ts
const limiter = new Limiter({
  redis,
  algorithm: 'sliding-window',
  limit: 100,
  window: '1m',
  ban: {
    escalation: ['3m', '15m', '1h'],  // 1st offense: 3m, 2nd: 15m, 3rd+: 1h
    history: '24h',                     // escalation resets after 24h
  },
})
```

Bans trigger automatically when a request is denied. While banned, all requests are rejected without further escalation. `peek()` never triggers bans. `reset()` clears ban history, including shared ban state.

To share bans across limiters (e.g., API ban also blocks OAuth):

```ts
ban: {
  escalation: ['3m', '15m', '1h'],
  history: '24h',
  shared: 'rl',  // all limiters with the same shared prefix share ban state
}
```

## Examples

### Login Protection

```ts
const loginLimit = new Limiter({
  redis,
  algorithm: 'fixed-window',
  limit: 5,
  window: '15m',
  prefix: 'login',
  ban: {
    escalation: ['15m', '1h', '24h'],
    history: '7d',
  },
})

const { success } = await loginLimit.limit(ip)
if (!success) return res.status(429).json({ error: 'Too many login attempts' })
```

### API Key

```ts
const apiLimit = new Limiter({
  redis,
  algorithm: 'token-bucket',
  limit: 100,
  refill: { amount: 10, interval: '6s' },
  prefix: 'api',
})

const { success, headers } = await apiLimit.limit(apiKey)
```

### Daily Quota

```ts
const quota = new Limiter({
  redis,
  algorithm: 'sliding-window',
  limit: 1000,
  window: '1d',
  prefix: 'quota',
})

const { success, remaining } = await quota.limit(apiKey)
```

## Requirements

- Node.js 18+
- Redis 5.0+
