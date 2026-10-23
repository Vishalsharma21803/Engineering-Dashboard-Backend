/**
 * Default SOP thresholds. No SOP document exists yet; adjust these values
 * (or the rules in rules.ts) once the team SOP is agreed.
 */
export const complianceConfig = {
  /** A comment starting with this prefix (case-insensitive) documents the approach. */
  approachCommentPrefix: "approach:",
  /** Assignee must comment on in-progress tickets at least this often. */
  commentStaleWorkingDays: 2,
  /** Remaining/Completed work must be updated at least this often while in progress. */
  workLogStaleWorkingDays: 2,
  /** Ticket must be closed within this many hours after its last PR merges. */
  closeAfterMergeHours: 24,
  /** Closed tickets changed within this window are still checked. */
  recentlyClosedDays: 14,
  /** Types expected to be delivered through a pull request. */
  codeWorkItemTypes: ["Task", "Bug", "User Story", "Product Backlog Item", "Issue", "Requirement"],
};

export type ComplianceConfig = typeof complianceConfig;
