import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Redis from 'ioredis'
import { Limiter } from '../../src/ratelimit.js'

const PREFIX = 'test-io'

describe('ioredis (integration)', () => {
  let redis: Redis

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    const keys = await redis.keys(`${PREFIX}*`)
    if (keys.length > 0) await redis.del(...keys)
  })

  it('fixed-window: allows within limit and denies over', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 3,
      window: '10s',
      prefix: PREFIX,
    })

    for (let i = 0; i < 3; i++) {
      expect((await rl.limit('user1')).success).toBe(true)
    }

    const denied = await rl.limit('user1')
    expect(denied.success).toBe(false)
    expect(denied.remaining).toBe(0)
  })

  it('sliding-window: allows within limit and denies over', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 3,
      window: '10s',
      prefix: PREFIX,
    })

    for (let i = 0; i < 3; i++) {
      expect((await rl.limit('user2')).success).toBe(true)
    }

    expect((await rl.limit('user2')).success).toBe(false)
  })

  it('token-bucket: burst up to capacity then denies', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 5,
      refillRate: 1,
      prefix: PREFIX,
    })

    for (let i = 0; i < 5; i++) {
      expect((await rl.limit('user3')).success).toBe(true)
    }

    expect((await rl.limit('user3')).success).toBe(false)
  })

  it('peek does not consume', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
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

  it('block prevents access and reset restores it', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 100,
      window: '10s',
      prefix: PREFIX,
    })

    await rl.block('user5', '5s')
    expect((await rl.limit('user5')).success).toBe(false)

    await rl.reset('user5')
    expect((await rl.limit('user5')).success).toBe(true)
  })

  it('cost parameter respected', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 10,
      window: '10s',
      prefix: PREFIX,
    })

    const r1 = await rl.limit('user6', { cost: 7 })
    expect(r1.success).toBe(true)
    expect(r1.remaining).toBe(3)

    const r2 = await rl.limit('user6', { cost: 4 })
    expect(r2.success).toBe(false)
  })

  it('ban escalation triggers on denial', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '10s',
      prefix: PREFIX,
      ban: {
        escalation: ['5s'],
        history: '1m',
      },
    })

    await rl.limit('user7')
    await rl.limit('user7') // denied + banned

    const blocked = await redis.get(`${PREFIX}:{user7}:blocked`)
    expect(blocked).toBe('1')
  })

  it('concurrent requests — exactly limit allowed', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 100,
      window: '30s',
      prefix: PREFIX,
    })

    const results = await Promise.all(
      Array.from({ length: 1000 }, () => rl.limit('user8'))
    )

    expect(results.filter((r) => r.success).length).toBe(100)
  })

  it('returns correct headers', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 10,
      window: '30s',
      prefix: PREFIX,
    })

    const result = await rl.limit('user9')
    expect(result.headers['RateLimit-Limit']).toBe('10')
    expect(result.headers['RateLimit-Remaining']).toBe('9')
    expect(Number(result.headers['RateLimit-Reset'])).toBeGreaterThan(0)
  })
})
