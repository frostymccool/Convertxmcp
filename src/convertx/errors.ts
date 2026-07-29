/**
 * Error types surfaced to MCP clients. Messages are written for an agent that
 * must decide what to do next, so each one states the cause and the fix.
 */

export class ConvertXError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** ConvertX rejected our session; credentials or instance auth mode are wrong. */
export class AuthError extends ConvertXError {}

/** The instance could not be reached at all. */
export class ConnectionError extends ConvertXError {}

/** A conversion job failed, or produced no output. */
export class ConversionError extends ConvertXError {}

/** A conversion did not finish inside the configured budget. */
export class TimeoutError extends ConvertXError {}

/** The caller asked for something ConvertX cannot do (bad format, missing file). */
export class RequestError extends ConvertXError {}

export function describeError(error: unknown): string {
  if (error instanceof ConvertXError) return error.message;
  if (error instanceof Error) {
    // Node surfaces connection problems as opaque `fetch failed` with the real
    // reason on `cause`; unwrap it so the agent sees something actionable.
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return `${error.message}: ${cause.message}`;
    }
    return error.message;
  }
  return String(error);
}
