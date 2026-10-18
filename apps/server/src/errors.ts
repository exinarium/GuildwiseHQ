export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'authentication required') =>
  new HttpError(401, 'unauthenticated', message);
export const forbidden = (message = 'forbidden') => new HttpError(403, 'forbidden', message);
/** Also used for "exists but not yours". */
export const notFound = (message = 'not found', code = 'not_found') => new HttpError(404, code, message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);
/** A route that was removed on purpose; the message says what replaced it. */
export const gone = (code: string, message: string) => new HttpError(410, code, message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);
