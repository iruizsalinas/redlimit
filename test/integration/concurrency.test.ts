import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient, waitForRedisTime } from '../support/redis.js'
import { Limiter } from '../../src/ratelimit.js'
import { inRedisWindow, redisNowMs } from '../support/timing.js'

const PREFIX = 'test-conc'

describe('concurrency', { timeout: 120_000 }, () => {
  let redis: ReturnType<typeof createClient>

  function freshWindow<T>(limiter: Limiter, key: string, run: () => Promise<T>, windowMs = 30_000): Promise<T> {
    return inRedisWindow(redis, windowMs, async () => {
      await limiter.reset(key)
      return run()
    })
  }

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

  describe('atomicity', () => {
    it.each([
      ['fixed-window', { algorithm: 'fixed-window' as const, limit: 100, window: '30s' as const }],
      ['sliding-window', { algorithm: 'sliding-window' as const, limit: 100, window: '30s' as const }],
      ['token-bucket', { algorithm: 'token-bucket' as const, limit: 100, refill: { amount: 1, interval: '1000s' as const } }],
    ])('%s: 10,000 concurrent requests — exactly 100 allowed', async (name, config) => {
      const rl = new Limiter({ redis, ...config, prefix: PREFIX })

      const results = await freshWindow(rl, `atomicity-${name}`, () => Promise.all(
        Array.from({ length: 10_000 }, () => rl.limit(`atomicity-${name}`))
      ))

      expect(results.filter((r) => r.success).length).toBe(100)
    })

    it('100,000 concurrent requests — exactly 100 allowed', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 100,
        window: '1h',
        prefix: PREFIX,
      })

      const results = await freshWindow(rl, 'atomicity-100k', () => Promise.all(
        Array.from({ length: 100_000 }, () => rl.limit('atomicity-100k'))
      ), 3_600_000)

      expect(results.filter((r) => r.success).length).toBe(100)
    })
  })

  describe('key isolation', () => {
    it('10,000 keys x 20 requests each — every key gets exactly its limit', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'token-bucket',
        limit: 5,
        refill: { amount: 1, interval: '1000s' as const },
        prefix: PREFIX,
      })

      const KEYS = 10_000
      const REQS_PER_KEY = 20

      const results = await Promise.all(
        Array.from({ length: KEYS * REQS_PER_KEY }, (_, i) => {
          const key = i % KEYS
          return rl.limit(`key-${key}`).then((r) => ({ key, success: r.success }))
        })
      )

      const perKey = new Map<number, number>()
      for (const r of results) {
        if (r.success) perKey.set(r.key, (perKey.get(r.key) ?? 0) + 1)
      }

      for (let k = 0; k < KEYS; k++) {
        expect(perKey.get(k)).toBe(5)
      }
    })
  })

  describe('cost', () => {
    it('concurrent requests with cost 3 and limit 100 — exactly 33 allowed', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 100,
        window: '30s',
        prefix: PREFIX,
      })

      const results = await freshWindow(rl, 'cost-3', () => Promise.all(
        Array.from({ length: 50 }, () => rl.limit('cost-3', { cost: 3 }))
      ))

      expect(results.filter((r) => r.success).length).toBe(33)
    })

    it('random costs 1-5 never exceed limit and remaining stays consistent', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 1000,
        window: '30s',
        prefix: PREFIX,
      })

      const costs = Array.from({ length: 5_000 }, () => Math.ceil(Math.random() * 5))

      const { results, peek } = await freshWindow(rl, 'cost-rand', async () => {
        const results = await Promise.all(
          costs.map((cost) => rl.limit('cost-rand', { cost }).then((r) => ({ cost, success: r.success })))
        )
        return { results, peek: await rl.peek('cost-rand') }
      })

      let totalConsumed = 0
      for (const r of results) {
        if (r.success) totalConsumed += r.cost
      }

      expect(totalConsumed).toBeLessThanOrEqual(1000)

      expect(peek.remaining).toBe(1000 - totalConsumed)
    })
  })

  describe('remaining accuracy', () => {
    it('sequential remaining decrements correctly from limit to 0', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 100,
        window: '30s',
        prefix: PREFIX,
      })

      const { results, denied } = await freshWindow(rl, 'remaining-seq', async () => {
        const results = []
        for (let i = 0; i < 100; i++) results.push(await rl.limit('remaining-seq'))
        return { results, denied: await rl.limit('remaining-seq') }
      })
      for (let i = 0; i < results.length; i++) expect(results[i].remaining).toBe(99 - i)
      expect(denied.success).toBe(false)
      expect(denied.remaining).toBe(0)
    })

    it('remaining never goes negative under concurrent load', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 50,
        window: '30s',
        prefix: PREFIX,
      })

      const results = await Promise.all(
        Array.from({ length: 5_000 }, () => rl.limit('remaining-neg'))
      )

      for (const r of results) {
        expect(r.remaining).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('headers', () => {
    it('headers are valid under concurrent load', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'sliding-window',
        limit: 100,
        window: '30s',
        prefix: PREFIX,
      })

      const results = await Promise.all(
        Array.from({ length: 2_000 }, () => rl.limit('headers'))
      )

      for (const r of results) {
        expect(Number(r.headers['RateLimit-Limit'])).toBe(100)
        expect(Number(r.headers['RateLimit-Remaining'])).toBeGreaterThanOrEqual(0)
        expect(Number(r.headers['RateLimit-Reset'])).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('block and reset under load', () => {
    it('block stops all concurrent requests', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10_000,
        window: '30s',
        prefix: PREFIX,
      })

      await rl.block('blocked', '10s')

      const results = await Promise.all(
        Array.from({ length: 1_000 }, () => rl.limit('blocked'))
      )

      expect(results.filter((r) => r.success).length).toBe(0)
    })

    it('reset restores full capacity immediately', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 100,
        window: '30s',
        prefix: PREFIX,
      })

      const { denied, results } = await freshWindow(rl, 'reset-cap', async () => {
        await Promise.all(Array.from({ length: 100 }, () => rl.limit('reset-cap')))
        const denied = await rl.limit('reset-cap')
        await rl.reset('reset-cap')
        const results = await Promise.all(Array.from({ length: 500 }, () => rl.limit('reset-cap')))
        return { denied, results }
      })
      expect(denied.success).toBe(false)
      expect(results.filter((r) => r.success).length).toBe(100)
    })
  })

  describe('algorithm consistency', () => {
    it('all algorithms deny after exhaustion — zero leaks', async () => {
      const configs = [
        { algorithm: 'fixed-window' as const, limit: 50, window: '30s' as const },
        { algorithm: 'sliding-window' as const, limit: 50, window: '30s' as const },
        { algorithm: 'token-bucket' as const, limit: 50, refill: { amount: 1, interval: '1000s' as const } },
      ]

      for (const config of configs) {
        const rl = new Limiter({ redis, ...config, prefix: PREFIX })
        const key = `exhaust-${config.algorithm}`

        const flood = await freshWindow(rl, key, async () => {
          await Promise.all(Array.from({ length: 50 }, () => rl.limit(key)))
          return Promise.all(Array.from({ length: 1_000 }, () => rl.limit(key)))
        })

        expect(flood.filter((r) => r.success).length).toBe(0)
      }
    })

    it('three algorithms under simultaneous load — all hold', async () => {
      const fw = new Limiter({ redis, algorithm: 'fixed-window', limit: 200, window: '30s', prefix: `${PREFIX}-fw` })
      const sw = new Limiter({ redis, algorithm: 'sliding-window', limit: 200, window: '30s', prefix: `${PREFIX}-sw` })
      const tb = new Limiter({ redis, algorithm: 'token-bucket', limit: 200, refill: { amount: 1, interval: '1000s' as const }, prefix: `${PREFIX}-tb` })

      const [fwR, swR, tbR] = await inRedisWindow(redis, 30_000, async () => {
        await Promise.all([fw.reset('simul'), sw.reset('simul'), tb.reset('simul')])
        return Promise.all([
          Promise.all(Array.from({ length: 20_000 }, () => fw.limit('simul'))),
          Promise.all(Array.from({ length: 20_000 }, () => sw.limit('simul'))),
          Promise.all(Array.from({ length: 20_000 }, () => tb.limit('simul'))),
        ])
      })

      expect(fwR.filter((r) => r.success).length).toBe(200)
      expect(swR.filter((r) => r.success).length).toBe(200)
      expect(tbR.filter((r) => r.success).length).toBe(200)
    })
  })

  describe('sliding-window decay', () => {
    it('capacity recovers as previous window decays', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'sliding-window',
        limit: 100,
        window: '2s',
        prefix: PREFIX,
      })

      const { fill, peek } = await freshWindow(rl, 'decay', async () => ({
        fill: await Promise.all(Array.from({ length: 100 }, () => rl.limit('decay'))),
        peek: await rl.peek('decay'),
      }), 2_000)
      expect(fill.filter((r) => r.success).length).toBe(100)
      expect(peek.remaining).toBe(0)

      await waitForRedisTime(redis, 2200)

      const partial = await rl.peek('decay')
      expect(partial.remaining).toBeGreaterThan(0)
      expect(partial.remaining).toBeLessThanOrEqual(100)

      await waitForRedisTime(redis, 2200)

      expect((await rl.peek('decay')).remaining).toBe(100)
    })
  })

  describe('token-bucket refill', () => {
    it('refills at the configured rate', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'token-bucket',
        limit: 100,
        refill: { amount: 50, interval: '1s' },
        prefix: PREFIX,
      })

      // Drain atomically; a multi-command drain can refill while it is in flight.
      const started = await redisNowMs(redis)
      expect((await rl.limit('refill', { cost: 100 })).remaining).toBe(0)
      const drained = await redisNowMs(redis)

      await waitForRedisTime(redis, 1000)

      const beforePeek = await redisNowMs(redis)
      const refilled = await rl.peek('refill')
      const afterPeek = await redisNowMs(redis)
      // Bound the refill using Redis time rather than assuming exact scheduler timing.
      expect(refilled.remaining).toBeGreaterThanOrEqual(Math.min(100, Math.floor((beforePeek - drained) * 0.05)))
      expect(refilled.remaining).toBeLessThanOrEqual(Math.min(100, Math.ceil((afterPeek - started) * 0.05)))
    })

    it('never exceeds capacity after idle', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'token-bucket',
        limit: 10,
        refill: { amount: 1000, interval: '1s' },
        prefix: PREFIX,
      })

      await rl.limit('cap')
      await waitForRedisTime(redis, 500)

      expect((await rl.peek('cap')).remaining).toBe(10)
    })
  })

  describe('escalating load', () => {
    it('atomicity holds from 1K to 100K concurrent requests', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 100,
        window: '30s',
        prefix: PREFIX,
      })

      for (const count of [1_000, 10_000, 50_000, 100_000]) {
        const results = await freshWindow(rl, 'escalate', () => Promise.all(
          Array.from({ length: count }, () => rl.limit('escalate'))
        ))

        expect(results.filter((r) => r.success).length).toBe(100)
      }
    })
  })
})
