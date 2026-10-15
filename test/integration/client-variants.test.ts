import { describe, it, expect } from 'vitest'
import { createClient as createNodeClient, createClientPool } from 'redis'
import Redis from 'ioredis'
import { requireRedisUrl } from '../support/redis.js'
import { Limiter } from '../../src/ratelimit.js'

// Each matrix cell covers the configurations users commonly pass for its own client.
const client = process.env.REDIS_CLIENT
const socket = { connectTimeout: 5_000, reconnectStrategy: false as const }

function majorVersion(info: string): number {
  const match = /redis_version:(\d+)/.exec(info)
  if (!match) throw new Error('INFO server did not report redis_version')
  return Number(match[1])
}

// Same flow for every variant: consume, deny, peek without consuming, ban, reset.
async function exerciseLimiter(redis: unknown, prefix: string): Promise<void> {
  const limiter = new Limiter({
    redis, algorithm: 'sliding-window', limit: 2, window: '1h', prefix,
    ban: { escalation: ['1h'], history: '1d' },
  })
  await limiter.reset('user')
  const first = await limiter.limit('user')
  expect(first.success).toBe(true)
  expect(first.remaining).toBe(1)
  expect(typeof first.reset).toBe('number')
  expect((await limiter.limit('user')).remaining).toBe(0)
  expect((await limiter.limit('user')).success).toBe(false)
  const banned = await limiter.peek('user')
  expect(banned.success).toBe(false)
  expect(banned.remaining).toBe(0)
  await limiter.reset('user')
  const cleared = await limiter.peek('user')
  expect(cleared.success).toBe(true)
  expect(cleared.remaining).toBe(2)
}

if (client === 'redis') {
  describe('node-redis client variants', () => {
    it('RESP3 replies decode to the same results', async () => {
      const probe = createNodeClient({ url: requireRedisUrl(), socket })
      probe.on('error', () => {})
      await probe.connect()
      const major = majorVersion(await probe.info('server'))
      await probe.quit()
      if (major < 6) return // HELLO 3 needs Redis 6+.

      const redis = createNodeClient({ url: requireRedisUrl(), socket, RESP: 3 })
      redis.on('error', () => {})
      await redis.connect()
      try {
        await exerciseLimiter(redis, 'test-variant-resp3')
      } finally { await redis.quit() }
    })

    it('client pools enforce one shared limit', async () => {
      const pool = createClientPool({ url: requireRedisUrl(), socket }, { maximum: 4 })
      pool.on('error', () => {})
      await pool.connect()
      try {
        await exerciseLimiter(pool, 'test-variant-pool')
        const limiter = new Limiter({ redis: pool, algorithm: 'fixed-window', limit: 10, window: '1h', prefix: 'test-variant-pool' })
        await limiter.reset('shared')
        const results = await Promise.all(Array.from({ length: 50 }, () => limiter.limit('shared')))
        expect(results.filter(result => result.success)).toHaveLength(10)
        await limiter.reset('shared')
      } finally { await pool.close() }
    })

    it('duplicated clients are accepted', async () => {
      const base = createNodeClient({ url: requireRedisUrl(), socket })
      const redis = base.duplicate()
      redis.on('error', () => {})
      await redis.connect()
      try {
        await exerciseLimiter(redis, 'test-variant-duplicate')
      } finally { await redis.quit() }
    })
  })
}

if (client === 'ioredis') {
  describe('ioredis client variants', () => {
    it('keyPrefix is applied to every key the limiter touches', async () => {
      const redis = new Redis(requireRedisUrl(), { lazyConnect: true, retryStrategy: null, keyPrefix: 'app:' })
      const raw = new Redis(requireRedisUrl(), { lazyConnect: true, retryStrategy: null })
      redis.on('error', () => {})
      raw.on('error', () => {})
      await Promise.all([redis.connect(), raw.connect()])
      try {
        await exerciseLimiter(redis, 'test-variant-prefix')
        const limiter = new Limiter({ redis, algorithm: 'fixed-window', limit: 2, window: '1h', prefix: 'test-variant-prefix-fw' })
        await limiter.reset('user')
        await limiter.limit('user')
        await limiter.block('user', '1h')
        expect(await raw.keys('test-variant-prefix*')).toEqual([])
        const keys = await raw.keys('app:test-variant-prefix-fw:*')
        expect(keys).toContain('app:test-variant-prefix-fw:{user}:blocked')
        expect(keys.length).toBeGreaterThanOrEqual(2)
        expect((await limiter.peek('user')).success).toBe(false)
        await limiter.reset('user')
        expect(await raw.keys('app:test-variant-prefix-fw:*')).toEqual([])
      } finally { await Promise.all([redis.quit(), raw.quit()]) }
    })

    it('lazyConnect clients connect on the first limiter call', async () => {
      const redis = new Redis(requireRedisUrl(), { lazyConnect: true, retryStrategy: null })
      redis.on('error', () => {})
      try {
        expect(redis.status).toBe('wait')
        await exerciseLimiter(redis, 'test-variant-lazy')
        expect(redis.status).toBe('ready')
      } finally { await redis.quit() }
    })
  })
}
