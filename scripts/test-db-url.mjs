import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));

/**
 * Tests never touch the dev database: they use TEST_DATABASE_URL, or the
 * dev DATABASE_URL with "_test" appended to the database name.
 */
export function resolveTestDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) {
    return assertTestDatabase(process.env.TEST_DATABASE_URL);
  }

  const env = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  const devUrl = process.env.DATABASE_URL ?? env.DATABASE_URL;

  if (!devUrl) {
    throw new Error("Set TEST_DATABASE_URL or DATABASE_URL to run tests");
  }

  const url = new URL(devUrl);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;

  return assertTestDatabase(url.toString());
}

function assertTestDatabase(value) {
  const name = new URL(value).pathname.replace(/^\//, "");

  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run tests against non-test database "${name}"`);
  }

  return value;
}
