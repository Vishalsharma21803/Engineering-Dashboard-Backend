import { describe, expect, it } from "vitest";

import { groupWorkItems } from "../../src/services/work-item-list/grouping.js";
import { getMyWorkSnapshotForTests, rememberMyWork } from "../../src/services/work-item-list/my-work.service.js";
import { inCurrentSprint } from "../../src/services/work-item-list/sprints.js";
import type { WorkItemSummary } from "../../src/types/azure.types.js";

function item(id: number, type: string, changedHoursAgo: number, links: { parentId?: number; childIds?: number[] } = {}, extra: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    id,
    rev: 1,
    projectName: "Alpha",
    type,
    title: `#${id}`,
    state: "Active",
    stateCategory: "InProgress",
    reason: null,
    priority: 2,
    assignedTo: null,
    iterationPath: null,
    areaPath: null,
    tags: [],
    originalEstimate: null,
    remainingWork: null,
    completedWork: null,
    storyPoints: null,
    effort: null,
    dueDate: null,
    blocked: false,
    createdDate: null,
    changedDate: new Date(Date.parse("2026-11-02T12:00:00Z") - changedHoursAgo * 3_600_000).toISOString(),
    stateChangeDate: null,
    closedDate: null,
    commentCount: 0,
    links: { pullRequests: [], commits: [], branches: [], builds: [], parentId: links.parentId ?? null, childIds: links.childIds ?? [] },
    webUrl: "",
    ...extra,
  };
}

const shape = (groups: ReturnType<typeof groupWorkItems>) =>
  groups.map((group) => ({ heading: group.headingId, listedHeading: group.headingItem?.id ?? null, rows: group.children.map((child) => child.id) }));

describe("grouping tickets by story", () => {
  it("puts my tasks and bugs under their story, and orders everything by the newest change, story or not", () => {
    const groups = groupWorkItems([
      // Under someone else's story #50 (not listed): the newest change of the day.
      item(1, "Task", 1, { parentId: 50 }),
      item(2, "Bug", 5, { parentId: 50 }),
      // My story #60 with one of my tasks.
      item(60, "User Story", 30, { childIds: [3] }),
      item(3, "Task", 2, { parentId: 60 }),
      // Under no story.
      item(4, "Task", 10),
      // My story with nothing of mine under it.
      item(70, "Product Backlog Item", 48),
    ]);

    expect(shape(groups)).toEqual([
      { heading: 50, listedHeading: null, rows: [1, 2] },
      { heading: 60, listedHeading: 60, rows: [3] },
      // Under no story, changed 10 h ago: before the story last changed 48 h ago.
      { heading: null, listedHeading: null, rows: [4] },
      { heading: 70, listedHeading: 70, rows: [] },
    ]);
  });

  it("orders groups by my tickets' changes only: a story edited just now does not lift its old tickets", () => {
    // My Feature #80 was edited 1 h ago, but my task under it last changed 20 h ago; #6 (no story) changed 2 h ago.
    const groups = groupWorkItems([item(5, "Task", 20, { parentId: 80 }), item(80, "Feature", 1), item(6, "Task", 2)]);
    expect(shape(groups).map((group) => group.heading)).toEqual([null, 80]);
    // A task whose parent is a Feature goes under that Feature.
    expect(shape(groups)[1]).toEqual({ heading: 80, listedHeading: 80, rows: [5] });
  });

  it("puts a bug under a listed task that is its parent, so nothing is lost", () => {
    expect(shape(groupWorkItems([item(9, "Task", 3, { childIds: [10] }), item(10, "Bug", 1, { parentId: 9 })]))).toEqual([{ heading: 9, listedHeading: 9, rows: [10] }]);
  });
});

describe("current sprint", () => {
  const sprints = new Map([["Alpha", { name: "Sprint 12", path: "Alpha\\Sprint 12", startDate: null, finishDate: null }]]);

  it("matches the sprint and paths under it, case-insensitively", () => {
    expect(inCurrentSprint(item(1, "Task", 1, {}, { iterationPath: "Alpha\\Sprint 12" }), sprints)).toBe(true);
    expect(inCurrentSprint(item(1, "Task", 1, {}, { iterationPath: "alpha\\sprint 12\\Week 1" }), sprints)).toBe(true);
    expect(inCurrentSprint(item(1, "Task", 1, {}, { iterationPath: "Alpha\\Sprint 120" }), sprints)).toBe(false);
    expect(inCurrentSprint(item(1, "Task", 1, {}, { iterationPath: null }), sprints)).toBe(false);
    // A project without sprints (or whose sprint could not be read) is never hidden by the sprint view.
    expect(inCurrentSprint(item(1, "Task", 1, {}, { projectName: "Beta", iterationPath: "Beta\\Sprint 1" }), sprints)).toBe(true);
    expect(inCurrentSprint(item(1, "Task", 1, {}, { projectName: "Beta", iterationPath: null }), new Map([["Beta", null]]))).toBe(true);
  });
});

describe("what a ticket needs", () => {
  it("keeps the ticket's fix and every reason when a time reminder is about the same ticket", () => {
    const fix = { kind: "WORK_ITEM_CLOSE_AFTER_MERGE" as const, target: { projectId: "Alpha", workItemId: 7 }, params: {}, requiresInput: false };
    const target = { type: "workItem" as const, projectName: "Alpha", id: 7, webUrl: null };
    rememberMyWork("u", "c", undefined, {
      workItems: [item(7, "Task", 1)],
      compliance: [],
      // Highest score first, as the dashboard sends them.
      recommendations: [
        { id: "wi:7", score: 60, category: "SOP", title: "#7", reasons: ["Overdue", "Priority 2"], signals: ["OVERDUE"], target, suggestedAction: fix },
        { id: "time:wi:7:untracked:2026-11-02", score: 15, category: "TIME", title: "#7", reasons: ["You worked on this today but tracked no time on it"], signals: ["TIME:UNTRACKED"], target, suggestedAction: null },
      ],
    });

    expect(getMyWorkSnapshotForTests("u", "c")?.attention.get(7)).toEqual({ category: "SOP", reasons: ["Overdue", "You worked on this today but tracked no time on it"], suggestedAction: fix });
  });
});
