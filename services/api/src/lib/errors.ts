export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const tooManyRequests = (message = 'Too many requests, slow down') =>
  new AppError(429, 'RATE_LIMITED', message);

/** Thrown by stores when a conditional write fails. Services translate it into domain errors. */
export class ConditionFailedError extends Error {
  constructor(readonly reason: string) {
    super(`Condition failed: ${reason}`);
    this.name = 'ConditionFailedError';
  }
}
