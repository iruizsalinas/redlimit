import { createHash } from 'node:crypto'
import type { RedisAdapter } from './types.js'

const shaCache = new Map<string, string>()

function scriptSha(script: string): string {
  const cached = shaCache.get(script)
  if (cached) return cached
  const sha = createHash('sha1').update(script).digest('hex')
  shaCache.set(script, sha)
  return sha
}

function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('NOSCRIPT')
}

function isIoRedis(client: any): boolean {
  return (
    typeof client.status === 'string' &&
    typeof client.evalsha === 'function' &&
    typeof client.eval === 'function' &&
    typeof client.del === 'function' &&
    typeof client.set === 'function' &&
    typeof client.get === 'function'
  )
}

function isNodeRedis(client: any): boolean {
  return (
    typeof client.evalSha === 'function' &&
    typeof client.eval === 'function' &&
    typeof client.del === 'function' &&
    typeof client.set === 'function' &&
    typeof client.get === 'function'
  )
}

function createIoRedisAdapter(c: any): RedisAdapter {
  return {
    async eval(script, keys, args) {
      const sha = scriptSha(script)
      try {
        return await c.evalsha(sha, keys.length, ...keys, ...args)
      } catch (err) {
        if (isNoScriptError(err)) {
          return c.eval(script, keys.length, ...keys, ...args)
        }
        throw err
      }
    },
    async del(...keys) {
      return c.del(...keys)
    },
    async set(key, value, px) {
      await c.set(key, value, 'PX', px)
    },
    async get(key) {
      return c.get(key)
    },
    async pttl(key) {
      return c.pttl(key)
    },
  }
}

function createNodeRedisAdapter(c: any): RedisAdapter {
  return {
    async eval(script, keys, args) {
      const sha = scriptSha(script)
      try {
        return await c.evalSha(sha, { keys, arguments: args })
      } catch (err) {
        if (isNoScriptError(err)) {
          return c.eval(script, { keys, arguments: args })
        }
        throw err
      }
    },
    async del(...keys) {
      return c.del(keys)
    },
    async set(key, value, px) {
      await c.set(key, value, { PX: px })
    },
    async get(key) {
      return c.get(key)
    },
    async pttl(key) {
      return (c.pTTL ?? c.pttl).call(c, key)
    },
  }
}

export function createAdapter(client: unknown): RedisAdapter {
  if (!client || typeof client !== 'object') {
    throw new Error(
      'Invalid Redis client. Pass an ioredis or node-redis (redis@5+) client.'
    )
  }

  if (isIoRedis(client)) {
    return createIoRedisAdapter(client)
  }

  if (isNodeRedis(client)) {
    return createNodeRedisAdapter(client)
  }

  throw new Error(
    'Unsupported Redis client. Pass an ioredis or node-redis (redis@5+) client.'
  )
}
