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

  it("only the Azure client, the PAT validator and the AI gateway clients call fetch", () => {
    // OpenRouter and OpenCode are AI providers; they never receive Azure credentials.
    expect(filesMatching(/\bfetch\(/)).toEqual([
      "lib/ai/opencode.ts",
      "lib/ai/openrouter.ts",
      "lib/azure/client.ts",
      "lib/solidtime/client.ts",
      "services/azure.service.ts",
    ]);
  });

  it("only the Solidtime action runner writes to Solidtime", () => {
    expect(filesMatching(/\bclient\.(post|put|delete)(<[^>]*>)?\(/)).toEqual(["services/actions/solidtime-actions.ts"]);
  });

  it("only the approve flow runs Solidtime changes", () => {
    expect(filesMatching(/executeSolidtimeAction\(/)).toEqual(["services/actions/action.service.ts", "services/actions/solidtime-actions.ts"]);
  });

  it("Solidtime routes only read (connection settings aside)", () => {
    const routes = files.find((file) => file.path === "routes/solidtime.routes.ts")!.text;
    expect(routes).not.toMatch(/read\.(post|put|patch|delete)\(/);
    // Under a connection, the only other route asks the AI for draft hours; it never reaches Solidtime's write API.
    expect(routes.match(/router\.(post|put|patch|delete)\("\/:credentialId[^"]*"/g)).toEqual(['router.post("/:credentialId/draft/estimate"']);
  });

  it("Azure read routes register GET handlers only", () => {
    const routes = files.find((file) => file.path === "routes/azure.routes.ts")!.text;
    expect(routes).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });
});
