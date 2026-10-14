import { afterEach, describe, expect, it, vi } from 'vitest'
import { acrossRedisBoundary, inRedisWindow } from '../support/timing.js'
import type { createClient } from '../support/redis.js'

type Client = ReturnType<typeof createClient>

function clockClient(): Client {
  return { time: async () => [String(Math.floor(Date.now() / 1000)), String(Date.now() % 1000 * 1000)] } as unknown as Client
}

afterEach(() => vi.useRealTimers())

describe('Redis timing preconditions', () => {
  it('discards a batch that crossed a boundary and returns the next complete batch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(29_999)
    const run = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 2)
      return run.mock.calls.length === 1 ? 200 : 100
    })
    expect(await inRedisWindow(clockClient(), 30_000, run)).toBe(100)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not retry an operation error', async () => {
    const run = vi.fn(async () => { throw new Error('Redis command failed') })
    await expect(inRedisWindow(clockClient(), 30_000, run)).rejects.toThrow('Redis command failed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('returns an incorrect quota in a valid window for the caller to reject', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const run = vi.fn(async () => 200)
    expect(await inRedisWindow(clockClient(), 30_000, run)).toBe(200)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('fails after three invalid windows instead of retrying indefinitely', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const run = vi.fn(async () => { vi.setSystemTime(Date.now() + 30_000) })
    await expect(inRedisWindow(clockClient(), 30_000, run)).rejects.toThrow('after 3 attempts')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('rejects a matching phase in the wrong window after a scheduler pause', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const fill = vi.fn(async () => Date.now())
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 1) await new Promise(resolve => setTimeout(resolve, 4_000))
      return Date.now()
    })
    const result = acrossRedisBoundary(clockClient(), 2_000, fill, probe)
    await vi.runAllTimersAsync()
    const { filled, probed } = await result
    expect(fill).toHaveBeenCalledTimes(2)
    expect(Math.floor(probed / 2_000)).toBe(Math.floor(filled / 2_000) + 1)
    expect(probed % 2_000).toBeGreaterThanOrEqual(100)
    expect(probed % 2_000).toBeLessThan(400)
  })

  it('returns a bad result in adjacent windows without retrying it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const fill = vi.fn(async () => 'filled')
    const probe = vi.fn(async () => ({ success: true }))
    const result = acrossRedisBoundary(clockClient(), 2_000, fill, probe)
    await vi.runAllTimersAsync()
    expect((await result).probed.success).toBe(true)
    expect(fill).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('bounds retries when the scheduler always misses the adjacent window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const probe = vi.fn(async () => { vi.setSystemTime(Date.now() + 4_000) })
    const rejection = expect(acrossRedisBoundary(clockClient(), 2_000, async () => {}, probe))
      .rejects.toThrow('after 3 attempts')
    await vi.runAllTimersAsync()
    await rejection
    expect(probe).toHaveBeenCalledTimes(3)
  })
})
