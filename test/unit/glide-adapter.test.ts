import { describe, it, expect, vi } from 'vitest'
import { createAdapter } from '../../src/adapter.js'

// GLIDE's native module is unavailable on Windows. Keep unit tests portable;
// the integration matrix exercises real standalone and cluster GLIDE clients.
const { scripts } = vi.hoisted(() => ({ scripts: [] as { code: string; release: ReturnType<typeof vi.fn> }[] }))
vi.mock('@valkey/valkey-glide', () => ({
  Script: class {
    release = vi.fn()
    constructor(public code: string) { scripts.push(this) }
  },
  TimeUnit: { Milliseconds: 'PX' },
}))

function client() {
  return {
    invokeScript: vi.fn().mockResolvedValue([1, 2, 3000, 1000]),
    del: vi.fn().mockResolvedValue(2),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn(),
  }
}

describe('GLIDE adapter', () => {
  let releaseScripts: () => void

  it('passes keys and arguments to invokeScript and registers shutdown cleanup', async () => {
    const redis = client()
    const once = vi.spyOn(process, 'once')
    const result = await createAdapter(redis).eval('return ARGV[1]', ['rl:{user}'], ['42'])
    const cleanup = once.mock.calls.find(([event]) => event === 'exit')
    once.mockRestore()
    expect(cleanup).toBeDefined()
    releaseScripts = cleanup![1] as () => void
    const script = scripts.at(-1)!
    expect(script.code).toBe('return ARGV[1]')
    expect(redis.invokeScript).toHaveBeenCalledWith(script, { keys: ['rl:{user}'], args: ['42'] })
    expect(result).toEqual([1, 2, 3000, 1000])
    expect(script.release).not.toHaveBeenCalled()
  })

  it('reuses one script across concurrent calls and independent clients', async () => {
    const first = client()
    const second = client()
    const count = scripts.length
    const script = 'return ARGV[1] + 1'
    await Promise.all([
      createAdapter(first).eval(script, ['first'], ['1']),
      createAdapter(first).eval(script, ['second'], ['2']),
      createAdapter(second).eval(script, ['third'], ['3']),
    ])
    expect(scripts.length).toBe(count + 1)
    const lua = scripts.at(-1)!
    expect(first.invokeScript).toHaveBeenNthCalledWith(1, lua, { keys: ['first'], args: ['1'] })
    expect(first.invokeScript).toHaveBeenNthCalledWith(2, lua, { keys: ['second'], args: ['2'] })
    expect(second.invokeScript).toHaveBeenCalledWith(lua, { keys: ['third'], args: ['3'] })
    expect(lua.release).not.toHaveBeenCalled()
  })

  it('keeps different script sources separate', async () => {
    const redis = client()
    const adapter = createAdapter(redis)
    await adapter.eval('return 2', ['key'], [])
    await adapter.eval('return 3', ['key'], [])
    expect(redis.invokeScript.mock.calls[0][0]).not.toBe(redis.invokeScript.mock.calls[1][0])
  })

  it('keeps a cached script alive while execution is pending and after it settles', async () => {
    const redis = client()
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    redis.invokeScript.mockImplementation(() => pending)
    const result = createAdapter(redis).eval('return 1', ['key'], [])
    await vi.waitFor(() => expect(redis.invokeScript).toHaveBeenCalledOnce())
    const script = scripts.at(-1)!
    expect(script.release).not.toHaveBeenCalled()
    finish(1)
    expect(await result).toBe(1)
    expect(script.release).not.toHaveBeenCalled()
  })

  it('propagates errors and reuses the script on the next call', async () => {
    const redis = client()
    const error = new Error('connection closed')
    redis.invokeScript.mockRejectedValue(error)
    const adapter = createAdapter(redis)
    await expect(adapter.eval('return 4', ['key'], [])).rejects.toBe(error)
    const script = scripts.at(-1)!
    redis.invokeScript.mockResolvedValue([1, 2, 3000, 1000])
    await adapter.eval('return 4', ['key'], [])
    expect(redis.invokeScript).toHaveBeenNthCalledWith(2, script, { keys: ['key'], args: [] })
    expect(script.release).not.toHaveBeenCalled()
  })

  it('uses an array for del and millisecond expiry for set', async () => {
    const redis = client()
    const adapter = createAdapter(redis)
    expect(await adapter.del('key1', 'key2')).toBe(2)
    expect(redis.del).toHaveBeenCalledWith(['key1', 'key2'])
    await adapter.set('key', 'value', 5000)
    expect(redis.set).toHaveBeenCalledWith('key', 'value', { expiry: { type: 'PX', count: 5000 } })
  })

  it('rejects incomplete GLIDE-like clients', () => {
    expect(() => createAdapter({ invokeScript: vi.fn(), del: vi.fn(), set: vi.fn() })).toThrow('redis must be')
  })

  it('releases cached native scripts once at process exit', () => {
    for (const script of scripts) expect(script.release).not.toHaveBeenCalled()
    process.removeListener('exit', releaseScripts)
    releaseScripts()
    for (const script of scripts) expect(script.release).toHaveBeenCalledOnce()
    releaseScripts()
    for (const script of scripts) expect(script.release).toHaveBeenCalledOnce()
  })
})
