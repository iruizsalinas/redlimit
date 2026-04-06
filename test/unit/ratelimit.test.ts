import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Limiter } from '../../src/ratelimit.js'

function mockRedis() {
  const defaultResult = [1, 9, Date.now() + 30000, Date.now()]
  return {
    isOpen: true,
    evalSha: vi.fn().mockResolvedValue(defaultResult),
    eval: vi.fn().mockResolvedValue(defaultResult),
    del: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    pTTL: vi.fn().mockResolvedValue(-2),
  }
}

function mockFixedWindowRedisWithServerTime(serverNow: number) {
  const counters = new Map<string, number>()

  const handler = async (_scriptOrSha: string, opts: { keys: string[], arguments: string[] }) => {
    const keys = opts.keys
    const args = opts.arguments

    const baseKey = keys[0]
    const limit = Number(args[0])
    const cost = Number(args[1])
    const windowMs = Number(args[2])
    const windowId = Math.floor(serverNow / windowMs)
    const counterKey = `${baseKey}:${windowId}`
    const current = counters.get(counterKey) ?? 0
    const resetMs = (windowId + 1) * windowMs

    if (current + cost > limit) {
      return [0, Math.max(0, limit - current), resetMs, serverNow]
    }

    const next = current + cost
    counters.set(counterKey, next)
    return [1, Math.max(0, limit - next), resetMs, serverNow]
  }

  return {
    isOpen: true,
    evalSha: vi.fn(handler),
    eval: vi.fn(handler),
    del: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    pTTL: vi.fn().mockResolvedValue(-2),
  }
}

describe('Limiter', () => {
  let redis: ReturnType<typeof mockRedis>

  beforeEach(() => {
    redis = mockRedis()
  })

  describe('constructor', () => {
    it('creates with fixed-window config', () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      expect(rl).toBeInstanceOf(Limiter)
    })

    it('creates with sliding-window config', () => {
      const rl = new Limiter({
        redis,
        algorithm: 'sliding-window',
        limit: 10,
        window: '1m',
      })
      expect(rl).toBeInstanceOf(Limiter)
    })

    it('creates with token-bucket config', () => {
      const rl = new Limiter({
        redis,
        algorithm: 'token-bucket',
        limit: 100,
        refillRate: 1.67,
      })
      expect(rl).toBeInstanceOf(Limiter)
    })

    it('throws on limit <= 0', () => {
      expect(() => new Limiter({ redis, algorithm: 'fixed-window', limit: 0, window: '30s' }))
        .toThrow('limit must be a positive integer')
      expect(() => new Limiter({ redis, algorithm: 'fixed-window', limit: -5, window: '30s' }))
        .toThrow('limit must be a positive integer')
    })

    it('throws on non-finite limit', () => {
      expect(() => new Limiter({ redis, algorithm: 'fixed-window', limit: Infinity, window: '30s' }))
        .toThrow('limit must be a positive integer')
      expect(() => new Limiter({ redis, algorithm: 'fixed-window', limit: NaN, window: '30s' }))
        .toThrow('limit must be a positive integer')
    })

    it('throws on fractional limit', () => {
      expect(() => new Limiter({ redis, algorithm: 'fixed-window', limit: 1.5, window: '30s' }))
        .toThrow('limit must be a positive integer')
    })

    it('throws on refillRate <= 0', () => {
      expect(() => new Limiter({ redis, algorithm: 'token-bucket', limit: 10, refillRate: 0 }))
        .toThrow('refillRate must be a positive number')
      expect(() => new Limiter({ redis, algorithm: 'token-bucket', limit: 10, refillRate: -1 }))
        .toThrow('refillRate must be a positive number')
    })

    it('throws on window "0s"', () => {
      expect(() => new Limiter({ redis, algorithm: 'fixed-window', limit: 10, window: '0s' }))
        .toThrow('duration must be greater than 0')
    })

    it('throws on unsupported algorithm', () => {
      expect(() => new Limiter({
        redis,
        algorithm: 'not-real',
        limit: 10,
        window: '30s',
      } as any)).toThrow('Unsupported algorithm')
    })

    it('throws when window config is missing at runtime', () => {
      expect(() => new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
      } as any)).toThrow('window is required')
    })

    it('throws on invalid fail mode', () => {
      expect(() => new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        fail: 'sometimes',
      } as any)).toThrow('fail must be "open" or "closed"')
    })

    it('uses default prefix "rl"', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await rl.limit('test')
      const evalCall = redis.evalSha.mock.calls[0]
      const keys = evalCall[1].keys
      expect(keys).toEqual([
        'rl:{test}',
        'rl:{test}:blocked',
      ])
    })

    it('uses custom prefix', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        prefix: 'api',
      })
      await rl.limit('test')
      const evalCall = redis.evalSha.mock.calls[0]
      const keys = evalCall[1].keys
      expect(keys).toEqual([
        'api:{test}',
        'api:{test}:blocked',
      ])
    })

    it('includes the ban history key only when ban escalation is enabled', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        ban: {
          escalation: ['1m'],
          history: '1h',
        },
      })

      await rl.limit('test')

      const evalCall = redis.evalSha.mock.calls[0]
      const keys = evalCall[1].keys
      expect(keys).toEqual([
        'rl:{test}',
        'rl:{test}:blocked',
        'rl:{test}:banhist',
      ])
    })

    it('rejects prefixes with Redis hash-tag braces', () => {
      expect(() => new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        prefix: 'api{cluster}',
      })).toThrow('prefix must not contain "{" or "}"')
    })

    it('rejects shared ban prefixes with Redis hash-tag braces', () => {
      expect(() => new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        ban: {
          escalation: ['1m'],
          history: '1h',
          shared: 'shared{cluster}',
        },
      })).toThrow('ban.shared must not contain "{" or "}"')
    })

    it('rejects identifiers with Redis hash-tag braces', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })

      await expect(rl.limit('user{1}')).rejects.toThrow('identifier must not contain "{" or "}"')
      await expect(rl.peek('user}1')).rejects.toThrow('identifier must not contain "{" or "}"')
      await expect(rl.reset('{user1')).rejects.toThrow('identifier must not contain "{" or "}"')
    })

  })

  describe('limit', () => {
    it('returns result with all fields', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      const result = await rl.limit('user_123')

      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('remaining')
      expect(result).toHaveProperty('reset')
      expect(result).toHaveProperty('limit', 10)
      expect(result).toHaveProperty('headers')
      expect(result.headers).toHaveProperty('RateLimit-Limit')
      expect(result.headers).toHaveProperty('RateLimit-Remaining')
      expect(result.headers).toHaveProperty('RateLimit-Reset')
    })

    it('returns success when allowed', async () => {
      redis.evalSha.mockResolvedValue([1, 9, Date.now() + 30000, Date.now()])
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      const result = await rl.limit('user_123')
      expect(result.success).toBe(true)
      expect(result.remaining).toBe(9)
    })

    it('returns failure when denied', async () => {
      redis.evalSha.mockResolvedValue([0, 0, Date.now() + 30000, Date.now()])
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      const result = await rl.limit('user_123')
      expect(result.success).toBe(false)
      expect(result.remaining).toBe(0)
    })

    it('throws when cost exceeds limit', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await expect(rl.limit('user_123', { cost: 11 })).rejects.toThrow(
        'cost (11) exceeds limit (10)'
      )
    })

    it('throws when cost is 0', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await expect(rl.limit('user_123', { cost: 0 })).rejects.toThrow(
        'cost must be a positive integer'
      )
    })

    it('throws when cost is negative', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await expect(rl.limit('user_123', { cost: -1 })).rejects.toThrow(
        'cost must be a positive integer'
      )
    })

    it('throws when cost is NaN', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await expect(rl.limit('user_123', { cost: NaN })).rejects.toThrow(
        'cost must be a positive integer'
      )
    })

    it('throws when cost is Infinity', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await expect(rl.limit('user_123', { cost: Infinity })).rejects.toThrow(
        'cost must be a positive integer'
      )
    })

    it('throws when cost is fractional', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await expect(rl.limit('user_123', { cost: 1.5 })).rejects.toThrow(
        'cost must be a positive integer'
      )
    })

    it('fail: closed throws on redis error', async () => {
      redis.evalSha.mockRejectedValue(new Error('connection refused'))
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        fail: 'closed',
      })
      await expect(rl.limit('user_123')).rejects.toThrow('connection refused')
    })

    it('fail: open returns success on redis error', async () => {
      redis.evalSha.mockRejectedValue(new Error('connection refused'))
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        fail: 'open',
      })
      const result = await rl.limit('user_123')
      expect(result.success).toBe(true)
      expect(result.remaining).toBe(10)
    })

    it('applies deny-and-ban atomically in a single eval under fail: open mode', async () => {
      const nowMs = Date.now()
      const resetMs = nowMs + 30_000
      redis.evalSha.mockResolvedValue([0, 0, resetMs, nowMs])

      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        fail: 'open',
        ban: {
          escalation: ['1m'],
          history: '1h',
        },
      })

      const result = await rl.limit('user_123')

      expect(result.success).toBe(false)
      expect(result.remaining).toBe(0)
      expect(result.headers['Retry-After']).toBeDefined()
      expect(redis.evalSha).toHaveBeenCalledTimes(1)
    })

    it('applies deny-and-ban atomically in a single eval under fail: closed mode', async () => {
      const nowMs = Date.now()
      const resetMs = nowMs + 30_000
      redis.evalSha.mockResolvedValue([0, 0, resetMs, nowMs])

      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        fail: 'closed',
        ban: {
          escalation: ['1m'],
          history: '1h',
        },
      })

      const result = await rl.limit('user_123')
      expect(result.success).toBe(false)
      expect(result.remaining).toBe(0)
      expect(redis.evalSha).toHaveBeenCalledTimes(1)
    })

    it('does not run ban escalation again when the identifier is already blocked', async () => {
      const nowMs = Date.now()
      const resetMs = nowMs + 5_000
      redis.evalSha.mockResolvedValue([-1, 0, resetMs, nowMs])

      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        ban: {
          escalation: ['1m'],
          history: '1h',
        },
      })

      const result = await rl.limit('user_123')

      expect(result.success).toBe(false)
      expect(redis.evalSha).toHaveBeenCalledTimes(1)
    })
  })

  describe('peek', () => {
    it('returns state without consuming', async () => {
      redis.evalSha.mockResolvedValue([1, 10, Date.now() + 30000, Date.now()])
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      const result = await rl.peek('user_123')
      expect(result.success).toBe(true)
      expect(result.remaining).toBe(10)
    })

    it('does not split fixed-window counters when app time drifts', async () => {
      const skewedRedis = mockFixedWindowRedisWithServerTime(500)
      const rl = new Limiter({
        redis: skewedRedis,
        algorithm: 'fixed-window',
        limit: 1,
        window: '1s',
      })

      const nowSpy = vi.spyOn(Date, 'now')
      try {
        nowSpy.mockReturnValue(500)
        const first = await rl.limit('user_123')
        nowSpy.mockReturnValue(1500)
        const second = await rl.limit('user_123')

        expect(first.success).toBe(true)
        expect(second.success).toBe(false)
      } finally {
        nowSpy.mockRestore()
      }
    })
  })

  describe('reset', () => {
    it('evaluates a reset script for window algorithms', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await rl.reset('user_123')
      expect(redis.evalSha).toHaveBeenCalled()
    })

    it('clears window state and ban history in a single eval when ban is enabled', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
        ban: {
          escalation: ['1m'],
          history: '1h',
        },
      })

      await rl.reset('user_123')

      expect(redis.evalSha).toHaveBeenCalledTimes(1)
      expect(redis.del).not.toHaveBeenCalled()
    })

    it('deletes keys for token bucket', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'token-bucket',
        limit: 100,
        refillRate: 1.67,
      })
      await rl.reset('user_123')
      expect(redis.del).toHaveBeenCalled()
    })

    it('deletes token-bucket state and ban history in a single del when ban is enabled', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'token-bucket',
        limit: 100,
        refillRate: 1.67,
        ban: {
          escalation: ['1m'],
          history: '1h',
        },
      })

      await rl.reset('user_123')

      expect(redis.del).toHaveBeenCalledTimes(1)
      expect(redis.del).toHaveBeenCalledWith([
        'rl:{user_123}',
        'rl:{user_123}:blocked',
        'rl:{user_123}:banhist',
      ])
    })
  })

  describe('block', () => {
    it('sets a blocked key with TTL', async () => {
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      await rl.block('user_123', '1h')
      expect(redis.set).toHaveBeenCalledWith(
        'rl:{user_123}:blocked',
        '1',
        { PX: 3_600_000 }
      )
    })
  })

  describe('headers', () => {
    it('produces RFC-compliant headers', async () => {
      const nowMs = Date.now()
      const resetMs = nowMs + 30000
      redis.evalSha.mockResolvedValue([1, 7, resetMs, nowMs])
      const rl = new Limiter({
        redis,
        algorithm: 'fixed-window',
        limit: 10,
        window: '30s',
      })
      const result = await rl.limit('user_123')

      expect(result.headers['RateLimit-Limit']).toBe('10')
      expect(result.headers['RateLimit-Remaining']).toBe('7')
      expect(Number(result.headers['RateLimit-Reset'])).toBeGreaterThanOrEqual(0)
    })
  })
})

function mockIoRedis() {
  const defaultResult = [1, 9, Date.now() + 30000, Date.now()]
  const handler = async (_sha: string, _numKeys: number, ...rest: string[]) => defaultResult
  return {
    status: 'ready',
    evalsha: vi.fn(handler),
    eval: vi.fn(handler),
    del: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    pttl: vi.fn().mockResolvedValue(-2),
  }
}

describe('Limiter with ioredis', () => {
  it('creates with all algorithm types', () => {
    const redis = mockIoRedis()
    expect(new Limiter({ redis, algorithm: 'fixed-window', limit: 10, window: '30s' })).toBeInstanceOf(Limiter)
    expect(new Limiter({ redis, algorithm: 'sliding-window', limit: 10, window: '1m' })).toBeInstanceOf(Limiter)
    expect(new Limiter({ redis, algorithm: 'token-bucket', limit: 100, refillRate: 1.67 })).toBeInstanceOf(Limiter)
  })

  it('limit returns result', async () => {
    const redis = mockIoRedis()
    const rl = new Limiter({ redis, algorithm: 'fixed-window', limit: 10, window: '30s' })
    const result = await rl.limit('user_123')

    expect(result.success).toBe(true)
    expect(result.remaining).toBe(9)
    expect(result.limit).toBe(10)
    expect(result.headers).toBeDefined()
  })

  it('fail: open returns success on redis error', async () => {
    const redis = mockIoRedis()
    redis.evalsha.mockRejectedValue(new Error('connection refused'))
    const rl = new Limiter({ redis, algorithm: 'fixed-window', limit: 10, window: '30s', fail: 'open' })
    const result = await rl.limit('user_123')

    expect(result.success).toBe(true)
    expect(result.remaining).toBe(10)
  })

  it('block sets key with positional PX', async () => {
    const redis = mockIoRedis()
    const rl = new Limiter({ redis, algorithm: 'fixed-window', limit: 10, window: '30s' })
    await rl.block('user_123', '1h')

    expect(redis.set).toHaveBeenCalledWith('rl:{user_123}:blocked', '1', 'PX', 3_600_000)
  })

  it('reset deletes keys with variadic args for token bucket', async () => {
    const redis = mockIoRedis()
    const rl = new Limiter({ redis, algorithm: 'token-bucket', limit: 100, refillRate: 1.67 })
    await rl.reset('user_123')

    expect(redis.del).toHaveBeenCalledWith(
      'rl:{user_123}',
      'rl:{user_123}:blocked',
    )
  })
})
