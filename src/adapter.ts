import { createHash } from 'node:crypto'
import type { RedisAdapter } from './types.js'
import type { GlideClient, Script } from '@valkey/valkey-glide'

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
  // iovalkey uses the same command signatures and connection status as ioredis.
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

function isGlide(client: any): client is GlideClient {
  return (
    typeof client.invokeScript === 'function' &&
    typeof client.del === 'function' &&
    typeof client.set === 'function' &&
    typeof client.get === 'function'
  )
}

// GLIDE has native bindings. Load them only when a GLIDE adapter needs them.
let glideModule: Promise<typeof import('@valkey/valkey-glide')> | undefined
const glideScripts = new Map<string, Script>()
function loadGlide() {
  return glideModule ??= import('@valkey/valkey-glide')
}

async function glideScript(script: string): Promise<Script> {
  const { Script } = await loadGlide()
  const cached = glideScripts.get(script)
  if (cached) return cached

  const lua = new Script(script)
  if (glideScripts.size === 0) {
    // Keep the fixed algorithm scripts alive for reuse across all clients.
    // GLIDE requires explicit release of native Script objects when done.
    process.once('exit', () => {
      for (const script of glideScripts.values()) script.release()
      glideScripts.clear()
    })
  }
  glideScripts.set(script, lua)
  return lua
}

function createGlideAdapter(c: GlideClient): RedisAdapter {
  return {
    async eval(script, keys, args) {
      const lua = await glideScript(script)
      // GLIDE handles script loading, NOSCRIPT recovery and key-based routing.
      return c.invokeScript(lua, { keys, args })
    },
    async del(...keys) {
      return c.del(keys)
    },
    async set(key, value, px) {
      const { TimeUnit } = await loadGlide()
      await c.set(key, value, { expiry: { type: TimeUnit.Milliseconds, count: px } })
    },
  }
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
  }
}

const UNSUPPORTED_CLIENT = 'redis must be an ioredis client or a node-redis client (version 5 or later), an iovalkey client, or a Valkey GLIDE client.'

export function createAdapter(client: unknown): RedisAdapter {
  if (!client || typeof client !== 'object') {
    throw new Error(UNSUPPORTED_CLIENT)
  }

  if (isIoRedis(client)) {
    return createIoRedisAdapter(client)
  }

  if (isNodeRedis(client)) {
    return createNodeRedisAdapter(client)
  }

  if (isGlide(client)) {
    return createGlideAdapter(client)
  }

  throw new Error(UNSUPPORTED_CLIENT)
}
