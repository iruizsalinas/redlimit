import { describe, it, expect } from 'vitest'
import { Limiter } from '../../src/ratelimit.js'
import { createClient } from '../support/redis.js'

describe('Redis lifecycle', () => {
  it('recovers after the server script cache is flushed', async () => {
    const redis = createClient()
    await redis.connect()
    try {
      const limiter = new Limiter({ redis, algorithm: 'fixed-window', limit: 3, window: '1h', prefix: 'test-lifecycle-cache' })
      await limiter.reset('user')
      expect((await limiter.limit('user')).remaining).toBe(2)
      await redis.scriptFlush()
      expect((await limiter.limit('user')).remaining).toBe(1)
      expect((await limiter.limit('user')).remaining).toBe(0)
      expect((await limiter.limit('user')).success).toBe(false)
      await limiter.reset('user')
    } finally { await redis.quit() }
  })

  it.each(['fixed-window', 'sliding-window', 'token-bucket'] as const)(
    '%s: enforces one shared limit across independent connections', async algorithm => {
      const clients = Array.from({ length: 4 }, () => createClient())
      try {
        await Promise.all(clients.map(client => client.connect()))
        const limiters = clients.map(redis => new Limiter({
          redis, algorithm, limit: 100, window: '1h',
          refill: { amount: 1, interval: '1h' }, prefix: 'test-lifecycle-' + algorithm,
        }))
        await limiters[0].reset('shared')
        const results = await Promise.all(Array.from({ length: 1_000 }, (_, i) => limiters[i % limiters.length].limit('shared')))
        expect(results.filter(result => result.success)).toHaveLength(100)
        await limiters[0].reset('shared')
      } finally { await Promise.all(clients.filter(client => client.isOpen).map(client => client.quit())) }
    },
  )

  it.each(['open', 'closed'] as const)('fail=%s after a real client disconnect', async fail => {
    const redis = createClient()
    await redis.connect()
    const limiter = new Limiter({ redis, algorithm: 'fixed-window', limit: 1, window: '1h', fail, prefix: 'test-lifecycle-disconnect' })
    await limiter.reset('user')
    await redis.quit()
    if (fail === 'open') {
      expect((await limiter.limit('user')).success).toBe(true)
      expect((await limiter.peek('user')).success).toBe(true)
    } else {
      await expect(limiter.limit('user')).rejects.toThrow()
      await expect(limiter.peek('user')).rejects.toThrow()
    }
  })
})
