import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from 'redis'
import { Limiter } from '../../src/ratelimit.js'

const PREFIX = 'test-tb'

describe('token-bucket (integration)', () => {
  let redis: ReturnType<typeof createClient>

  beforeAll(async () => {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' })
    await redis.connect()
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    const keys = await redis.keys(`${PREFIX}:*`)
    if (keys.length > 0) await redis.del(keys)
  })

  it('bucket starts full', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 5,
      refillRate: 1,
      prefix: PREFIX,
    })

    const peek = await rl.peek('user1')
    expect(peek.remaining).toBe(5)
  })

  it('allows burst up to capacity', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 5,
      refillRate: 1,
      prefix: PREFIX,
    })

    for (let i = 0; i < 5; i++) {
      const result = await rl.limit('user2')
      expect(result.success).toBe(true)
    }

    const denied = await rl.limit('user2')
    expect(denied.success).toBe(false)
  })

  it('refills tokens over time', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 3,
      refillRate: 0.5, // 0.5 tokens/sec — slow enough that network latency won't refill during drain
      prefix: PREFIX,
    })

    // Drain the bucket
    for (let i = 0; i < 3; i++) {
      await rl.limit('user3')
    }

    const denied = await rl.limit('user3')
    expect(denied.success).toBe(false)

    // Wait for refill (0.5 tokens/sec = 1 token in 2s)
    await new Promise((r) => setTimeout(r, 2200))

    const allowed = await rl.limit('user3')
    expect(allowed.success).toBe(true)
  })

  it('respects cost parameter', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 10,
      refillRate: 1,
      prefix: PREFIX,
    })

    const r1 = await rl.limit('user4', { cost: 7 })
    expect(r1.success).toBe(true)
    expect(r1.remaining).toBe(3)

    const r2 = await rl.limit('user4', { cost: 4 })
    expect(r2.success).toBe(false)
  })

  it('does not exceed capacity on refill', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 5,
      refillRate: 100, // very fast refill
      prefix: PREFIX,
    })

    await rl.limit('user5')
    await new Promise((r) => setTimeout(r, 200))

    const peek = await rl.peek('user5')
    expect(peek.remaining).toBeLessThanOrEqual(5)
  })

  it('peek does not consume tokens', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 5,
      refillRate: 1,
      prefix: PREFIX,
    })

    await rl.limit('user6') // consume 1

    const p1 = await rl.peek('user6')
    const p2 = await rl.peek('user6')
    expect(p1.remaining).toBe(p2.remaining)
  })
})
