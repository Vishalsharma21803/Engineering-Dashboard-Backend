/** Subset of Azure DevOps REST 7.1 response shapes Relay consumes. */

export interface RawIdentity {
  id?: string;
  displayName?: string;
  uniqueName?: string;
}

export interface RawList<T> {
  count?: number;
  value?: T[];
}

export interface RawConnectionData {
  authenticatedUser?: {
    id?: string;
    providerDisplayName?: string;
    customDisplayName?: string;
    properties?: { Account?: { $value?: string } };
  };
}

export interface RawProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
  visibility?: string;
  lastUpdateTime?: string;
  url?: string;
  defaultTeam?: { id: string; name: string };
  capabilities?: {
    processTemplate?: { templateName?: string };
    versioncontrol?: { sourceControlType?: string };
  };
}

export interface RawTeam {
  id: string;
  name: string;
}

export interface RawIteration {
  id: string;
  name: string;
  path: string;
  attributes?: { startDate?: string | null; finishDate?: string | null };
}

export interface RawWorkItemRelation {
  rel: string;
  url: string;
  attributes?: {
    name?: string;
    /** When the link was added (links and attachments). */
    authorizedDate?: string;
    resourceCreatedDate?: string;
  };
}

export interface RawWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations?: RawWorkItemRelation[];
  url?: string;
}

export interface RawWiqlResult {
  workItems?: Array<{ id: number }>;
}

export interface RawWorkItemState {
  name: string;
  category: string;
}

export interface RawWorkItemTypeField {
  referenceName: string;
}

export interface RawComment {
  id: number;
  text?: string;
  createdBy?: RawIdentity;
  createdDate: string;
  modifiedDate?: string;
  isDeleted?: boolean;
}

export interface RawCommentList {
  comments?: RawComment[];
  totalCount?: number;
  /** Set when more comments follow; passed back to read the next page. */
  continuationToken?: string | null;
}

export interface RawWorkItemUpdate {
  id: number;
  rev?: number;
  revisedBy?: RawIdentity;
  revisedDate?: string;
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
}

export interface RawReviewer extends RawIdentity {
  vote?: number;
  isRequired?: boolean;
  hasDeclined?: boolean;
}

export interface RawPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  mergeStatus?: string;
  createdBy?: RawIdentity;
  creationDate: string;
  closedDate?: string;
  sourceRefName: string;
  targetRefName: string;
  reviewers?: RawReviewer[];
  repository: {
    id: string;
    name: string;
    webUrl?: string;
    project: { id: string; name: string };
  };
}

export interface RawThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  threadContext?: { filePath?: string } | null;
  comments?: Array<{
    id: number;
    author?: RawIdentity;
    content?: string;
    commentType?: string;
    publishedDate?: string;
    isDeleted?: boolean;
  }>;
}

export interface RawPolicyEvaluation {
  status?: string;
  configuration?: {
    isBlocking?: boolean;
    isEnabled?: boolean;
    type?: { displayName?: string };
  };
}

export interface RawBuild {
  id: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  definition?: { id: number; name: string };
  project?: { id: string; name: string };
  sourceBranch?: string;
  sourceVersion?: string;
  reason?: string;
  requestedFor?: RawIdentity;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  _links?: { web?: { href?: string } };
}

export interface RawBuildDefinition {
  id: number;
  name: string;
  path?: string;
  queueStatus?: string;
  latestBuild?: RawBuild;
  latestCompletedBuild?: RawBuild;
  repository?: { defaultBranch?: string };
  _links?: { web?: { href?: string } };
}

export interface RawTimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  identifier?: string | null;
  state?: string;
  result?: string | null;
  startTime?: string | null;
  finishTime?: string | null;
  errorCount?: number;
  issues?: Array<{ type?: string; message?: string }> | null;
  log?: { id?: number } | null;
  order?: number;
}

export interface RawTimeline {
  records?: RawTimelineRecord[];
}

export interface RawEnvironment {
  id: number;
  name: string;
}

export interface RawEnvironmentDeployment {
  id: number;
  definition?: { name?: string };
  stageName?: string;
  result?: string;
  startTime?: string;
  finishTime?: string;
  owner?: { id?: number };
}

export interface RawRelease {
  id: number;
  name: string;
  status?: string;
  createdOn?: string;
  releaseDefinition?: { name?: string };
  environments?: Array<{ name?: string; status?: string }>;
  _links?: { web?: { href?: string } };
}

export interface RawRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  size?: number;
  isDisabled?: boolean;
  webUrl?: string;
}

export interface RawRef {
  name: string;
  objectId: string;
  creator?: RawIdentity;
}

export interface RawCommit {
  commitId: string;
  author?: { name?: string; email?: string; date?: string };
  comment?: string;
  remoteUrl?: string;
}
