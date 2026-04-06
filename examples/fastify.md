# Fastify Hook

Rate limit API routes by API key using a sliding window.

```ts
import Fastify from 'fastify'
import { createClient } from 'redis'
import { Limiter } from 'redlimit'

const redis = createClient()
await redis.connect()

const limiter = new Limiter({
  redis,
  algorithm: 'sliding-window',
  limit: 100,
  window: '1m',
  prefix: 'api',
})

const app = Fastify()

app.addHook('onRequest', async (req, reply) => {
  const { success, headers } = await limiter.limit(req.headers['authorization']!)

  reply.headers(headers)

  if (!success) {
    reply.code(429).send({ error: 'Too many requests' })
    return reply
  }
})

app.get('/api/hello', async () => {
  return { message: 'Hello!' }
})

app.listen({ port: 3000 })
```
