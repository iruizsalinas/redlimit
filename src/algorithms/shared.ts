import type { LuaResult } from '../types.js'

// node-redis 5.x decodes integer replies as `n * 10 + byte - 48`, which rounds
// the intermediate sum for results within ~50 of 2^53. Returning every value as
// a bulk string bypasses client integer parsers, so all replies decode alike.
export const LUA_RESULT = `
local function result(status, remaining, resetMs, nowMs)
  return {
    string.format('%.0f', status),
    string.format('%.0f', remaining),
    string.format('%.0f', resetMs),
    string.format('%.0f', nowMs),
  }
end
`

export function getKeys(
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

const decoder = new TextDecoder()

// Clients may surface bulk strings as bytes (node-redis typeMapping to Buffer).
// Reject anything else rather than let NaN or a coerced 0 reach a result.
function toInteger(value: unknown): number {
  const text = value instanceof Uint8Array ? decoder.decode(value) : value
  const number = typeof text === 'string' && /^-?\d+$/.test(text) ? Number(text)
    : typeof text === 'number' ? text
    : NaN
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Unexpected Redis script reply value: ${String(text)}`)
  }
  return number
}

export function toLuaResult(result: unknown): LuaResult {
  if (!Array.isArray(result) || result.length !== 4) {
    throw new Error('Unexpected Redis script reply: expected an array of four values.')
  }
  return [toInteger(result[0]), toInteger(result[1]), toInteger(result[2]), toInteger(result[3])]
}
