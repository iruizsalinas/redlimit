import { formatValue } from './errors.js'

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/

export function parseDuration(input: string, name = 'duration'): number {
  const match = typeof input === 'string' ? input.match(DURATION_RE) : null
  if (!match) {
    throw new Error(
      `${name} must be a string such as "500ms", "30s", "5m", or "1h". Received ${formatValue(input)}.`
    )
  }
  const value = parseFloat(match[1])
  const unit = match[2]
  const ms = Math.floor(value * UNITS[unit])
  if (ms <= 0) {
    throw new Error(
      `${name} must be greater than 0. Received ${formatValue(input)}.`
    )
  }
  if (!Number.isSafeInteger(ms)) {
    throw new Error(
      `${name} is too large to represent safely in milliseconds. Received ${formatValue(input)}.`
    )
  }
  return ms
}
