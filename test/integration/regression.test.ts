import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createClient, waitForRedisTime } from '../support/redis.js'
import { Limiter } from '../../src/ratelimit.js'
import { acrossRedisBoundary, redisNowMs } from '../support/timing.js'

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
      window: '1h',
      prefix,
      ban: {
        escalation: ['2s', '5s', '9s'],
        history: '7s',
      },
    })

    // Seed on the Redis clock, which is the one the scripts trim history against.
    const now = await redisNowMs(redis)
    await redis.zAdd(`${prefix}:{user}:banhist`, { score: now - 9_000, value: 'expired-seed' })
    await redis.zAdd(`${prefix}:{user}:banhist`, { score: now - 3_000, value: 'recent-seed' })

    await triggerBan(rl, 'user')
    const banTtl = await redis.pTTL(`${prefix}:{user}:blocked`)
    expect(banTtl).toBeGreaterThan(4_000)
    expect(banTtl).toBeLessThanOrEqual(5_000)
  })

  it('supports escalation ladders longer than eleven total ban levels', async () => {
    const prefix = `${PREFIX}-ban-depth`
    const blockedKey = `${prefix}:{user}:blocked`
    // Fresh counters avoid waiting for a fixed window to roll over. The shared
    // history still drives all twelve bans through the real API.
    for (let i = 0; i < 12; i++) {
      const rl = new Limiter({
        redis, algorithm: 'fixed-window', limit: 1, window: '1h', prefix: `${prefix}-${i}`,
        ban: {
          shared: prefix,
          escalation: [
            '10s', '10s', '10s', '10s', '10s', '10s',
            '10s', '10s', '10s', '10s', '10s', '1m',
          ],
          history: '1h',
        },
      })
      await triggerBan(rl, 'user')
      // Lift the ban instead of waiting for it; the history still records it.
      if (i < 11) await redis.del(blockedKey)
    }

    // 12th ban should use the last step (1m), not be capped
    const finalBanTtl = await redis.pTTL(blockedKey)
    expect(finalBanTtl).toBeGreaterThan(50_000)
    expect(finalBanTtl).toBeLessThanOrEqual(60_000)
  })

  it('self-heals malformed ban history keys without breaking ban escalation', async () => {
    const prefix = `${PREFIX}-banhist-heal`
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1h',
      prefix,
      ban: {
        escalation: ['10s'],
        history: '1m',
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
