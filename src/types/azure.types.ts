/** API DTOs returned by /api/azure/*. Mirrored in frontend/src/features/azure-devops/types. */

export interface IdentityRef {
  id: string | null;
  displayName: string;
  uniqueName: string | null;
}

export interface AzureIdentity {
  id: string;
  displayName: string;
  email: string | null;
}

export type ScopeStatus = "granted" | "missing" | "unknown";

export type ScopeArea =
  | "project"
  | "work"
  | "code"
  | "build"
  | "release"
  | "environment";

export type WriteScopeArea = "work" | "build";

export interface Capabilities {
  identity: AzureIdentity;
  scopes: Record<ScopeArea, ScopeStatus>;
  writeScopes: Record<WriteScopeArea, ScopeStatus>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  state: string;
  visibility: string;
  lastUpdateTime: string | null;
  url: string;
}

export interface IterationSummary {
  id: string;
  name: string;
  path: string;
  startDate: string | null;
  finishDate: string | null;
}

export type SectionStatus = "ok" | "forbidden" | "error";

export interface Section<T> {
  status: SectionStatus;
  data: T | null;
  reason: string | null;
}

export interface ProjectOverview extends ProjectSummary {
  processTemplate: string | null;
  sourceControlType: string | null;
  defaultTeam: { id: string; name: string } | null;
  currentIteration: Section<IterationSummary | null>;
  counts: {
    repositories: Section<number>;
    myOpenWorkItems: Section<number>;
    activePullRequests: Section<number>;
    failingPipelines: Section<number>;
  };
}

export type StateCategory =
  | "Proposed"
  | "InProgress"
  | "Resolved"
  | "Completed"
  | "Removed"
  | "Unknown";

export interface WorkItemSummary {
  id: number;
  rev: number;
  projectName: string;
  type: string;
  title: string;
  state: string;
  stateCategory: StateCategory;
  reason: string | null;
  priority: number | null;
  assignedTo: IdentityRef | null;
  iterationPath: string | null;
  areaPath: string | null;
  tags: string[];
  originalEstimate: number | null;
  remainingWork: number | null;
  completedWork: number | null;
  storyPoints: number | null;
  effort: number | null;
  dueDate: string | null;
  blocked: boolean;
  createdDate: string | null;
  changedDate: string | null;
  stateChangeDate: string | null;
  closedDate: string | null;
  commentCount: number;
  links: WorkItemLinks;
  webUrl: string;
}

export interface WorkItemLinks {
  pullRequests: Array<{
    projectId: string;
    repositoryId: string;
    pullRequestId: number;
  }>;
  commits: Array<{ repositoryId: string; commitId: string }>;
  branches: Array<{ repositoryId: string; refName: string }>;
  builds: number[];
  parentId: number | null;
  childIds: number[];
}

export interface WorkItemComment {
  id: number;
  text: string;
  createdBy: IdentityRef;
  createdDate: string;
  modifiedDate: string | null;
}

export interface WorkFieldChange {
  revisedDate: string;
  revisedBy: IdentityRef | null;
  field: "OriginalEstimate" | "RemainingWork" | "CompletedWork" | "State";
  oldValue: string | number | null;
  newValue: string | number | null;
}

export interface LinkedPullRequest {
  projectId: string;
  repositoryId: string;
  repositoryName: string | null;
  pullRequestId: number;
  title: string | null;
  status: string;
  closedDate: string | null;
  webUrl: string | null;
}

export interface WorkItemDetail extends WorkItemSummary {
  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
  comments: Section<WorkItemComment[]>;
  history: Section<WorkFieldChange[]>;
  linkedPullRequests: Section<LinkedPullRequest[]>;
  allowedStates: Array<{ name: string; category: StateCategory }>;
  supportedFields: SupportedWorkFields;
  compliance: ComplianceResult;
  /** False when the project's SOP has a Testing stage after merge. */
  closeAfterMergeAllowed: boolean;
}

export interface SupportedWorkFields {
  originalEstimate: boolean;
  remainingWork: boolean;
  completedWork: boolean;
  storyPoints: boolean;
  effort: boolean;
  priority: boolean;
}

export interface PullRequestReviewer {
  id: string;
  displayName: string;
  vote: number;
  voteLabel:
    | "approved"
    | "approvedWithSuggestions"
    | "noVote"
    | "waitingForAuthor"
    | "rejected";
  isRequired: boolean;
  hasDeclined: boolean;
}

export interface PullRequestSummary {
  projectId: string;
  projectName: string;
  repositoryId: string;
  repositoryName: string;
  pullRequestId: number;
  title: string;
  status: string;
  isDraft: boolean;
  mergeStatus: string | null;
  createdBy: IdentityRef;
  creationDate: string;
  closedDate: string | null;
  sourceBranch: string;
  targetBranch: string;
  reviewers: PullRequestReviewer[];
  approvals: number;
  rejections: number;
  unresolvedThreads: number | null;
  myRole: "author" | "reviewer" | "other";
  myVote: number | null;
  webUrl: string;
}

export interface PullRequestThread {
  id: number;
  status: string;
  filePath: string | null;
  isResolved: boolean;
  comments: Array<{
    id: number;
    author: IdentityRef;
    content: string;
    publishedDate: string | null;
  }>;
}

export interface PolicyEvaluation {
  name: string;
  status: string;
  isBlocking: boolean;
}

export interface PullRequestDetail extends PullRequestSummary {
  description: string;
  threads: Section<PullRequestThread[]>;
  policies: Section<PolicyEvaluation[]>;
  linkedWorkItemIds: Section<number[]>;
}

export interface BuildSummary {
  id: number;
  buildNumber: string;
  definitionId: number;
  definitionName: string;
  projectName: string | null;
  status: string;
  result: string | null;
  sourceBranch: string | null;
  sourceVersion: string | null;
  reason: string | null;
  requestedFor: IdentityRef | null;
  queueTime: string | null;
  startTime: string | null;
  finishTime: string | null;
  webUrl: string | null;
}

export interface PipelineSummary {
  id: number;
  name: string;
  path: string;
  queueStatus: string | null;
  latestBuild: BuildSummary | null;
  latestCompletedBuild: BuildSummary | null;
  health: "succeeded" | "failed" | "partiallySucceeded" | "canceled" | "running" | "never";
  webUrl: string | null;
}

export interface TimelineIssue {
  type: string;
  message: string;
}

export interface TimelineNode {
  id: string;
  type: string;
  name: string;
  identifier: string | null;
  state: string | null;
  result: string | null;
  startTime: string | null;
  finishTime: string | null;
  errorCount: number;
  issues: TimelineIssue[];
  logId: number | null;
}

export interface StageResult extends TimelineNode {
  jobs: Array<TimelineNode & { failedTasks: TimelineNode[] }>;
}

export interface BuildTimeline {
  buildId: number;
  stages: StageResult[];
  failedStages: string[];
}

export interface EnvironmentDeployment {
  environmentId: number;
  environmentName: string;
  lastDeployments: Array<{
    id: number;
    definitionName: string | null;
    stageName: string | null;
    result: string | null;
    startTime: string | null;
    finishTime: string | null;
    buildId: number | null;
  }>;
}

export interface ReleaseSummary {
  id: number;
  name: string;
  status: string;
  definitionName: string | null;
  createdOn: string | null;
  environments: Array<{ name: string; status: string }>;
  webUrl: string | null;
}

export interface Deployments {
  environments: Section<EnvironmentDeployment[]>;
  releases: Section<ReleaseSummary[]>;
}

export interface RepositorySummary {
  id: string;
  name: string;
  defaultBranch: string | null;
  size: number | null;
  isDisabled: boolean;
  webUrl: string | null;
}

export interface BranchSummary {
  name: string;
  objectId: string;
  creator: IdentityRef | null;
}

export interface CommitSummary {
  commitId: string;
  author: { name: string; email: string | null; date: string | null };
  comment: string;
  webUrl: string | null;
}

/** A rule card id from the SOP rulebook, e.g. "STR-05". */
export type ComplianceRuleId = string;

export type Severity = "high" | "medium" | "low";

export interface SuggestedAction {
  kind: string;
  target: Record<string, string | number>;
  params: Record<string, unknown>;
  /** True when the user must fill in values (e.g. comment text, estimate). */
  requiresInput: boolean;
}

export interface ComplianceViolation {
  ruleId: ComplianceRuleId;
  ruleTitle: string;
  checker: "code" | "ai";
  /** "fail" rules are high, "warn" rules medium, "notice" rules low. */
  severity: Severity;
  message: string;
  /** Specific facts behind the message (dates, PR ids, branch names). */
  evidence: string[];
  suggestedAction: SuggestedAction | null;
  /** "earlier": the rule belongs to a stage the ticket has already moved past. */
  phase: "now" | "earlier";
}

export interface ComplianceRuleRef {
  ruleId: ComplianceRuleId;
  ruleTitle: string;
}

export interface ComplianceResult {
  workItemId: number;
  projectName: string;
  title: string;
  type: string;
  state: string;
  stateCategory: StateCategory;
  /** False when the project is not set up for SOP checks, or the user switched it off; nothing is checked. */
  configured: boolean;
  /** Why a project is or is not checked. */
  sopProject: "checked" | "not-set-up" | "switched-off";
  rulebook: { defaultVersion: number; personalVersion: number };
  /** SOP gaps: missed in a stage the ticket has moved past (or due now). Counted in badges, filters, scores and reports. */
  violations: ComplianceViolation[];
  /** Shown on the ticket only; never counted as gaps. */
  notices: ComplianceViolation[];
  /** Needed in the ticket's current stage; not gaps yet. */
  todos: ComplianceViolation[];
  passedRules: ComplianceRuleRef[];
  /** Could not be checked (data unavailable or not applicable to this setup). */
  skippedRules: Array<ComplianceRuleRef & { reason: string }>;
  /** Rules only AI can judge (personal AI rules); judged on the ticket page. `due`: a fail counts as a gap. */
  aiRules: Array<ComplianceRuleRef & { due: boolean; phase: "now" | "earlier" }>;
  /** Code findings the user's AI review showed to be met (with its reason and verified quotes). */
  cleared: Array<ComplianceRuleRef & { reason: string; quotes: string[] }>;
  /** The user's last AI review of this ticket; null when there is none. */
  aiReview: ComplianceAiReview | null;
}

export interface ComplianceAiReview {
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED";
  checkedAt: string | null;
  /** The ticket changed since the review: its clears no longer apply. */
  outdated: boolean;
}

export type RecommendationCategory =
  | "BLOCKER"
  | "FAILED_PIPELINE"
  | "REVIEW"
  | "SOP"
  | "STALE"
  /** Time-tracking nudges from the linked Solidtime connection. */
  | "TIME";

export interface Recommendation {
  id: string;
  score: number;
  category: RecommendationCategory;
  title: string;
  reasons: string[];
  /** Stable reason codes (unlike display text); a new code resurfaces a triaged item. */
  signals: string[];
  target: {
    type: "workItem" | "pullRequest" | "build" | "time";
    projectName: string;
    id: number;
    repositoryId?: string;
    /** Time nudges: the triage key and the Solidtime connection to open. */
    key?: string;
    solidtimeCredentialId?: string;
    webUrl: string | null;
  };
  suggestedAction: SuggestedAction | null;
}

export interface Dashboard {
  identity: AzureIdentity;
  generatedAt: string;
  projectsScanned: number;
  projectsTruncated: boolean;
  sections: {
    workItems: Section<WorkItemSummary[]>;
    pullRequests: Section<PullRequestSummary[]>;
    pipelines: Section<BuildSummary[]>;
    compliance: Section<ComplianceResult[]>;
  };
  recommendations: Recommendation[];
}
