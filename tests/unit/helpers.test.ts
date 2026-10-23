import { describe, expect, it } from "vitest";

import { parseArtifactLink, pullRequestArtifactUri } from "../../src/lib/azure/artifact-links.js";
import { htmlToText, textToHtml } from "../../src/lib/html-to-text.js";
import { workingDaysBetween } from "../../src/lib/working-days.js";
import { computePayloadHash } from "../../src/services/actions/action.service.js";
import { buildTimelineFromRecords } from "../../src/services/azure/pipelines.service.js";
import { countUnresolvedThreads } from "../../src/services/azure/pull-requests.service.js";

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
