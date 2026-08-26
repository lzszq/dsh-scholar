import type { ScholarAgentModelFailureCode } from '@dsh-scholar/research-schemas'

/** Closed internal error vocabulary for the authenticated Scholar bridge. */
export class ScholarAgentError extends Error {
  constructor(readonly code: ScholarAgentModelFailureCode, message: string = code) {
    super(message)
    this.name = 'ScholarAgentError'
  }
}

export function isScholarAgentError(error: unknown): error is ScholarAgentError {
  return error instanceof ScholarAgentError
}
