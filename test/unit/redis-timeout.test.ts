import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '../support/redis.js'

afterEach(() => vi.unstubAllEnvs())

describe('integration client socket deadlines', () => {
  it.each(['redis', 'ioredis'])('%s rejects an in-flight command when the server stops replying', async client => {
    let respond = true
    const sockets = new Set<Socket>()
    // Minimal RESP server: accept real client initialization, then stop replying.
    const server = createServer(socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let pending = ''
      socket.on('data', data => {
        pending += data.toString()
        while (pending) {
          const countEnd = pending.indexOf('\r\n')
          if (countEnd < 0) return
          const count = Number(pending.slice(1, countEnd))
          const args = []
          let offset = countEnd + 2
          for (let i = 0; i < count; i++) {
            const end = pending.indexOf('\r\n', offset)
            if (end < 0) return
            const length = Number(pending.slice(offset + 1, end))
            if (pending.length < end + 2 + length + 2) return
            args.push(pending.slice(end + 2, end + 2 + length))
            offset = end + 2 + length + 2
          }
          pending = pending.slice(offset)
          if (!respond) continue
          if (args[0].toUpperCase() === 'INFO') {
            const info = 'redis_version:5.0.14\r\nloading:0\r\n'
            socket.write(`$${info.length}\r\n${info}\r\n`)
          } else socket.write(args[0].toUpperCase() === 'PING' ? '+PONG\r\n' : '+OK\r\n')
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    vi.stubEnv('CI', 'true')
    vi.stubEnv('REDIS_CLIENT', client)
    vi.stubEnv('REDIS_URL', `redis://127.0.0.1:${address.port}`)
    const redis = createClient({ socketTimeoutMs: 1_000 })
    try {
      await redis.connect()
      expect(await redis.ping()).toBe('PONG')
      respond = false
      await expect(redis.ping()).rejects.toThrow(/closed|timeout/i)
      expect(redis.isOpen).toBe(false)
    } finally {
      if (redis.isOpen) redis.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
