import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from 'redis'
import { Limiter } from '../../src/ratelimit.js'

const PREFIX = 'test-ban'

describe('ban escalation', () => {
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

  it('bans on first limit violation', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 2,
      window: '10s',
      prefix: PREFIX,
      ban: {
        escalation: ['2s', '5s', '10s'],
        history: '1m',
      },
    })

    await rl.limit('user1')
    await rl.limit('user1')

    // Third request should be denied AND trigger a ban
    const denied = await rl.limit('user1')
    expect(denied.success).toBe(false)

    // Should be blocked even after the window resets conceptually
    const blocked = await rl.limit('user1')
    expect(blocked.success).toBe(false)
  })

  it('ban expiry allows requests again', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1h',
      prefix: PREFIX,
      ban: {
        escalation: ['1s'],
        history: '1m',
      },
    })

    await rl.limit('user2')
    await rl.limit('user2') // denied + banned for 1s

    await new Promise((r) => setTimeout(r, 1100))

    // Ban expired — should be allowed (rate limit still active though)
    const result = await rl.peek('user2')
    // peek checks blocked key — should be cleared
    expect(result.success).toBe(false) // still rate limited within the window
    // But the blocked key should be gone
    const blockedKey = await redis.get(`${PREFIX}:{user2}:blocked`)
    expect(blockedKey).toBeNull()
  })

  it('escalates ban duration on repeat offenses', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '1s',
      prefix: PREFIX,
      ban: {
        escalation: ['1s', '2s', '5s'],
        history: '30s',
      },
    })

    // First offense
    await rl.limit('user3')
    await rl.limit('user3') // denied → banned 1s

    // Check ban duration (should be ~1s)
    const pttl1 = await redis.pTTL(`${PREFIX}:{user3}:blocked`)
    expect(pttl1).toBeGreaterThan(0)
    expect(pttl1).toBeLessThanOrEqual(1000)

    // Wait for ban to expire
    await new Promise((r) => setTimeout(r, 1100))

    // Reset rate limit state for next test
    await rl.reset('user3')
    // Re-add ban history (reset cleared it, so manually restore)
    await redis.zAdd(`${PREFIX}:{user3}:banhist`, { score: Date.now(), value: `seed-${Date.now()}` })

    // Second offense
    await rl.limit('user3')
    await rl.limit('user3') // denied → banned 2s (escalated)

    const pttl2 = await redis.pTTL(`${PREFIX}:{user3}:blocked`)
    expect(pttl2).toBeGreaterThan(1000)
    expect(pttl2).toBeLessThanOrEqual(2000)
  })

  it('caps at max escalation step', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '10s',
      prefix: PREFIX,
      ban: {
        escalation: ['1s', '2s'],
        history: '30s',
      },
    })

    // Seed ban history with 5 entries (more than escalation steps)
    for (let i = 0; i < 5; i++) {
      const now = Date.now() + i
      await redis.zAdd(`${PREFIX}:{user4}:banhist`, { score: now, value: `seed-${now}` })
    }

    await rl.limit('user4')
    await rl.limit('user4') // denied → should use last step (2s), not crash

    const pttl = await redis.pTTL(`${PREFIX}:{user4}:blocked`)
    expect(pttl).toBeGreaterThan(1000)
    expect(pttl).toBeLessThanOrEqual(2000)
  })

  it('peek does not trigger ban', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '10s',
      prefix: PREFIX,
      ban: {
        escalation: ['10s'],
        history: '1m',
      },
    })

    await rl.limit('user5')

    // Peek when over limit should NOT trigger ban
    await rl.peek('user5')
    await rl.peek('user5')

    const blockedKey = await redis.get(`${PREFIX}:{user5}:blocked`)
    expect(blockedKey).toBeNull()

    // But limit() should trigger ban
    await rl.limit('user5')
    const blockedKey2 = await redis.get(`${PREFIX}:{user5}:blocked`)
    expect(blockedKey2).toBe('1')
  })

  it('reset clears ban history', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '10s',
      prefix: PREFIX,
      ban: {
        escalation: ['1s', '5s'],
        history: '1m',
      },
    })

    await rl.limit('user6')
    await rl.limit('user6') // denied → banned

    const histBefore = await redis.zCard(`${PREFIX}:{user6}:banhist`)
    expect(histBefore).toBe(1)

    await rl.reset('user6')

    const histAfter = await redis.zCard(`${PREFIX}:{user6}:banhist`)
    expect(histAfter).toBe(0)

    const blockedKey = await redis.get(`${PREFIX}:{user6}:blocked`)
    expect(blockedKey).toBeNull()
  })

  it('ban works with all algorithms', async () => {
    const configs = [
      { algorithm: 'fixed-window' as const, limit: 1, window: '10s' as const },
      { algorithm: 'sliding-window' as const, limit: 1, window: '10s' as const },
      { algorithm: 'token-bucket' as const, limit: 1, refillRate: 0.001 },
    ]

    for (const config of configs) {
      const rl = new Limiter({
        redis,
        ...config,
        prefix: `${PREFIX}-${config.algorithm}`,
        ban: {
          escalation: ['5s'],
          history: '1m',
        },
      })

      const key = 'user7'
      await rl.limit(key)
      await rl.limit(key) // denied → banned

      const blocked = await redis.get(`${PREFIX}-${config.algorithm}:{${key}}:blocked`)
      expect(blocked).toBe('1')

      await rl.reset(key)
    }
  })

  it('concurrent denials all result in ban', async () => {
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

    // Use up the limit
    await rl.limit('user8')

    // Fire 100 concurrent requests — all should be denied
    const results = await Promise.all(
      Array.from({ length: 100 }, () => rl.limit('user8'))
    )

    const allowed = results.filter((r) => r.success).length
    expect(allowed).toBe(0)

    // Should be banned
    const blocked = await redis.get(`${PREFIX}:{user8}:blocked`)
    expect(blocked).toBe('1')
  })

  it('without ban config, no banning occurs', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '10s',
      prefix: PREFIX,
      // no ban config
    })

    await rl.limit('user9')
    await rl.limit('user9') // denied but no ban

    const blocked = await redis.get(`${PREFIX}:{user9}:blocked`)
    expect(blocked).toBeNull()

    const hist = await redis.zCard(`${PREFIX}:{user9}:banhist`)
    expect(hist).toBe(0)
  })

  it('repeated denials while banned do not re-escalate', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '10s',
      prefix: PREFIX,
      ban: {
        escalation: ['2s', '10s'],
        history: '1m',
      },
    })

    // Exhaust limit + trigger first ban (2s)
    await rl.limit('user10')
    await rl.limit('user10') // denied → banned 2s

    const histAfterFirstBan = await redis.zCard(`${PREFIX}:{user10}:banhist`)
    expect(histAfterFirstBan).toBe(1)

    // Spam 50 more requests while banned — should NOT add to history
    for (let i = 0; i < 50; i++) {
      await rl.limit('user10')
    }

    const histAfterSpam = await redis.zCard(`${PREFIX}:{user10}:banhist`)
    expect(histAfterSpam).toBe(1) // still 1, not 51

    // Ban should still be the first step duration (~2s), not escalated
    const pttl = await redis.pTTL(`${PREFIX}:{user10}:blocked`)
    expect(pttl).toBeLessThanOrEqual(2000)
  })

  it('shared ban — ban from one limiter blocks another', async () => {
    const apiLimit = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 2,
      refillRate: 0.001,
      prefix: `${PREFIX}-api`,
      ban: {
        escalation: ['10s'],
        history: '1m',
        shared: `${PREFIX}-shared`,
      },
    })

    const oauthLimit = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 2,
      refillRate: 0.001,
      prefix: `${PREFIX}-oauth`,
      ban: {
        escalation: ['10s'],
        history: '1m',
        shared: `${PREFIX}-shared`,
      },
    })

    // Exhaust API limit + trigger ban
    await apiLimit.limit('badactor')
    await apiLimit.limit('badactor')
    await apiLimit.limit('badactor') // denied → banned via shared prefix

    // OAuth should also be blocked (shared ban key)
    const oauthResult = await oauthLimit.limit('badactor')
    expect(oauthResult.success).toBe(false)

    // Verify the shared ban key exists
    const blocked = await redis.get(`${PREFIX}-shared:{badactor}:blocked`)
    expect(blocked).toBe('1')

    // Cleanup
    const keys = await redis.keys(`${PREFIX}-api*`)
    const keys2 = await redis.keys(`${PREFIX}-oauth*`)
    const keys3 = await redis.keys(`${PREFIX}-shared*`)
    const all = [...keys, ...keys2, ...keys3]
    if (all.length > 0) await redis.del(all)
  })

  it('without shared — bans are independent', async () => {
    const limiterA = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '10s',
      prefix: `${PREFIX}-a`,
      ban: {
        escalation: ['10s'],
        history: '1m',
      },
    })

    const limiterB = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 1,
      window: '10s',
      prefix: `${PREFIX}-b`,
      ban: {
        escalation: ['10s'],
        history: '1m',
      },
    })

    await limiterA.limit('user')
    await limiterA.limit('user') // denied → banned on prefix-a

    // Limiter B should NOT be affected
    const result = await limiterB.limit('user')
    expect(result.success).toBe(true)

    const keys = await redis.keys(`${PREFIX}-a*`)
    const keys2 = await redis.keys(`${PREFIX}-b*`)
    const all = [...keys, ...keys2]
    if (all.length > 0) await redis.del(all)
  })

  it('validates ban.escalation is non-empty', () => {
    expect(() => new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 5,
      window: '10s',
      ban: { escalation: [], history: '1m' },
    })).toThrow('non-empty array')
  })
})
