const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new Error(
      `Invalid duration: "${String(input)}". Expected format: "30s", "5m", "1h", etc.`
    )
  }

  const match = input.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/)
  if (!match) {
    throw new Error(
      `Invalid duration: "${input}". Expected format: "30s", "5m", "1h", etc.`
    )
  }
  const value = parseFloat(match[1])
  const unit = match[2]
  const ms = Math.floor(value * UNITS[unit])
  if (ms <= 0) {
    throw new Error(
      `duration must be greater than 0. Got: "${input}"`
    )
  }
  return ms
}
