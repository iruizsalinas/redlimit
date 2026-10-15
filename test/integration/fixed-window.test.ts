import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient, waitForRedisTime } from '../support/redis.js'
import { Limiter } from '../../src/ratelimit.js'
import { inRedisWindow } from '../support/timing.js'

const PREFIX = 'test-fw'

describe('fixed-window (integration)', () => {
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
      algorithm: 'fixed-window',
      limit: 5,
      window: '1h',
      prefix: PREFIX,
    })

    for (let i = 0; i < 5; i++) {
      const result = await rl.limit('user1')
      expect(result.success).toBe(true)
      expect(result.remaining).toBe(4 - i)
    }
  })

  it('denies requests over limit', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 3,
      window: '1h',
      prefix: PREFIX,
    })

    for (let i = 0; i < 3; i++) {
      const result = await rl.limit('user2')
      expect(result.success).toBe(true)
    }

    const denied = await rl.limit('user2')
    expect(denied.success).toBe(false)
    expect(denied.remaining).toBe(0)
  })

  it('respects cost parameter', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 10,
      window: '1h',
      prefix: PREFIX,
    })

    const r1 = await rl.limit('user3', { cost: 5 })
    expect(r1.success).toBe(true)
    expect(r1.remaining).toBe(5)

    const r2 = await rl.limit('user3', { cost: 5 })
    expect(r2.success).toBe(true)
    expect(r2.remaining).toBe(0)

    const r3 = await rl.limit('user3', { cost: 1 })
    expect(r3.success).toBe(false)
  })

  it('resets after window expires', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 2,
      window: '1s',
      prefix: PREFIX,
    })

    // The fill and denial must land in the same 1s window to be meaningful.
    const denied = await inRedisWindow(redis, 1_000, async () => {
      await rl.reset('user4')
      await rl.limit('user4', { cost: 2 })
      return rl.limit('user4')
    })
    expect(denied.success).toBe(false)

    await waitForRedisTime(redis, 1100)

    const allowed = await rl.limit('user4')
    expect(allowed.success).toBe(true)
  })

  it('peek does not consume', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 5,
      window: '1h',
      prefix: PREFIX,
    })

    const peek1 = await rl.peek('user5')
    expect(peek1.success).toBe(true)
    expect(peek1.remaining).toBe(5)

    const peek2 = await rl.peek('user5')
    expect(peek2.remaining).toBe(5)

    await rl.limit('user5')
    const peek3 = await rl.peek('user5')
    expect(peek3.remaining).toBe(4)
  })

  it('returns correct headers', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 10,
      window: '1h',
      prefix: PREFIX,
    })

    const result = await rl.limit('user6')
    expect(result.headers['RateLimit-Limit']).toBe('10')
    expect(result.headers['RateLimit-Remaining']).toBe('9')
    expect(Number(result.headers['RateLimit-Reset'])).toBeGreaterThan(0)
  })

  it('isolates different identifiers', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1h',
      prefix: PREFIX,
    })

    const r1 = await rl.limit('userA')
    const r2 = await rl.limit('userB')
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)

    const r3 = await rl.limit('userA')
    expect(r3.success).toBe(false)

    const r4 = await rl.limit('userB')
    expect(r4.success).toBe(false)
  })
})
