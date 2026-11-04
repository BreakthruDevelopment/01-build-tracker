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
