export const CONFIGURATION_ERROR = 'REDLIMIT_INVALID_CONFIG'

export function isConfigurationError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith(`${CONFIGURATION_ERROR} `) ||
    error.message.startsWith(`ERR ${CONFIGURATION_ERROR} `)
  )
}
