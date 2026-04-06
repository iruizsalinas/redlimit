import type { AlgorithmHandler, LuaResult } from '../types.js'
import { getKeys, toLuaResult } from './shared.js'

const LIMIT_SCRIPT = `

local baseKey     = KEYS[1]
local blockedKey  = KEYS[2]
local banHistKey  = KEYS[3]
local limit       = tonumber(ARGV[1])
local cost        = tonumber(ARGV[2])
local windowMs    = tonumber(ARGV[3])
local numSteps    = tonumber(ARGV[4])
local historyMs   = tonumber(ARGV[5])

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local pttl = redis.call('PTTL', blockedKey)
if pttl > 0 then
  return {-1, 0, now + pttl, now}
end

local windowId          = math.floor(now / windowMs)
local windowStart       = windowId * windowMs
local percentageElapsed = (now - windowStart) / windowMs
local currentKey        = baseKey .. ':' .. windowId
local previousKey       = baseKey .. ':' .. (windowId - 1)
local counts            = redis.call('MGET', currentKey, previousKey)
local currentCount      = tonumber(counts[1] or '0')
local previousCount     = tonumber(counts[2] or '0')

local weightedCount = previousCount * (1 - percentageElapsed) + currentCount

if weightedCount + cost > limit then
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

  local low = now
  local high = now + windowMs * 2
  while low < high do
    local mid = math.floor((low + high) / 2)
    local midWinId = math.floor(mid / windowMs)
    local p, c
    if midWinId == windowId then
      p = previousCount
      c = currentCount
    elseif midWinId == windowId + 1 then
      p = currentCount
      c = 0
    else
      p = 0
      c = 0
    end
    local e = (mid - midWinId * windowMs) / windowMs
    if p * (1 - e) + c + cost <= limit then
      high = mid
    else
      low = mid + 1
    end
  end

  return {0, math.max(0, math.floor(limit - weightedCount)), low, now}
end

local newVal = redis.call('INCRBY', currentKey, cost)

if newVal == cost then
  redis.call('PEXPIRE', currentKey, windowMs * 2 + 1000)
end

local newWeightedCount = previousCount * (1 - percentageElapsed) + newVal
return {1, math.max(0, math.floor(limit - newWeightedCount)), (windowId + 1) * windowMs, now}
`

const PEEK_SCRIPT = `

local baseKey     = KEYS[1]
local blockedKey  = KEYS[2]
local limit       = tonumber(ARGV[1])
local windowMs    = tonumber(ARGV[2])

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local pttl = redis.call('PTTL', blockedKey)
if pttl > 0 then
  return {0, 0, now + pttl, now}
end

local windowId          = math.floor(now / windowMs)
local windowStart       = windowId * windowMs
local percentageElapsed = (now - windowStart) / windowMs
local currentKey        = baseKey .. ':' .. windowId
local previousKey       = baseKey .. ':' .. (windowId - 1)
local counts            = redis.call('MGET', currentKey, previousKey)
local currentCount      = tonumber(counts[1] or '0')
local previousCount     = tonumber(counts[2] or '0')

local weightedCount = previousCount * (1 - percentageElapsed) + currentCount

if weightedCount + 1 > limit then
  local low = now
  local high = now + windowMs * 2
  while low < high do
    local mid = math.floor((low + high) / 2)
    local midWinId = math.floor(mid / windowMs)
    local p, c
    if midWinId == windowId then
      p = previousCount
      c = currentCount
    elseif midWinId == windowId + 1 then
      p = currentCount
      c = 0
    else
      p = 0
      c = 0
    end
    local e = (mid - midWinId * windowMs) / windowMs
    if p * (1 - e) + c + 1 <= limit then
      high = mid
    else
      low = mid + 1
    end
  end
  return {0, math.max(0, math.floor(limit - weightedCount)), low, now}
end

return {1, math.max(0, math.floor(limit - weightedCount)), (windowId + 1) * windowMs, now}
`

const RESET_SCRIPT = `

local baseKey     = KEYS[1]
local blockedKey  = KEYS[2]
local banHistKey  = KEYS[3]
local windowMs    = tonumber(ARGV[1])
local clearHist   = tonumber(ARGV[2])

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

export const slidingWindow: AlgorithmHandler = {
  async limit(adapter, prefix, banPrefix, identifier, maxLimit, windowMs, _refillRate, cost, banArgs) {
    const keys = getKeys(prefix, banPrefix, identifier, banArgs !== null)
    const args = [
      String(maxLimit),
      String(cost),
      String(windowMs),
      ...(banArgs ?? ['0', '0']),
    ]
    return toLuaResult(await adapter.eval(LIMIT_SCRIPT, keys, args) as LuaResult)
  },

  async peek(adapter, prefix, banPrefix, identifier, maxLimit, windowMs, _refillRate) {
    const keys = getKeys(prefix, banPrefix, identifier, false)
    const args = [String(maxLimit), String(windowMs)]
    return toLuaResult(await adapter.eval(PEEK_SCRIPT, keys, args) as LuaResult)
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
