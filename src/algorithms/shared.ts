import type { LuaResult } from '../types.js'

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

export function toLuaResult(result: LuaResult): LuaResult {
  return [Number(result[0]), Number(result[1]), Number(result[2]), Number(result[3])]
}
