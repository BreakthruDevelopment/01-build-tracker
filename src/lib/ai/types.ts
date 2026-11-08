import type { z } from "zod";

export type GenerateRequest<T> = {
  /** Stable name for this AI feature, e.g. "daily-health-summary". Used for demo fixtures and logs. */
  task: string;
  system: string;
  prompt: string;
  /** Output is parsed as JSON and validated; invalid output is an error, never shown raw. */
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
};

export type GenerateResult<T> = {
  data: T;
  provider: string;
  model: string;
  /** True when the answer came from recorded demo data instead of a live model. */
  demo: boolean;
  latencyMs: number;
};

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Returns raw model text, expected to be JSON. */
  complete(req: { system: string; prompt: string; maxOutputTokens: number }): Promise<string>;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: "quota" | "provider" | "invalid_output" | "input_rejected",
    /** HTTP status from the provider, or "timeout"; safe to log (never the response body). */
    readonly status?: number | "timeout",
  ) {
    super(message);
    this.name = "AiError";
  }
}
