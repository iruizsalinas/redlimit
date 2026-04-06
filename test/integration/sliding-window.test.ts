import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from 'redis'
import { Limiter } from '../../src/ratelimit.js'

const PREFIX = 'test-sw'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function redisNowMs(redis: ReturnType<typeof createClient>): Promise<number> {
  const [seconds, microseconds] = await redis.time()
  return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000)
}

async function waitForRedisPhase(
  redis: ReturnType<typeof createClient>,
  windowMs: number,
  minInclusive: number,
  maxExclusive: number,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const phase = (await redisNowMs(redis)) % windowMs
    if (phase >= minInclusive && phase < maxExclusive) {
      return
    }
    await sleep(1)
  }

  throw new Error(
    `Timed out waiting for Redis phase ${minInclusive}-${maxExclusive} of ${windowMs}ms window.`
  )
}

describe('sliding-window (integration)', () => {
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
      window: '200ms',
      prefix: PREFIX,
    })

    await waitForRedisPhase(redis, 200, 170, 195)

    // Fill up the tail end of a window.
    for (let i = 0; i < 3; i++) {
      await rl.limit('user5')
    }

    const denied = await rl.limit('user5')
    expect(denied.success).toBe(false)

    // Early in the next window, most of the previous pressure still applies.
    await waitForRedisPhase(redis, 200, 5, 25)
    const stillDenied = await rl.peek('user5')
    expect(stillDenied.success).toBe(false)

    // Later in the same window, the weighted previous count has decayed enough to admit one more.
    await waitForRedisPhase(redis, 200, 120, 170)
    const allowed = await rl.limit('user5')
    expect(allowed.success).toBe(true)
  })
})
