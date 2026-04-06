import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient } from 'redis'
import { Limiter } from '../../src/ratelimit.js'

const PREFIX = 'test-bl'

describe('block and reset (integration)', () => {
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

  it('block prevents limit from succeeding', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 100,
      window: '10s',
      prefix: PREFIX,
    })

    await rl.block('user1', '5s')

    const result = await rl.limit('user1')
    expect(result.success).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('block expires after duration', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 100,
      window: '10s',
      prefix: PREFIX,
    })

    await rl.block('user2', '1s')

    const denied = await rl.limit('user2')
    expect(denied.success).toBe(false)

    await new Promise((r) => setTimeout(r, 1100))

    const allowed = await rl.limit('user2')
    expect(allowed.success).toBe(true)
  })

  it('block works with token-bucket', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'token-bucket',
      limit: 100,
      refillRate: 10,
      prefix: PREFIX,
    })

    await rl.block('user3', '5s')

    const result = await rl.limit('user3')
    expect(result.success).toBe(false)
  })

  it('block works with sliding-window', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'sliding-window',
      limit: 100,
      window: '10s',
      prefix: PREFIX,
    })

    await rl.block('user4', '5s')

    const result = await rl.limit('user4')
    expect(result.success).toBe(false)
  })

  it('reset clears rate limit state', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 2,
      window: '10s',
      prefix: PREFIX,
    })

    await rl.limit('user5')
    await rl.limit('user5')

    const denied = await rl.limit('user5')
    expect(denied.success).toBe(false)

    await rl.reset('user5')

    const allowed = await rl.limit('user5')
    expect(allowed.success).toBe(true)
  })

  it('reset clears block', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 100,
      window: '10s',
      prefix: PREFIX,
    })

    await rl.block('user6', '1h')

    const denied = await rl.limit('user6')
    expect(denied.success).toBe(false)

    await rl.reset('user6')

    const allowed = await rl.limit('user6')
    expect(allowed.success).toBe(true)
  })

  it('peek returns blocked state', async () => {
    const rl = new Limiter({
      redis,
      algorithm: 'fixed-window',
      limit: 100,
      window: '10s',
      prefix: PREFIX,
    })

    await rl.block('user7', '5s')

    const peek = await rl.peek('user7')
    expect(peek.success).toBe(false)
  })
})
