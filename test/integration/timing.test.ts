import { describe, expect, it } from 'vitest'
import { Limiter } from '../../src/ratelimit.js'
import { createClient, waitForRedisTime } from '../support/redis.js'
import { acrossRedisBoundary, inRedisWindow } from '../support/timing.js'

describe('timing preconditions with real Redis', () => {
  it('checks an entire fixed-window batch after deliberately crossing a boundary', async () => {
    const redis = createClient()
    await redis.connect()
    const limiter = new Limiter({ redis, algorithm: 'fixed-window', limit: 100, window: '2s', prefix: 'test-timing-fixed' })
    let attempts = 0
    let discardedAllowed = 0
    try {
      const results = await inRedisWindow(redis, 2_000, async () => {
        await limiter.reset('boundary')
        const first = await Promise.all(Array.from({ length: 1_000 }, () => limiter.limit('boundary')))
        if (++attempts !== 1) return first
        await waitForRedisTime(redis, 2_100)
        const second = await Promise.all(Array.from({ length: 1_000 }, () => limiter.limit('boundary')))
        const results = [...first, ...second]
        discardedAllowed = results.filter(result => result.success).length
        return results
      })
      expect(discardedAllowed).toBeGreaterThan(100)
      expect(attempts).toBeGreaterThan(1)
      expect(results.filter(result => result.success)).toHaveLength(100)
    } finally {
      if (redis.isOpen) {
        await limiter.reset('boundary')
        await redis.quit()
      }
    }
  })

  it('rejects the wrong adjacent window after a deliberate scheduler pause', async () => {
    const redis = createClient()
    await redis.connect()
    const limiter = new Limiter({ redis, algorithm: 'sliding-window', limit: 1, window: '2s', prefix: 'test-timing-sliding' })
    let probes = 0
    let discardedAllowed = false
    try {
      const { filled, probed } = await acrossRedisBoundary(redis, 2_000, async () => {
        await limiter.reset('boundary')
        return limiter.limit('boundary')
      }, async () => {
        if (++probes === 1) {
          await waitForRedisTime(redis, 4_000)
          const result = await limiter.peek('boundary')
          discardedAllowed = result.success
          return result
        }
        return limiter.peek('boundary')
      })
      expect(discardedAllowed).toBe(true)
      expect(probes).toBeGreaterThan(1)
      expect(filled.success).toBe(true)
      expect(probed.success).toBe(false)
    } finally {
      if (redis.isOpen) {
        await limiter.reset('boundary')
        await redis.quit()
      }
    }
  })
})
