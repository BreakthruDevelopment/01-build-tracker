/** Typed domain errors. `errorResponse` maps `status` straight to the HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

/** The request is well formed but the current state forbids it (for example an illegal status move). */
export class ConflictError extends HttpError {
  constructor(message = "That change isn't allowed from the current state.") {
    super(409, message);
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

/** A machine endpoint whose secret isn't set. Always closed, never open. */
export class NotConfiguredError extends HttpError {
  constructor() {
    super(503, "not configured");
  }
}

export class UnauthorizedTokenError extends HttpError {
  constructor() {
    super(401, "Unauthorized");
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(limit: number) {
    super(413, `Body too large (limit ${limit} bytes)`);
  }
}

/** Too soon to repeat this action (for example regenerating a summary). */
export class TooManyRequestsError extends HttpError {
  constructor(message = "Too many requests") {
    super(429, message);
  }
}
