import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createClient } from 'redis'
import { Limiter } from '../../src/ratelimit.js'

const PREFIX = 'test-regression'

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

async function triggerBan(limiter: Limiter, identifier: string) {
  const allowed = await limiter.limit(identifier)
  expect(allowed.success).toBe(true)

  const denied = await limiter.limit(identifier)
  expect(denied.success).toBe(false)
}

describe('regressions (integration)', () => {
  let redis: ReturnType<typeof createClient>

  beforeAll(async () => {
    redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' })
    await redis.connect()
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    const keys = await redis.keys(`${PREFIX}*`)
    if (keys.length > 0) await redis.del(keys)
  })

  it('ignores expired ban history entries when computing escalation', async () => {
    const prefix = `${PREFIX}-ban-window`
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1s',
      prefix,
      ban: {
        escalation: ['200ms', '500ms', '900ms'],
        history: '700ms',
      },
    })

    const now = Date.now()
    await redis.zAdd(`${prefix}:{user}:banhist`, { score: now - 900, value: 'expired-seed' })
    await redis.zAdd(`${prefix}:{user}:banhist`, { score: now - 300, value: 'recent-seed' })

    await triggerBan(rl, 'user')
    const banTtl = await redis.pTTL(`${prefix}:{user}:blocked`)
    expect(banTtl).toBeGreaterThan(350)
    expect(banTtl).toBeLessThanOrEqual(550)
  })

  it('supports escalation ladders longer than eleven total ban levels', async () => {
    const prefix = `${PREFIX}-ban-depth`
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '50ms',
      prefix,
      ban: {
        escalation: [
          '60ms', '60ms', '60ms', '60ms', '60ms', '60ms',
          '60ms', '60ms', '60ms', '60ms', '60ms', '300ms',
        ],
        history: '5s',
      },
    })

    // Trigger 12 real ban cycles through the API
    for (let i = 0; i < 12; i++) {
      await triggerBan(rl, 'user')
      if (i < 11) await sleep(120) // wait for ban (60ms) + window (50ms) to expire
    }

    // 12th ban should use the last step (300ms), not be capped
    const finalBanTtl = await redis.pTTL(`${prefix}:{user}:blocked`)
    expect(finalBanTtl).toBeGreaterThan(220)
    expect(finalBanTtl).toBeLessThanOrEqual(320)
  })

  it('self-heals malformed ban history keys without breaking ban escalation', async () => {
    const prefix = `${PREFIX}-banhist-heal`
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1s',
      prefix,
      ban: {
        escalation: ['300ms'],
        history: '10s',
      },
    })

    await redis.set(`${prefix}:{user}:banhist`, 'wrong-type')

    await triggerBan(rl, 'user')

    const blocked = await redis.get(`${prefix}:{user}:blocked`)
    const histType = await redis.type(`${prefix}:{user}:banhist`)
    const histCount = await redis.zCard(`${prefix}:{user}:banhist`)

    expect(blocked).toBe('1')
    expect(histType).toBe('zset')
    expect(histCount).toBe(1)
  })

  it('denies a second sliding-window request immediately after a boundary when prior weight is still active', async () => {
    const prefix = `${PREFIX}-sliding`
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 1,
      window: '200ms',
      prefix,
    })

    // Make a real request near the end of a window
    await waitForRedisPhase(redis, 200, 170, 195)
    await rl.limit('boundary')

    // Early in the next window, previous weight still applies
    await waitForRedisPhase(redis, 200, 5, 25)

    const peek = await rl.peek('boundary')
    expect(peek.success).toBe(false)

    const second = await rl.limit('boundary')
    expect(second.success).toBe(false)
  })

  it('sliding-window reset time is accurate, not just the next window boundary', async () => {
    const prefix = `${PREFIX}-sw-reset`
    const windowMs = 200
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 1,
      window: '200ms',
      prefix,
    })

    // Fill at the end of a window so previous weight carries into next
    await waitForRedisPhase(redis, windowMs, 170, 195)
    await rl.limit('precise')

    // Move into the next window — should be denied
    await waitForRedisPhase(redis, windowMs, 10, 30)
    const denied = await rl.limit('precise')
    expect(denied.success).toBe(false)

    // The reset time should be sooner than the next window boundary
    // (recovery happens via decay, not by waiting for a full window)
    const msUntilReset = denied.reset - Date.now()
    expect(msUntilReset).toBeLessThan(windowMs)
    expect(msUntilReset).toBeGreaterThan(0)

    // Wait until the returned reset time, then try again — should succeed
    await sleep(msUntilReset + 5)

    const allowed = await rl.limit('precise')
    expect(allowed.success).toBe(true)
  })
})
