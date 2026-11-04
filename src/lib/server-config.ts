/**
 * Settings the server cannot run safely without, checked once at startup so a
 * misconfiguration fails the deploy instead of surfacing as per-request 500s.
 */
import { parseSignupAllowList } from "./signup-policy.js";

const MIN_JWT_SECRET_LENGTH = 32;

/** Secure by default: only an explicit NODE_ENV=development or test relaxes the production rules. */
export function isProduction(): boolean {
  return process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test";
}

/** For the startup log line: which rules apply and why. */
export function describeMode(): string {
  return `Mode: ${isProduction() ? "production" : process.env.NODE_ENV} (NODE_ENV=${process.env.NODE_ENV || "unset"})`;
}

export function assertServerConfig(): void {
  const problems: string[] = [];
  const jwtSecret = process.env.JWT_SECRET ?? "";
  const signup = parseSignupAllowList(process.env.SIGNUP_ALLOWED_EMAILS);

  if (signup.invalid.length > 0) {
    problems.push(`SIGNUP_ALLOWED_EMAILS has entries that are neither an email address nor *@domain: ${signup.invalid.join(", ")}`);
  }

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

  if (isProduction()) {
    if (!signup.list) console.log("Sign-up is closed (SIGNUP_ALLOWED_EMAILS not set): only SOP owners can create accounts.");
    return;
  }

  console.warn(
    [
      "",
      "************************************************************************",
      `WARNING: ${describeMode()}. Production safeguards are relaxed:`,
      "  - the sign-in cookie is not marked Secure",
      signup.list ? null : "  - anyone can sign up (SIGNUP_ALLOWED_EMAILS is not set)",
      "  - Solidtime may be reached over http://localhost",
      "Do not expose this server through a tunnel or proxy. Use `npm run build && npm start`.",
      "************************************************************************",
      "",
    ]
      .filter((line) => line !== null)
      .join("\n")
  );
}
