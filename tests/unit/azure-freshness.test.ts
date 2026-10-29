import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { AzureClient } from "../../src/lib/azure/client.js";
import { forgetMyWorkSnapshots, getMyWorkSnapshotForTests, rememberMyWork } from "../../src/services/work-item-list/my-work.service.js";
import { server } from "../setup.js";

function countingAzure() {
  const calls: string[] = [];
  server.use(
    http.get("https://dev.azure.com/org/*", ({ request }) => {
      calls.push(new URL(request.url).pathname);
      return HttpResponse.json({ value: calls.length });
    })
  );
  return calls;
}

describe("withFreshData", () => {
  it("re-reads ticket data but keeps long-lived metadata cached", async () => {
    const calls = countingAzure();
    const client = new AzureClient({ credentialId: "fresh-test", organizationUrl: "https://dev.azure.com/org", patToken: "token" });

    await client.get(["_apis", "data"]);
    await client.get(["_apis", "metadata"], { cacheTtlMs: 10 * 60_000 });
    expect(calls).toHaveLength(2);

    // The normal client answers both from the cache.
    await client.get(["_apis", "data"]);
    await client.get(["_apis", "metadata"], { cacheTtlMs: 10 * 60_000 });
    expect(calls).toHaveLength(2);

    // The fresh one reads the data again, not the metadata.
    const fresh = client.withFreshData();
    await fresh.get(["_apis", "data"]);
    await fresh.get(["_apis", "metadata"], { cacheTtlMs: 10 * 60_000 });
    expect(calls).toEqual(["/org/_apis/data", "/org/_apis/metadata", "/org/_apis/data"]);
  });
});

describe("forgetting My work snapshots", () => {
  const remember = (userId: string, credentialId: string) => rememberMyWork(userId, credentialId, undefined, { workItems: [], compliance: [], recommendations: [] });

  it("forgets one organization, all of a user's, or everyone's", () => {
    remember("u1", "c1");
    remember("u1", "c2");
    remember("u2", "c1");

    forgetMyWorkSnapshots("u1", "c1");
    expect([getMyWorkSnapshotForTests("u1", "c1"), getMyWorkSnapshotForTests("u1", "c2"), getMyWorkSnapshotForTests("u2", "c1")].map(Boolean)).toEqual([false, true, true]);

    forgetMyWorkSnapshots("u1");
    expect([getMyWorkSnapshotForTests("u1", "c2"), getMyWorkSnapshotForTests("u2", "c1")].map(Boolean)).toEqual([false, true]);

    forgetMyWorkSnapshots();
    expect(getMyWorkSnapshotForTests("u2", "c1")).toBeUndefined();
  });

  it("does not keep a list read before a forget", () => {
    const readStartedAt = Date.now() - 1_000;
    forgetMyWorkSnapshots("u3");
    rememberMyWork("u3", "c1", undefined, { workItems: [], compliance: [], recommendations: [] }, readStartedAt);
    expect(getMyWorkSnapshotForTests("u3", "c1")).toBeUndefined();
  });
});
