import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAdapter } from '../../src/adapter.js'
import { fixedWindow } from '../../src/algorithms/fixed-window.js'
import { slidingWindow } from '../../src/algorithms/sliding-window.js'
import { tokenBucket } from '../../src/algorithms/token-bucket.js'
import { Limiter } from '../../src/ratelimit.js'
import type { AlgorithmHandler, RedisAdapter } from '../../src/types.js'
import { createClient } from '../support/redis.js'

// Execute the production scripts with a controlled server clock. This lets us
// test floating-point boundaries without sleeps or a change to Redis's clock.
function withTime(adapter: RedisAdapter, now: number): RedisAdapter {
  return {
    ...adapter,
    eval: (script, keys, args) => adapter.eval(
      script.replace("redis.call('TIME')", `{ '${Math.floor(now / 1000)}', '${now % 1000 * 1000}' }`),
      keys,
      args,
    ),
  }
}

describe('Lua numeric and refill regressions', () => {
  let redis: ReturnType<typeof createClient>
  let adapter: RedisAdapter
  const prefix = 'test-lua-numeric'
  const now = 1_800_000_000_000

  beforeAll(async () => {
    redis = createClient()
    await redis.connect()
    adapter = createAdapter(redis)
  })

  afterAll(async () => { await redis.quit() })

  it('round-trips large token balances without creating or losing tokens', async () => {
    const id = 'large-balance'
    const capacity = Number.MAX_SAFE_INTEGER
    const clock = withTime(adapter, now)
    await tokenBucket.reset(adapter, prefix, prefix, id, 0, false)
    try {
      const first = await tokenBucket.limit(clock, prefix, prefix, id, capacity, 0, 1e10, 1, null)
      const second = await tokenBucket.limit(clock, prefix, prefix, id, capacity, 0, 1e10, 1, null)
      expect(first[1]).toBe(capacity - 1)
      expect(second[1]).toBe(capacity - 2)
      const peek = await tokenBucket.peek(clock, prefix, prefix, id, capacity, 0, 1e10)
      expect(peek[1]).toBe(capacity - 2)
    } finally { await tokenBucket.reset(adapter, prefix, prefix, id, 0, false) }
  })

  it.each([
    ['fixed-window', fixedWindow],
    ['sliding-window', slidingWindow],
  ] as [string, AlgorithmHandler][])(
    '%s preserves remaining counts near the safe integer limit', async (id, algorithm) => {
      const clock = withTime(adapter, now)
      await algorithm.reset(clock, prefix, prefix, id, 60_000, false)
      try {
        await algorithm.limit(clock, prefix, prefix, id, Number.MAX_SAFE_INTEGER, 60_000, 0, 1, null)
        const next = await algorithm.limit(clock, prefix, prefix, id, Number.MAX_SAFE_INTEGER, 60_000, 0, 1, null)
        expect(next[1]).toBe(Number.MAX_SAFE_INTEGER - 2)
        const peek = await algorithm.peek(clock, prefix, prefix, id, Number.MAX_SAFE_INTEGER, 60_000, 0)
        expect(peek[1]).toBe(Number.MAX_SAFE_INTEGER - 2)
      } finally { await algorithm.reset(clock, prefix, prefix, id, 60_000, false) }
    },
  )

  it('round-trips fractional balances needing more than fourteen significant digits', async () => {
    const id = 'fractional-balance'
    const rate = 0.11234567890123457
    await tokenBucket.reset(adapter, prefix, prefix, id, 0, false)
    try {
      await tokenBucket.limit(withTime(adapter, now), prefix, prefix, id, 3, 0, rate, 3, null)
      const next = await tokenBucket.limit(withTime(adapter, now + 10_000), prefix, prefix, id, 3, 0, rate, 1, null)
      expect(next[0]).toBe(1)
      const stored = await adapter.eval("return redis.call('HGET', KEYS[1], 'tokens')", [`${prefix}:{${id}}`], [])
      expect(Number(stored)).toBe(10_000 * rate / 1000 - 1)
    } finally { await tokenBucket.reset(adapter, prefix, prefix, id, 0, false) }
  })

  it('does not rewrite state or prolong expiry on rejected requests', async () => {
    const id = 'read-only-denial'
    const key = `${prefix}:{${id}}`
    await tokenBucket.reset(adapter, prefix, prefix, id, 0, false)
    try {
      await tokenBucket.limit(withTime(adapter, now), prefix, prefix, id, 10, 0, 1, 10, null)
      // Make any attempted expiry refresh visible without waiting on wall time.
      await adapter.eval("return redis.call('PEXPIRE', KEYS[1], 5000)", [key], [])
      for (const offset of [100, 500, 999]) {
        const denied = await tokenBucket.limit(withTime(adapter, now + offset), prefix, prefix, id, 10, 0, 1, 1, null)
        expect(denied[0]).toBe(0)
        // Binary floating point may conservatively round the wait up by 1ms.
        expect(denied[2]).toBeGreaterThanOrEqual(now + 1000)
        expect(denied[2]).toBeLessThanOrEqual(now + 1001)
      }
      const state = await adapter.eval("return redis.call('HMGET', KEYS[1], 'tokens', 'ts')", [key], [])
      expect(state).toEqual(['0', String(now)])
      expect(await redis.pTTL(key)).toBeLessThanOrEqual(5000)
      const allowed = await tokenBucket.limit(withTime(adapter, now + 1000), prefix, prefix, id, 10, 0, 1, 1, null)
      expect(allowed[0]).toBe(1)
    } finally { await tokenBucket.reset(adapter, prefix, prefix, id, 0, false) }
  })

  it('finishes the sliding retry search when midpoint sums exceed the safe range', async () => {
    const id = 'large-window'
    const windowMs = 4_000_000_000_000_000
    const clock = withTime(adapter, now)
    await slidingWindow.reset(clock, prefix, prefix, id, windowMs, false)
    try {
      expect((await slidingWindow.limit(clock, prefix, prefix, id, 1, windowMs, 0, 1, null))[0]).toBe(1)
      // A test timeout cannot stop a Lua loop. Bound iterations in this copy so
      // a regression fails the assertion without leaving the Redis server busy.
      const guarded: RedisAdapter = {
        ...clock,
        eval: (script, keys, args) => clock.eval(script.replace('while low < high do',
          "local iterations = 0\n  while low < high do\n    iterations = iterations + 1\n    if iterations > 64 then return redis.error_reply('retry search did not converge') end"), keys, args),
      }
      const denied = await slidingWindow.limit(guarded, prefix, prefix, id, 1, windowMs, 0, 1, null)
      expect(denied[0]).toBe(0)
      expect(denied[2]).toBe(windowMs * 2)
      const peek = await slidingWindow.peek(guarded, prefix, prefix, id, 1, windowMs, 0)
      expect(peek[2]).toBe(windowMs * 2)
    } finally { await slidingWindow.reset(clock, prefix, prefix, id, windowMs, false) }
  })

  it.each([
    ['fixed-window', fixedWindow, Number.MAX_SAFE_INTEGER, 0],
    ['sliding-window', slidingWindow, 4_503_599_627_369_000, 0],
    ['token-bucket', tokenBucket, 0, 1 / 9_007_199_254_000],
  ] as [string, AlgorithmHandler, number, number][])(
    '%s rejects unsafe absolute timestamps before writing state',
    async (name, algorithm, windowMs, refillRate) => {
      const clock = withTime(adapter, now)
      const base = `${prefix}:{${name}}`
      const windowId = Math.floor(now / windowMs)
      const keys = [base, `${base}:blocked`, `${base}:banhist`,
        ...(windowMs > 0 ? [`${base}:${windowId}`, `${base}:${windowId - 1}`] : []),
      ]
      await adapter.del(...keys)
      const exists = () => adapter.eval("return redis.call('EXISTS', unpack(KEYS))", keys, [])
      try {
        await expect(algorithm.limit(clock, prefix, prefix, name, 1, windowMs, refillRate, 1, null))
          .rejects.toThrow('timestamps that are too large')
        expect(await exists()).toBe(0)
        await expect(algorithm.peek(clock, prefix, prefix, name, 1, windowMs, refillRate))
          .rejects.toThrow('timestamps that are too large')
        expect(await exists()).toBe(0)
      } finally { await adapter.del(...keys) }
    },
  )

  it.each(['fixed-window', 'sliding-window', 'token-bucket'] as const)(
    '%s does not fail open on an invalid timestamp configuration', async algorithm => {
      const limiter = new Limiter({
        redis, algorithm, prefix, limit: 1, fail: 'open',
        window: algorithm === 'fixed-window' ? '9007199254740991ms' : '4503599627369000ms',
        refill: { amount: 1, interval: '9007199254000000ms' },
      })
      await expect(limiter.limit('fail-open-config')).rejects.toThrow('REDLIMIT_INVALID_CONFIG')
      await expect(limiter.peek('fail-open-config')).rejects.toThrow('REDLIMIT_INVALID_CONFIG')
    },
  )
})
