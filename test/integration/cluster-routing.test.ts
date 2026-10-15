import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient as createNodeClient } from 'redis'
import { Limiter } from '../../src/ratelimit.js'
import { createClient, isCluster, requireRedisUrl } from '../support/redis.js'

if (isCluster()) {
  describe('Redis Cluster routing across masters', () => {
    let redis: ReturnType<typeof createClient>
    let admin: ReturnType<typeof createNodeClient>
    let masters: ReturnType<typeof createNodeClient>[]
    let identifiers: string[]

    beforeAll(async () => {
      redis = createClient()
      admin = createNodeClient({ url: requireRedisUrl(), socket: { reconnectStrategy: false } })
      admin.on('error', () => {})
      await Promise.all([redis.connect(), admin.connect()])
      const slots = await admin.sendCommand(['CLUSTER', 'SLOTS']) as [number, number, [string, number, ...unknown[]]][]
      const addresses = [...new Set(slots.map(([, , master]) => `${master[0]}:${master[1]}`))]
      expect(addresses.length).toBe(Number(process.env.REDIS_CLUSTER_MASTERS ?? 1))
      masters = addresses.map(address => {
        const client = createNodeClient({ url: `redis://${address}`, socket: { reconnectStrategy: false } })
        client.on('error', () => {})
        return client
      })
      await Promise.all(masters.map(client => client.connect()))

      // Pick an identifier on every master rather than relying on accidental
      // distribution. Non-keyed admin commands stay on the seed connection.
      const selected = new Map<string, string>()
      for (let i = 0; selected.size < addresses.length && i < 1000; i++) {
        const id = `routing-${i}`
        const slot = Number(await admin.sendCommand(['CLUSTER', 'KEYSLOT', `test:{${id}}`]))
        const owner = slots.find(([start, end]) => slot >= start && slot <= end)![2]
        selected.set(`${owner[0]}:${owner[1]}`, id)
      }
      expect(selected.size).toBe(addresses.length)
      identifiers = [...selected.values()]
    })

    afterAll(async () => {
      await Promise.all([redis, admin, ...(masters ?? [])].filter(client => client?.isOpen).map(client => client.quit()))
    })

    it.each(['fixed-window', 'sliding-window', 'token-bucket'] as const)(
      '%s routes consumption, script recovery, bans and reset to every master', async algorithm => {
        const prefix = `test-routing-${algorithm}`
        const limiter = new Limiter({
          redis, algorithm, prefix, limit: 3, window: '1h',
          refill: { amount: 1, interval: '1h' },
        })
        const banning = new Limiter({
          redis, algorithm, prefix: `${prefix}-ban`, limit: 1, window: '1h',
          refill: { amount: 1, interval: '1h' },
          ban: { escalation: ['1m'], history: '1h', shared: prefix },
        })
        try {
          for (const id of identifiers) {
            await limiter.reset(id)
            await banning.reset(id)
            const results = await Promise.all(Array.from({ length: 32 }, () => limiter.limit(id)))
            expect(results.filter(result => result.success)).toHaveLength(3)
            expect((await limiter.peek(id)).success).toBe(false)
            await limiter.reset(id)
            expect((await limiter.limit(id)).remaining).toBe(2)
          }
          // Flush every master; SCRIPT FLUSH sent through a cluster client alone
          // need not reach the node that owns a particular identifier.
          await Promise.all(masters.map(client => client.scriptFlush()))
          for (const id of identifiers) {
            expect((await limiter.limit(id)).remaining).toBe(1)
            expect((await banning.limit(id)).success).toBe(true)
            expect((await banning.limit(id)).success).toBe(false)
            expect((await limiter.peek(id)).success).toBe(false)
            await banning.reset(id)
            expect((await limiter.peek(id)).success).toBe(true)
            await limiter.block(id, '1m')
            expect((await banning.peek(id)).success).toBe(false)
          }
        } finally {
          for (const id of identifiers) {
            await limiter.reset(id)
            await banning.reset(id)
          }
        }
      },
    )
  })
}
