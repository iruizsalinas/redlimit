import type { AlgorithmHandler, LuaResult } from '../types.js'

const LIMIT_SCRIPT = `

local baseKey    = KEYS[1]
local blockedKey = KEYS[2]
local banHistKey = KEYS[3]
local limit      = tonumber(ARGV[1])
local cost       = tonumber(ARGV[2])
local windowMs   = tonumber(ARGV[3])
local numSteps   = tonumber(ARGV[4])
local historyMs  = tonumber(ARGV[5])

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local pttl = redis.call('PTTL', blockedKey)
if pttl > 0 then
  return {-1, 0, now + pttl, now}
end

local windowId = math.floor(now / windowMs)
local resetMs  = (windowId + 1) * windowMs
local counterKey = baseKey .. ':' .. windowId
local current = tonumber(redis.call('GET', counterKey) or '0')

if current + cost > limit then
  if numSteps > 0 then
    local trimResult = redis.pcall('ZREMRANGEBYSCORE', banHistKey, '-inf', now - historyMs)
    if type(trimResult) == 'table' and trimResult.err then
      redis.call('DEL', banHistKey)
    end

    local recentBans = redis.call('ZCARD', banHistKey)
    local stepIdx    = math.min(recentBans, numSteps - 1)
    local banMs      = tonumber(ARGV[6 + stepIdx])

    redis.call('SET', blockedKey, '1', 'PX', banMs)
    redis.call('ZADD', banHistKey, now, t[1] .. '-' .. t[2])
    redis.call('PEXPIRE', banHistKey, historyMs)

    return {0, 0, now + banMs, now}
  end

  return {0, math.max(0, limit - current), resetMs, now}
end

local newVal = redis.call('INCRBY', counterKey, cost)

if newVal == cost then
  redis.call('PEXPIRE', counterKey, windowMs)
end

return {1, math.max(0, limit - newVal), resetMs, now}
`

const PEEK_SCRIPT = `

local baseKey    = KEYS[1]
local blockedKey = KEYS[2]
local limit      = tonumber(ARGV[1])
local windowMs   = tonumber(ARGV[2])

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local pttl = redis.call('PTTL', blockedKey)
if pttl > 0 then
  return {0, 0, now + pttl, now}
end

local windowId = math.floor(now / windowMs)
local resetMs  = (windowId + 1) * windowMs
local counterKey = baseKey .. ':' .. windowId
local current = tonumber(redis.call('GET', counterKey) or '0')

if current >= limit then
  return {0, 0, resetMs, now}
end

return {1, limit - current, resetMs, now}
`

const RESET_SCRIPT = `

local baseKey    = KEYS[1]
local blockedKey = KEYS[2]
local banHistKey = KEYS[3]
local windowMs   = tonumber(ARGV[1])
local clearHist  = tonumber(ARGV[2])

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local windowId = math.floor(now / windowMs)

if clearHist == 1 then
  return redis.call(
    'DEL',
    baseKey .. ':' .. windowId,
    baseKey .. ':' .. (windowId - 1),
    blockedKey,
    banHistKey
  )
end

return redis.call(
  'DEL',
  baseKey .. ':' .. windowId,
  baseKey .. ':' .. (windowId - 1),
  blockedKey
)
`

function getKeys(
  prefix: string,
  banPrefix: string,
  identifier: string,
  includeBanHistory: boolean,
) {
  return [
    `${prefix}:{${identifier}}`,
    `${banPrefix}:{${identifier}}:blocked`,
    ...(includeBanHistory ? [`${banPrefix}:{${identifier}}:banhist`] : []),
  ]
}

export const fixedWindow: AlgorithmHandler = {
  async limit(adapter, prefix, banPrefix, identifier, maxLimit, windowMs, _refillRate, cost, banArgs) {
    const keys = getKeys(prefix, banPrefix, identifier, banArgs !== null)
    const args = [
      String(maxLimit),
      String(cost),
      String(windowMs),
      ...(banArgs ?? ['0', '0']),
    ]
    const result = await adapter.eval(LIMIT_SCRIPT, keys, args) as LuaResult
    return [Number(result[0]), Number(result[1]), Number(result[2]), Number(result[3])]
  },

  async peek(adapter, prefix, banPrefix, identifier, maxLimit, windowMs, _refillRate) {
    const keys = getKeys(prefix, banPrefix, identifier, false)
    const args = [String(maxLimit), String(windowMs)]
    const result = await adapter.eval(PEEK_SCRIPT, keys, args) as LuaResult
    return [Number(result[0]), Number(result[1]), Number(result[2]), Number(result[3])]
  },

  async reset(adapter, prefix, banPrefix, identifier, windowMs, clearBanHistory) {
    const keys = [
      `${prefix}:{${identifier}}`,
      `${banPrefix}:{${identifier}}:blocked`,
      ...(clearBanHistory ? [`${banPrefix}:{${identifier}}:banhist`] : []),
    ]
    await adapter.eval(RESET_SCRIPT, keys, [String(windowMs), clearBanHistory ? '1' : '0'])
  },
}
