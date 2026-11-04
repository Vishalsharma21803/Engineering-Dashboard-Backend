import { describe, expect, it } from "vitest";

import { parseArtifactLink, pullRequestArtifactUri } from "../../src/lib/azure/artifact-links.js";
import { htmlToText, textToHtml } from "../../src/lib/html-to-text.js";
import { workingDaysBetween } from "../../src/lib/working-days.js";
import { computePayloadHash } from "../../src/services/actions/action.service.js";
import { buildTimelineFromRecords } from "../../src/services/azure/pipelines.service.js";
import { countUnresolvedThreads } from "../../src/services/azure/pull-requests.service.js";
import { readWorkItemComments, readWorkItemUpdates, toWorkItemSummary } from "../../src/services/azure/work-items.service.js";
import type { AzureClient } from "../../src/lib/azure/client.js";
import type { RawWorkItem } from "../../src/lib/azure/azure-api.types.js";

describe("htmlToText", () => {
  it("strips markup, scripts and decodes entities", () => {
    expect(
      htmlToText("<p>Use <b>JWT</b> &amp; cookies</p><script>alert(1)</script><ul><li>one</li><li>two</li></ul>")
    ).toBe("Use JWT & cookies\n- one\n- two");
  });

  it("returns empty text for empty input", () => {
    expect(htmlToText(null)).toBe("");
  });

  it("escapes text before sending it to Azure as HTML", () => {
    expect(textToHtml('<img src=x onerror="a">\nline')).toBe(
      "&lt;img src=x onerror=&quot;a&quot;&gt;<br>line"
    );
  });
});

describe("parseArtifactLink", () => {
  it("parses pull request, commit, branch and build links", () => {
    expect(parseArtifactLink("vstfs:///Git/PullRequestId/p1%2Fr1%2F42")).toEqual({
      kind: "pullRequest",
      projectId: "p1",
      repositoryId: "r1",
      pullRequestId: 42,
    });
    expect(parseArtifactLink("vstfs:///Git/Commit/p1%2fr1%2fabc")).toEqual({
      kind: "commit",
      projectId: "p1",
      repositoryId: "r1",
      commitId: "abc",
    });
    expect(parseArtifactLink("vstfs:///Git/Ref/p1%2Fr1%2FGBfeature%2Fx")).toEqual({
      kind: "branch",
      projectId: "p1",
      repositoryId: "r1",
      refName: "feature/x",
    });
    expect(parseArtifactLink("vstfs:///Build/Build/77")).toEqual({ kind: "build", buildId: 77 });
  });

  it("ignores unknown or malformed links", () => {
    expect(parseArtifactLink("https://example.com")).toBeNull();
    expect(parseArtifactLink("vstfs:///Git/PullRequestId/p1%2Fr1%2Fabc")).toBeNull();
    expect(parseArtifactLink("vstfs:///Wiki/Page/x")).toBeNull();
  });

  it("round-trips pull request URIs", () => {
    const uri = pullRequestArtifactUri({ projectId: "p", repositoryId: "r", pullRequestId: 5 });
    expect(uri).toBe("vstfs:///Git/PullRequestId/p%2Fr%2F5");
    expect(parseArtifactLink(uri)).toMatchObject({ pullRequestId: 5 });
  });
});

describe("workingDaysBetween", () => {
  it("skips weekends", () => {
    // Friday → next Tuesday = Mon + Tue
    expect(workingDaysBetween(new Date("2026-10-16T10:00:00Z"), new Date("2026-10-20T10:00:00Z"))).toBe(2);
    expect(workingDaysBetween(new Date("2026-10-20T10:00:00Z"), new Date("2026-10-16T10:00:00Z"))).toBe(0);
  });
});

describe("computePayloadHash", () => {
  const base = { credentialId: "c", organizationUrl: "https://dev.azure.com/o", kind: "K", target: { a: 1, b: 2 }, params: { x: 1 }, baseRev: 3 };

  it("ignores key order", () => {
    expect(computePayloadHash(base)).toBe(
      computePayloadHash({ ...base, target: { b: 2, a: 1 } })
    );
  });

  it("changes when any bound field changes", () => {
    const hash = computePayloadHash(base);
    expect(computePayloadHash({ ...base, params: { x: 2 } })).not.toBe(hash);
    expect(computePayloadHash({ ...base, baseRev: 4 })).not.toBe(hash);
    expect(computePayloadHash({ ...base, credentialId: "d" })).not.toBe(hash);
    expect(computePayloadHash({ ...base, organizationUrl: "https://dev.azure.com/p" })).not.toBe(hash);
  });
});

describe("buildTimelineFromRecords", () => {
  it("groups jobs and failed tasks under stages", () => {
    const timeline = buildTimelineFromRecords(1, [
      { id: "s", type: "Stage", name: "Build", identifier: "Build", result: "failed" },
      { id: "p", parentId: "s", type: "Phase", name: "phase" },
      { id: "j", parentId: "p", type: "Job", name: "Job", result: "failed" },
      { id: "t", parentId: "j", type: "Task", name: "test", result: "failed", issues: [{ type: "error", message: "boom" }] },
      { id: "t2", parentId: "j", type: "Task", name: "ok", result: "succeeded" },
    ]);

    expect(timeline.failedStages).toEqual(["Build"]);
    expect(timeline.stages[0]?.jobs[0]?.failedTasks.map((task) => task.name)).toEqual(["test"]);
    expect(timeline.stages[0]?.jobs[0]?.failedTasks[0]?.issues).toEqual([{ type: "error", message: "boom" }]);
  });
});

describe("countUnresolvedThreads", () => {
  it("counts only active/pending user threads", () => {
    expect(
      countUnresolvedThreads([
        { id: 1, status: "active", comments: [{ id: 1, commentType: "text" }] },
        { id: 2, status: "pending", comments: [{ id: 1, commentType: "text" }] },
        { id: 3, status: "fixed", comments: [{ id: 1, commentType: "text" }] },
        { id: 4, comments: [{ id: 1, commentType: "system" }] },
        { id: 5, status: "active", isDeleted: true, comments: [{ id: 1, commentType: "text" }] },
      ])
    ).toBe(2);
  });
});

describe("ticket states that could not be read", () => {
  const raw = (state: string) => ({ id: 1, rev: 1, fields: { "System.TeamProject": "Alpha", "System.WorkItemType": "Bug", "System.State": state } }) as RawWorkItem;
  const guessed = (state: string) => {
    const summary = toWorkItemSummary(raw(state), null, "https://dev.azure.com/org");
    return [summary.stateCategory, summary.stateCategorySource];
  };

  it("guesses closed and removed from the state name, and says it was guessed", () => {
    expect(guessed("Closed")).toEqual(["Completed", "guessed"]);
    expect(guessed("Done")).toEqual(["Completed", "guessed"]);
    expect(guessed("Removed")).toEqual(["Removed", "guessed"]);
    expect(guessed("Cut")).toEqual(["Removed", "guessed"]);
    expect(guessed("Active")).toEqual(["Unknown", "guessed"]);
    // Read states always win, even for a custom name.
    expect(toWorkItemSummary(raw("Shipped"), [{ name: "Shipped", category: "Completed" }], "https://dev.azure.com/org")).toMatchObject({ stateCategory: "Completed", stateCategorySource: "azure" });
  });
});

describe("long work item history", () => {
  /** A client whose updates endpoint holds `count` updates (ids 1..count) and records the pages asked for. */
  function historyClient(count: number) {
    const skips: number[] = [];
    const client = {
      get: async (_segments: string[], options: { query: { $top: number; $skip: number } }) => {
        const { $top, $skip } = options.query;
        skips.push($skip);
        const ids = Array.from({ length: Math.max(0, Math.min($top, count - $skip)) }, (_, index) => $skip + index + 1);
        return { value: ids.map((id) => ({ id, rev: id })) };
      },
    } as unknown as AzureClient;
    return { client, skips };
  }

  it("reads short histories from the start, and says when one was cut", async () => {
    const short = historyClient(450);
    const read = await readWorkItemUpdates(short.client, "Alpha", 7, { rev: 450 });
    expect(short.skips).toEqual([0, 200, 400]);
    expect(read).toMatchObject({ truncated: false });
    expect(read.updates).toHaveLength(450);

    // Without the revision count, more than 5 pages cannot all be read: the newest are missing, and that is said.
    const unknown = historyClient(1500);
    expect((await readWorkItemUpdates(unknown.client, "Alpha", 7)).truncated).toBe(true);
    // The fifth page was full: one more update is asked for, to tell a cut from exactly 1000.
    expect(unknown.skips).toEqual([0, 200, 400, 600, 800, 1000]);
  });

  it("does not call a history of exactly 1000 revisions cut", async () => {
    for (const options of [{ rev: 1000 }, {}]) {
      const exact = historyClient(1000);
      const read = await readWorkItemUpdates(exact.client, "Alpha", 7, options);
      expect(read.truncated).toBe(false);
      expect(read.updates).toHaveLength(1000);
    }

    expect((await readWorkItemUpdates(historyClient(1001).client, "Alpha", 7, { rev: 1000 })).truncated).toBe(true);
  });

  it("reads the first page and the newest pages of a long history, skipping the middle", async () => {
    const long = historyClient(1500);
    const read = await readWorkItemUpdates(long.client, "Alpha", 7, { rev: 1500 });
    expect(long.skips).toEqual([0, 800, 1000, 1200, 1400]);
    expect(read.truncated).toBe(true);
    expect(read.updates[0]?.id).toBe(1);
    expect(read.updates.at(-1)?.id).toBe(1500);
    expect(read.updates.map((update) => update.id)).toEqual([...read.updates.map((update) => update.id)].sort((a, b) => a - b));
  });

  it("follows the comments' continuation, at most 5 pages", async () => {
    const tokens: Array<string | undefined> = [];
    const pages = (last: number) =>
      ({
        get: async (_segments: string[], options: { query: { continuationToken?: string } }) => {
          const page = Number(options.query.continuationToken ?? 0);
          tokens.push(options.query.continuationToken);
          return {
            comments: [{ id: page + 1, text: `c${page}`, createdBy: { id: "me", displayName: "Me" }, createdDate: `2025-10-0${page + 1}T00:00:00Z` }],
            continuationToken: page < last ? String(page + 1) : null,
          };
        },
      }) as unknown as AzureClient;

    const three = await readWorkItemComments(pages(2), "Alpha", 7);
    expect(three).toMatchObject({ truncated: false });
    expect(three.comments.map((comment) => comment.text)).toEqual(["c2", "c1", "c0"]);
    expect(tokens).toEqual([undefined, "1", "2"]);

    expect(await readWorkItemComments(pages(9), "Alpha", 7)).toMatchObject({ truncated: true, comments: expect.any(Array) });
  });
});
