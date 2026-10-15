import { createClient as createNodeClient, createCluster as createNodeCluster } from 'redis'
import Redis, { Cluster } from 'ioredis'

export function requireRedisUrl(): string {
  if (process.env.CI !== 'true' || !process.env.REDIS_URL) {
    throw new Error('Integration tests run in CI with an explicit REDIS_URL. Use npm test for local unit tests.')
  }
  return process.env.REDIS_URL
}

export function isCluster(): boolean {
  const topology = process.env.REDIS_TOPOLOGY ?? 'standalone'
  if (topology !== 'standalone' && topology !== 'cluster') throw new Error('REDIS_TOPOLOGY must be standalone or cluster')
  return topology === 'cluster'
}

// Test cleanup deletes keys from many identifiers; a cluster rejects that as CROSSSLOT.
// Limiter keys share one hash tag, so only the suite's bulk cleanup needs splitting.
async function deleteEach(keys: string[], del: (key: string) => Promise<number>): Promise<number> {
  const counts = await Promise.all(keys.map(key => del(key)))
  return counts.reduce((sum, count) => sum + count, 0)
}

// Keep test setup identical for both clients while passing the real client to Limiter.
// REDIS_TOPOLOGY=cluster passes cluster clients so routing and CROSSSLOT checks are exercised.
export function createClient({ socketTimeoutMs = 30_000 } = {}): ReturnType<typeof createNodeClient> {
  const url = requireRedisUrl()
  const client = process.env.REDIS_CLIENT
  const cluster = isCluster()
  if (client === 'redis') {
    const socket = { connectTimeout: 5_000, socketTimeout: socketTimeoutMs, reconnectStrategy: false as const }
    if (!cluster) {
      const redis = createNodeClient({ url, socket })
      redis.on('error', () => {}) // Command/connect rejections are asserted by the suite.
      return redis
    }
    const redis = createNodeCluster({ rootNodes: [{ url }], defaults: { socket } })
    redis.on('error', () => {})
    const del = (...keys: (string | string[])[]) => deleteEach(keys.flat(), key => redis.del(key))
    return new Proxy(redis, {
      get(target, name) {
        if (name === 'del') return del
        const value = Reflect.get(target, name, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as unknown as ReturnType<typeof createNodeClient>
  }
  if (client !== 'ioredis') throw new Error('REDIS_CLIENT must be redis or ioredis')
  // A test deadline does not cancel Redis commands or quit() queued behind them.
  // Close an unresponsive socket so pending commands and teardown can settle.
  const options = { connectTimeout: 5_000, socketTimeout: socketTimeoutMs, retryStrategy: null }
  const redis: Redis | Cluster = cluster
    ? new Cluster([url], { lazyConnect: true, clusterRetryStrategy: () => null, redisOptions: options })
    : new Redis(url, { lazyConnect: true, ...options })
  redis.on('error', () => {})
  const aliases: Record<string, (...args: any[]) => unknown> = {
    scriptFlush: () => redis.script('FLUSH'),
    pTTL: (key: string) => redis.pttl(key),
    zCard: (key: string) => redis.zcard(key),
    zAdd: (key: string, entry: { score: number; value: string }) => redis.zadd(key, entry.score, entry.value),
    del: (...keys: (string | string[])[]) => cluster
      ? deleteEach(keys.flat(), key => redis.del(key))
      : redis.del(...keys.flat()),
    destroy: () => redis.disconnect(),
  }
  return new Proxy(redis, {
    get(target, name) {
      if (typeof name === 'string' && name in aliases) return aliases[name]
      if (name === 'isOpen') return target.status === 'ready'
      const value = Reflect.get(target, name, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as ReturnType<typeof createNodeClient>
}

// Redis owns expiry and algorithm time; local runtime timers only pace polling.
export async function waitForRedisTime(redis: ReturnType<typeof createClient>, durationMs: number): Promise<void> {
  const now = async () => {
    const [seconds, microseconds] = await redis.time()
    return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000)
  }
  const target = await now() + durationMs
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const remaining = target - await now()
    if (remaining <= 0) return
    await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)))
  }
  throw new Error('Redis clock did not advance by ' + durationMs + 'ms')
}
