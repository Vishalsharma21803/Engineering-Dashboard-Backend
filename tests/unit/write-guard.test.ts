import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guarantees behind "no write without approval": Azure writes and
 * approval tickets are confined to the executor; raw fetch to the client.
 */
const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return name === "generated" ? [] : sourceFiles(path);
    }

    return path.endsWith(".ts") ? [path] : [];
  });
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: stripComments(readFileSync(path, "utf8")),
}));

function filesMatching(pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(file.text)).map((file) => file.path).sort();
}

describe("write guard", () => {
  it("only the executor issues approval tickets", () => {
    expect(filesMatching(/ApprovalTicket\.issue\(/)).toEqual(["services/actions/executor.ts"]);
  });

  it("only the executor calls AzureClient.write", () => {
    expect(filesMatching(/\.write(<[^>]*>)?\(/)).toEqual(["services/actions/executor.ts"]);
  });

  it("only the approve flow runs the executor", () => {
    expect(filesMatching(/executeAction\(/)).toEqual([
      "services/actions/action.service.ts",
      "services/actions/executor.ts",
    ]);
  });

  it("only the Azure client and the existing PAT validator call fetch", () => {
    expect(filesMatching(/\bfetch\(/)).toEqual(["lib/azure/client.ts", "services/azure.service.ts"]);
  });

  it("Azure read routes register GET handlers only", () => {
    const routes = files.find((file) => file.path === "routes/azure.routes.ts")!.text;
    expect(routes).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });
});
