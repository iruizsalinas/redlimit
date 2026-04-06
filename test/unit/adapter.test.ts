import { describe, it, expect, vi } from 'vitest'
import { createAdapter } from '../../src/adapter.js'

describe('createAdapter', () => {
  it('detects node-redis client', () => {
    const client = {
      isOpen: true,
      evalSha: vi.fn().mockResolvedValue([1, 9, 1000]),
      eval: vi.fn().mockResolvedValue([1, 9, 1000]),
      del: vi.fn().mockResolvedValue(1),
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      pTTL: vi.fn().mockResolvedValue(-2),
    }

    const adapter = createAdapter(client)
    expect(adapter).toBeDefined()
    expect(adapter.eval).toBeTypeOf('function')
  })

  it('detects ioredis client', () => {
    const client = {
      status: 'ready',
      evalsha: vi.fn().mockResolvedValue([1, 9, 1000]),
      eval: vi.fn().mockResolvedValue([1, 9, 1000]),
      del: vi.fn().mockResolvedValue(1),
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      pttl: vi.fn().mockResolvedValue(-2),
    }

    const adapter = createAdapter(client)
    expect(adapter).toBeDefined()
    expect(adapter.eval).toBeTypeOf('function')
  })

  it('rejects partial ioredis-like clients missing evalsha', () => {
    expect(() => createAdapter({
      status: 'ready',
      eval: vi.fn(),
      del: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      pttl: vi.fn(),
    })).toThrow('Unsupported Redis client')
  })

  it('throws on null', () => {
    expect(() => createAdapter(null)).toThrow('Invalid Redis client')
  })

  it('throws on undefined', () => {
    expect(() => createAdapter(undefined)).toThrow('Invalid Redis client')
  })

  it('throws on unsupported client', () => {
    expect(() => createAdapter({ foo: 'bar' })).toThrow('Unsupported Redis client')
  })

  it('rejects partial node-redis-like clients missing evalSha', () => {
    expect(() => createAdapter({
      isOpen: true,
      eval: vi.fn(),
      del: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      pTTL: vi.fn(),
    })).toThrow('Unsupported Redis client')
  })

  it('node-redis: tries evalSha first, falls back to eval on NOSCRIPT', async () => {
    const evalShaFn = vi.fn().mockRejectedValue(new Error('NOSCRIPT No matching script'))
    const evalFn = vi.fn().mockResolvedValue([1, 9, 1000])
    const client = {
      isOpen: true,
      evalSha: evalShaFn,
      eval: evalFn,
      del: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      pTTL: vi.fn(),
    }

    const adapter = createAdapter(client)
    await adapter.eval('script', ['key1', 'key2'], ['arg1', 'arg2'])

    expect(evalShaFn).toHaveBeenCalled()
    expect(evalFn).toHaveBeenCalledWith('script', {
      keys: ['key1', 'key2'],
      arguments: ['arg1', 'arg2'],
    })
  })

  it('node-redis: uses evalSha when script is cached', async () => {
    const evalShaFn = vi.fn().mockResolvedValue([1, 9, 1000])
    const evalFn = vi.fn()
    const client = {
      isOpen: true,
      evalSha: evalShaFn,
      eval: evalFn,
      del: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      pTTL: vi.fn(),
    }

    const adapter = createAdapter(client)
    await adapter.eval('script', ['key1', 'key2'], ['arg1', 'arg2'])

    expect(evalShaFn).toHaveBeenCalled()
    expect(evalFn).not.toHaveBeenCalled()
  })

  it('node-redis set uses object PX', async () => {
    const setFn = vi.fn().mockResolvedValue('OK')
    const client = {
      isOpen: true,
      evalSha: vi.fn(),
      eval: vi.fn(),
      del: vi.fn(),
      set: setFn,
      get: vi.fn(),
      pTTL: vi.fn(),
    }

    const adapter = createAdapter(client)
    await adapter.set('key', 'value', 5000)

    expect(setFn).toHaveBeenCalledWith('key', 'value', { PX: 5000 })
  })

  it('node-redis del passes keys as array', async () => {
    const delFn = vi.fn().mockResolvedValue(2)
    const client = {
      isOpen: true,
      evalSha: vi.fn(),
      eval: vi.fn(),
      del: delFn,
      set: vi.fn(),
      get: vi.fn(),
      pTTL: vi.fn(),
    }

    const adapter = createAdapter(client)
    await adapter.del('key1', 'key2')

    expect(delFn).toHaveBeenCalledWith(['key1', 'key2'])
  })

  it('ioredis: tries evalsha first, falls back to eval on NOSCRIPT', async () => {
    const evalshaFn = vi.fn().mockRejectedValue(new Error('NOSCRIPT No matching script'))
    const evalFn = vi.fn().mockResolvedValue([1, 9, 1000])
    const client = {
      status: 'ready',
      evalsha: evalshaFn,
      eval: evalFn,
      del: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      pttl: vi.fn(),
    }

    const adapter = createAdapter(client)
    await adapter.eval('script', ['key1', 'key2'], ['arg1', 'arg2'])

    expect(evalshaFn).toHaveBeenCalled()
    expect(evalFn).toHaveBeenCalledWith('script', 2, 'key1', 'key2', 'arg1', 'arg2')
  })

  it('ioredis: uses evalsha when script is cached', async () => {
    const evalshaFn = vi.fn().mockResolvedValue([1, 9, 1000])
    const evalFn = vi.fn()
    const client = {
      status: 'ready',
      evalsha: evalshaFn,
      eval: evalFn,
      del: vi.fn(),
      set: vi.fn(),
      get: vi.fn(),
      pttl: vi.fn(),
    }

    const adapter = createAdapter(client)
    await adapter.eval('script', ['key1', 'key2'], ['arg1', 'arg2'])

    expect(evalshaFn).toHaveBeenCalled()
    expect(evalFn).not.toHaveBeenCalled()
  })

  it('ioredis set uses positional PX', async () => {
    const setFn = vi.fn().mockResolvedValue('OK')
    const client = {
      status: 'ready',
      evalsha: vi.fn(),
      eval: vi.fn(),
      del: vi.fn(),
      set: setFn,
      get: vi.fn(),
      pttl: vi.fn(),
    }

    const adapter = createAdapter(client)
    await adapter.set('key', 'value', 5000)

    expect(setFn).toHaveBeenCalledWith('key', 'value', 'PX', 5000)
  })

  it('ioredis del uses variadic args', async () => {
    const delFn = vi.fn().mockResolvedValue(2)
    const client = {
      status: 'ready',
      evalsha: vi.fn(),
      eval: vi.fn(),
      del: delFn,
      set: vi.fn(),
      get: vi.fn(),
      pttl: vi.fn(),
    }

    const adapter = createAdapter(client)
    await adapter.del('key1', 'key2')

    expect(delFn).toHaveBeenCalledWith('key1', 'key2')
  })
})
