import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createClient, waitForRedisTime } from '../support/redis.js'
import { Limiter } from '../../src/ratelimit.js'
import { acrossRedisBoundary, inRedisWindow } from '../support/timing.js'

const PREFIX = 'test-regression'

async function triggerBan(limiter: Limiter, identifier: string) {
  const allowed = await limiter.limit(identifier)
  expect(allowed.success).toBe(true)

  const denied = await limiter.limit(identifier)
  expect(denied.success).toBe(false)
}

describe('regressions (integration)', () => {
  let redis: ReturnType<typeof createClient>

  beforeAll(async () => {
    redis = createClient()
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
    const { levels, finalBanTtl } = await inRedisWindow(redis, 5_000, async () => {
      const keys = await redis.keys(`${prefix}*`)
      if (keys.length > 0) await redis.del(keys)
      const levels = []
      // Fresh counters avoid waiting for a tiny fixed window to expire. The
      // shared history still drives all twelve bans through the real API.
      for (let i = 0; i < 12; i++) {
        const rl = new Limiter({
          redis, algorithm: 'fixed-window', limit: 1, window: '30s', prefix: `${prefix}-${i}`,
          ban: {
            shared: prefix,
            escalation: [
              '60ms', '60ms', '60ms', '60ms', '60ms', '60ms',
              '60ms', '60ms', '60ms', '60ms', '60ms', '300ms',
            ],
            history: '5s',
          },
        })
        levels.push({ allowed: await rl.limit('user'), denied: await rl.limit('user') })
        if (i < 11) await waitForRedisTime(redis, 120)
      }
      return { levels, finalBanTtl: await redis.pTTL(`${prefix}:{user}:blocked`) }
    })
    for (const level of levels) {
      expect(level.allowed.success).toBe(true)
      expect(level.denied.success).toBe(false)
    }

    // 12th ban should use the last step (300ms), not be capped
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
      window: '2s',
      prefix,
    })

    const { filled, probed: { peek, second } } = await acrossRedisBoundary(redis, 2_000, async () => {
      await rl.reset('boundary')
      return rl.limit('boundary')
    }, async () => ({ peek: await rl.peek('boundary'), second: await rl.limit('boundary') }))
    expect(filled.success).toBe(true)
    expect(peek.success).toBe(false)
    expect(second.success).toBe(false)
  })

  it('sliding-window reset time is accurate, not just the next window boundary', async () => {
    const prefix = `${PREFIX}-sw-reset`
    const windowMs = 2_000
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 1,
      window: '2s',
      prefix,
    })

    const { filled, probed: { denied, msUntilReset } } = await acrossRedisBoundary(redis, windowMs, async () => {
      await rl.reset('precise')
      return rl.limit('precise')
    }, async () => {
      const denied = await rl.limit('precise')
      return { denied, msUntilReset: denied.reset - Date.now() }
    })
    expect(filled.success).toBe(true)
    expect(denied.success).toBe(false)

    // The reset time should be sooner than the next window boundary
    // (recovery happens via decay, not by waiting for a full window)
    expect(msUntilReset).toBeLessThan(windowMs)
    expect(msUntilReset).toBeGreaterThan(0)

    // Wait until the returned reset time, then try again — should succeed
    await waitForRedisTime(redis, msUntilReset + 5)

    const allowed = await rl.limit('precise')
    expect(allowed.success).toBe(true)
  })
})
