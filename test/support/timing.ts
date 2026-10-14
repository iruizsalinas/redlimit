import { waitForRedisTime, type createClient } from './redis.js'

type Client = ReturnType<typeof createClient>

export async function redisNowMs(redis: Client): Promise<number> {
  const [seconds, microseconds] = await redis.time()
  return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000)
}

// Only retry an invalid timing setup. Callers assert the returned results outside
// these helpers, so a failure observed in a valid window is never retried.
export async function inRedisWindow<T>(redis: Client, windowMs: number, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await redisNowMs(redis)
    const result = await run()
    const after = await redisNowMs(redis)
    if (Math.floor(before / windowMs) === Math.floor(after / windowMs)) return result
  }
  throw new Error(`Could not complete the test within one ${windowMs}ms Redis window after 3 attempts`)
}

export async function acrossRedisBoundary<T, U>(
  redis: Client,
  windowMs: number,
  fill: () => Promise<T>,
  probe: () => Promise<U>,
): Promise<{ filled: T; probed: U }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = await redisNowMs(redis)
    const phase = now % windowMs
    const start = now - phase + (phase >= windowMs * 0.875 ? windowMs : 0)
    const fillAt = start + Math.ceil(windowMs * 0.75)
    if (fillAt > now) await waitForRedisTime(redis, fillAt - now)

    const beforeFill = await redisNowMs(redis)
    const filled = await fill()
    const afterFill = await redisNowMs(redis)
    if (beforeFill < fillAt || afterFill >= start + windowMs) continue

    const probeAt = start + windowMs + Math.ceil(windowMs * 0.05)
    if (probeAt > afterFill) await waitForRedisTime(redis, probeAt - afterFill)
    const beforeProbe = await redisNowMs(redis)
    const probed = await probe()
    const afterProbe = await redisNowMs(redis)
    if (beforeProbe >= probeAt && afterProbe < start + windowMs * 1.2) return { filled, probed }
  }
  throw new Error(`Could not observe adjacent ${windowMs}ms Redis windows after 3 attempts`)
}
