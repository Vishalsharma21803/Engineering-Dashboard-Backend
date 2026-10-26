/**
 * Settings the server cannot run safely without, checked once at startup so a
 * misconfiguration fails the deploy instead of surfacing as per-request 500s.
 */
const MIN_JWT_SECRET_LENGTH = 32;

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function assertServerConfig(): void {
  const problems: string[] = [];
  const jwtSecret = process.env.JWT_SECRET ?? "";

  if (!jwtSecret) {
    problems.push("JWT_SECRET is not set");
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    const message = `JWT_SECRET should be at least ${MIN_JWT_SECRET_LENGTH} characters (random)`;

    if (isProduction()) {
      problems.push(message);
    } else {
      console.warn(`Warning: ${message}.`);
    }
  }

  if (isProduction() && !process.env.FRONTEND_ORIGIN) {
    problems.push("FRONTEND_ORIGIN must be set in production (the browser origin allowed by CORS)");
  }

  if (problems.length > 0) {
    throw new Error(`Server configuration is invalid:\n- ${problems.join("\n- ")}`);
  }
}
