// Domain errors thrown by the repositories. Endpoints translate them to HTTP
// codes with `toHttpError(e)` at the end of the handler.

export class RepoError extends Error {
  constructor(message: string, public readonly httpStatus: number) {
    super(message)
    this.name = 'RepoError'
  }
}

export class NotFoundError extends RepoError {
  constructor(what: string) {
    super(`${what} not found`, 404)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends RepoError {
  constructor(message: string) {
    super(message, 409)
    this.name = 'ConflictError'
  }
}

export class DuplicateError extends ConflictError {
  constructor(what: string) {
    super(`${what} already exists`)
    this.name = 'DuplicateError'
  }
}

export class LastAdminError extends ConflictError {
  constructor(message = 'Workspace must have at least one admin — promote someone else first, or delete the workspace.') {
    super(message)
    this.name = 'LastAdminError'
  }
}

/**
 * Translate a RepoError to an H3 createError call. Endpoints use this at
 * the top level so the handler body can call repo functions without
 * wrapping every call in try/catch.
 */
export function isRepoError(e: unknown): e is RepoError {
  return e instanceof RepoError
}
