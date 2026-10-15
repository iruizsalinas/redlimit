import { CONFIGURATION_ERROR } from '../errors.js'
import type { AlgorithmHandler, LuaResult } from '../types.js'
import { getKeys, LUA_RESULT, toLuaResult } from './shared.js'

const LIMIT_SCRIPT = `
${LUA_RESULT}

local key        = KEYS[1]
local blockedKey = KEYS[2]
local banHistKey = KEYS[3]
local maxTokens  = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost       = tonumber(ARGV[3])
local numSteps   = tonumber(ARGV[4])
local historyMs  = tonumber(ARGV[5])

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local ttlMs = math.ceil(maxTokens / refillRate * 1000) + 1000
if now > 9007199254740991 - ttlMs then
  return redis.error_reply('${CONFIGURATION_ERROR} refill is too slow for this limit. Reset times would be too far in the future to represent safely in milliseconds.')
end

local pttl = redis.call('PTTL', blockedKey)
if pttl > 0 then
  return result(-1, 0, now + pttl, now)
end

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts     = tonumber(bucket[2])

if tokens == nil then
  tokens = maxTokens
  ts     = now
end

local elapsedMs  = math.max(0, now - ts)
local tokensToAdd = elapsedMs * refillRate / 1000

tokens = math.min(maxTokens, tokens + tokensToAdd)
ts     = now

if tokens < cost then
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

    return result(0, 0, now + banMs, now)
  end

  local deficit  = cost - tokens
  local waitMs   = math.ceil(deficit / refillRate * 1000)
  local resetMs  = now + waitMs

  -- Keep the last consumption as the refill origin. Rejected requests consume
  -- nothing; the existing TTL already outlasts the time needed to refill fully.
  return result(0, math.floor(tokens), resetMs, now)
end

tokens = tokens - cost

-- Lua 5.1 tostring() uses too few significant digits to round-trip balances.
redis.call('HSET', key, 'tokens', string.format('%.17g', tokens), 'ts', string.format('%.0f', ts))
redis.call('PEXPIRE', key, ttlMs)

local deficit = maxTokens - tokens
local resetMs = now + math.ceil(deficit / refillRate * 1000)

return result(1, math.floor(tokens), resetMs, now)
`

const PEEK_SCRIPT = `
${LUA_RESULT}

local key        = KEYS[1]
local blockedKey = KEYS[2]
local maxTokens  = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local ttlMs = math.ceil(maxTokens / refillRate * 1000) + 1000
if now > 9007199254740991 - ttlMs then
  return redis.error_reply('${CONFIGURATION_ERROR} refill is too slow for this limit. Reset times would be too far in the future to represent safely in milliseconds.')
end

local pttl = redis.call('PTTL', blockedKey)
if pttl > 0 then
  return result(0, 0, now + pttl, now)
end

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts     = tonumber(bucket[2])

if tokens == nil then
  return result(1, maxTokens, now, now)
end

local elapsedMs   = math.max(0, now - ts)
local tokensToAdd = elapsedMs * refillRate / 1000
tokens = math.min(maxTokens, tokens + tokensToAdd)

if tokens < 1 then
  local deficit = 1 - tokens
  local waitMs  = math.ceil(deficit / refillRate * 1000)
  return result(0, math.floor(tokens), now + waitMs, now)
end

local deficit = maxTokens - tokens
local resetMs = now + math.ceil(deficit / refillRate * 1000)
return result(1, math.floor(tokens), resetMs, now)
`

export const tokenBucket: AlgorithmHandler = {
  async limit(adapter, prefix, banPrefix, identifier, maxLimit, _windowMs, refillRate, cost, banArgs) {
    const keys = getKeys(prefix, banPrefix, identifier, banArgs !== null)
    const args = [
      String(maxLimit),
      String(refillRate),
      String(cost),
      ...(banArgs ?? ['0', '0']),
    ]
    return toLuaResult(await adapter.eval(LIMIT_SCRIPT, keys, args) as LuaResult)
  },

  async peek(adapter, prefix, banPrefix, identifier, maxLimit, _windowMs, refillRate) {
    const keys = getKeys(prefix, banPrefix, identifier, false)
    const args = [String(maxLimit), String(refillRate)]
    return toLuaResult(await adapter.eval(PEEK_SCRIPT, keys, args) as LuaResult)
  },

  async reset(adapter, prefix, banPrefix, identifier, _windowMs, clearBanHistory) {
    const keys = [
      `${prefix}:{${identifier}}`,
      `${banPrefix}:{${identifier}}:blocked`,
      ...(clearBanHistory ? [`${banPrefix}:{${identifier}}:banhist`] : []),
    ]
    await adapter.del(...keys)
  },
}
