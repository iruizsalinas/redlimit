# Hono Middleware

Rate limit login attempts by IP (Cloudflare) with escalating bans.

```ts
import { Hono } from 'hono'
import { createClient } from 'redis'
import { Limiter } from 'redlimit'

const redis = createClient()
await redis.connect()

const loginLimiter = new Limiter({
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

const app = new Hono()

app.post('/auth/login', async (c) => {
  const ip = c.req.header('cf-connecting-ip')!
  const { success, headers } = await loginLimiter.limit(ip)

  Object.entries(headers).forEach(([k, v]) => c.header(k, v))

  if (!success) {
    return c.json({ error: 'Too many login attempts' }, 429)
  }

  const { email, password } = await c.req.json()
  const valid = await checkPassword(email, password)

  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  await loginLimiter.reset(ip)

  return c.json({ token: generateToken(email) })
})

export default app
```
