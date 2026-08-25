import type { Context } from "@hono/hono";
import {
  type ErrorCode,
  errorEnvelopeSchema,
  type PublicErrorDetails,
} from "@relay/contracts";

export type HttpErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 503;

export interface HttpAdapterErrorOptions {
  readonly status: HttpErrorStatus;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: PublicErrorDetails;
}

/** A transport-safe failure. Its message and details are safe to return verbatim. */
export class HttpAdapterError extends Error {
  override readonly name = "HttpAdapterError";
  readonly status: HttpErrorStatus;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly details: PublicErrorDetails;

  constructor(options: HttpAdapterErrorOptions) {
    super(options.message);
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details ?? {};
  }
}

export function invalidRequest(
  details: PublicErrorDetails = {},
  status: 400 | 413 | 415 | 422 = 400,
): HttpAdapterError {
  return new HttpAdapterError({
    status,
    code: "invalid_request",
    message: status === 413
      ? "The request body is too large."
      : status === 415
      ? "The request content type is not supported."
      : "The request is invalid.",
    details,
  });
}

export function authenticationRequired(): HttpAdapterError {
  return new HttpAdapterError({
    status: 401,
    code: "authentication_required",
    message: "Authentication is required.",
  });
}

export function reauthenticationRequired(): HttpAdapterError {
  return new HttpAdapterError({
    status: 401,
    code: "reauthentication_required",
    message: "Recent authentication is required.",
  });
}

export function authorizationDenied(): HttpAdapterError {
  return new HttpAdapterError({
    status: 403,
    code: "authorization_denied",
    message: "You are not authorized to perform this action.",
  });
}

export function idempotencyConflict(): HttpAdapterError {
  return new HttpAdapterError({
    status: 409,
    code: "idempotency_conflict",
    message: "The idempotency key was already used for a different request.",
  });
}

export function notFound(
  details: PublicErrorDetails = {},
): HttpAdapterError {
  return new HttpAdapterError({
    status: 404,
    code: "not_found",
    message: "The requested resource was not found.",
    details,
  });
}

export function internalError(): HttpAdapterError {
  return new HttpAdapterError({
    status: 500,
    code: "internal_error",
    message: "An unexpected error occurred.",
  });
}

export function errorResponse(
  context: Context,
  error: unknown,
  requestId: string,
): Response {
  const problem = error instanceof HttpAdapterError ? error : internalError();
  const envelope = errorEnvelopeSchema.parse({
    error: {
      code: problem.code,
      message: problem.message,
      retryable: problem.retryable,
      ...(problem.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: problem.retryAfterSeconds }),
      requestId,
      details: problem.details,
    },
  });
  if (problem.retryAfterSeconds !== undefined) {
    context.header("retry-after", String(problem.retryAfterSeconds));
  }
  return context.json(envelope, problem.status);
}
