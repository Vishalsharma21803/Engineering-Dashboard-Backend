import { describe, expect, it } from "vitest";

import { AzureClient } from "../../src/lib/azure/client.js";
import { getCapabilities } from "../../src/services/azure/capabilities.service.js";
import { getIdentity } from "../../src/services/azure/identity.service.js";
import { listProjects } from "../../src/services/azure/projects.service.js";
import { listAssignedWorkItems } from "../../src/services/azure/work-items.service.js";
import { getDashboard } from "../../src/services/dashboard.service.js";

/**
 * Read-only checks against a real organization, skipped unless
 * AZURE_LIVE_ORG_URL and AZURE_LIVE_PAT are set. Writes are only ever
 * made through the approval API, never from this suite.
 */
const orgUrl = process.env.AZURE_LIVE_ORG_URL;
const pat = process.env.AZURE_LIVE_PAT;

function client() {
  return new AzureClient({
    credentialId: "live",
    organizationUrl: orgUrl ?? "",
    patToken: pat ?? "",
    refresh: true,
  });
}

describe.skipIf(!orgUrl || !pat)("live Azure DevOps (read-only)", () => {
  it("resolves the PAT identity", async () => {
    const identity = await getIdentity(client());
    expect(identity.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("lists accessible projects", async () => {
    const { projects } = await listProjects(client());
    expect(Array.isArray(projects)).toBe(true);
  });

  it("probes scopes", async () => {
    const capabilities = await getCapabilities(client(), { work: "unknown", build: "unknown" });
    console.info("Live PAT scopes:", capabilities.scopes);
    expect(capabilities.scopes.project).not.toBe("unknown");
  });

  it("lists assigned work items", async () => {
    const workItems = await listAssignedWorkItems(client(), { scope: "open" });
    for (const item of workItems) {
      expect(item.stateCategory).not.toBe("Completed");
    }
  });

  it("builds the dashboard", async () => {
    const dashboard = await getDashboard(client(), undefined);
    console.info(
      "Live dashboard sections:",
      Object.fromEntries(Object.entries(dashboard.sections).map(([key, section]) => [key, section.status]))
    );
    expect(dashboard.identity.id).toBeTruthy();
  });
});
