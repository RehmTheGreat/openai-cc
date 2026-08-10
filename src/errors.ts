export class OpenAICCError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenAICCError";
  }
}

export function conflict(message: string, code = "conflict", details?: unknown): OpenAICCError {
  return new OpenAICCError(message, 409, code, details);
}

export function notFound(message: string, code = "not_found"): OpenAICCError {
  return new OpenAICCError(message, 404, code);
}

export function unprocessable(message: string, code = "unprocessable", details?: unknown): OpenAICCError {
  return new OpenAICCError(message, 422, code, details);
}
