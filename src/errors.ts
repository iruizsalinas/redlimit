export const CONFIGURATION_ERROR = 'REDLIMIT_INVALID_CONFIG'

export function isConfigurationError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith(`${CONFIGURATION_ERROR} `) ||
    // GLIDE separates the server error code from its message with a colon.
    error.message.startsWith(`${CONFIGURATION_ERROR}: `) ||
    error.message.startsWith(`ERR ${CONFIGURATION_ERROR} `)
  )
}

// Quote strings so empty or padded values stay visible in error messages.
export function formatValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}
