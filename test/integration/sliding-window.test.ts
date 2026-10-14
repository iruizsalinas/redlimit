import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient, waitForRedisTime } from '../support/redis.js'
import { Limiter } from '../../src/ratelimit.js'
import { acrossRedisBoundary } from '../support/timing.js'

const PREFIX = 'test-sw'

describe('sliding-window (integration)', () => {
  let redis: ReturnType<typeof createClient>

  beforeAll(async () => {
    redis = createClient()
    await redis.connect()
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    const keys = await redis.keys(`${PREFIX}:*`)
    if (keys.length > 0) await redis.del(keys)
  })

  it('allows requests within limit', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 5,
      window: '10s',
      prefix: PREFIX,
    })

    for (let i = 0; i < 5; i++) {
      const result = await rl.limit('user1')
      expect(result.success).toBe(true)
    }
  })

  it('denies requests over limit', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 3,
      window: '10s',
      prefix: PREFIX,
    })

    for (let i = 0; i < 3; i++) {
      await rl.limit('user2')
    }

    const denied = await rl.limit('user2')
    expect(denied.success).toBe(false)
  })

  it('respects cost parameter', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 10,
      window: '10s',
      prefix: PREFIX,
    })

    const r1 = await rl.limit('user3', { cost: 7 })
    expect(r1.success).toBe(true)

    const r2 = await rl.limit('user3', { cost: 4 })
    expect(r2.success).toBe(false)
  })

  it('peek does not consume', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 5,
      window: '10s',
      prefix: PREFIX,
    })

    await rl.peek('user4')
    await rl.peek('user4')

    const result = await rl.limit('user4')
    expect(result.success).toBe(true)
    expect(result.remaining).toBe(4)
  })

  it('previous window count decays over time', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 3,
      window: '2s',
      prefix: PREFIX,
    })

    const { filled, probed: stillDenied } = await acrossRedisBoundary(redis, 2_000, async () => {
      await rl.reset('user5')
      const fill = await rl.limit('user5', { cost: 3 })
      const denied = await rl.limit('user5')
      return { fill, denied }
    }, () => rl.peek('user5'))
    expect(filled.fill.success).toBe(true)
    const { denied } = filled
    expect(denied.success).toBe(false)
    expect(stillDenied.success).toBe(false)

    // At least 60% of a window later, the previous count permits another request.
    await waitForRedisTime(redis, 1_200)
    const allowed = await rl.limit('user5')
    expect(allowed.success).toBe(true)
  })
})
