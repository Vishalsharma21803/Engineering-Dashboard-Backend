/** Request-level failure with a stable machine-readable reason. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}
