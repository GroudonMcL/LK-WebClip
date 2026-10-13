import { ConnectionError, LegendKeeperError } from '@legendkeeper/sdk'

/** A message the user can act on, rather than a generic "import failed". */
export function describeError(error: unknown): string {
  if (error instanceof ConnectionError) return `LegendKeeper could not be reached: ${error.message}`
  if (!(error instanceof LegendKeeperError)) return error instanceof Error ? error.message : String(error)

  const ref = error.requestId ? ` (request ${error.requestId})` : ''
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return `The API key was rejected. It may have been revoked or mistyped; create a new one in Project Settings → Developers.${ref}`
    case 'FORBIDDEN':
      return `The API key's role cannot do this here. Creating top-level pages needs an ADMIN key, and a MEMBER key needs edit access to the page.${ref}`
    case 'PAID_PLAN_REQUIRED':
    case 'SUBSCRIPTION_LAPSED':
      return `The project owner's LegendKeeper plan does not allow API writes.${ref}`
    case 'VERSION_MISMATCH':
      return `The page changed while the clip was being saved. Nothing was overwritten; try again.${ref}`
    case 'NOT_FOUND':
      return `A page this clip needs no longer exists in LegendKeeper (it may have been deleted or moved to the trash). The page list is being reloaded; choose again.${ref}`
    case 'DOCUMENT_TOO_LARGE':
      return `The page is at LegendKeeper's size limit. Clip into a new page instead.${ref}`
    case 'KIND_MISMATCH':
      return `That tab is not a text page (it may be a map, board or timeline).${ref}`
    case 'STORAGE_QUOTA_EXCEEDED':
      return `The project owner's storage quota is full, so the image could not be uploaded.${ref}`
    case 'RATE_LIMITED':
    case 'UPLOAD_RATE_EXCEEDED':
      return `LegendKeeper's rate limit was reached. Wait a minute and try again.${ref}`
    case 'VALIDATION_ERROR':
    case 'INVALID_CONTENT': {
      const issues = (error.errors ?? []).map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      return `LegendKeeper refused the content: ${issues || error.message}${ref}`
    }
    default:
      return `${error.status} ${error.code ?? ''} ${error.message}${ref}`.replace(/\s+/g, ' ')
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof LegendKeeperError && error.code === 'NOT_FOUND'
}
