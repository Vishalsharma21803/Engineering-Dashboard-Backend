import { z } from "zod";

import { pageParam } from "../lib/pagination.js";
import { REPORT_ROLES } from "../services/sop/sop-report.service.js";
import { pullRequestFiltersSchema } from "../services/work-item-list/pull-request-filters.js";
import { workItemFiltersSchema } from "../services/work-item-list/work-item-filters.js";

/** Azure project name or GUID. Encoded per path segment by AzureClient. */
export const azureProjectIdSchema = z
  .string()
  .trim()
  .min(1, "Project is required")
  .max(256, "Project must not exceed 256 characters")
  .regex(/^[^/\\?#%\u0000-\u001f]+$/, "Invalid project")
  .refine((value) => value !== "." && value !== "..", "Invalid project");

export const repositoryIdSchema = z.string().uuid("Invalid repository id");

export const positiveIntParam = (field: string) =>
  z.coerce
    .number({ message: `Invalid ${field}` })
    .int(`Invalid ${field}`)
    .positive(`Invalid ${field}`);

/** Any page value is accepted and made safe (see pageParam); it never fails validation. */
export const pageQuery = z.unknown().optional().transform(pageParam);

export const booleanFlag = z
  .enum(["1", "0", "true", "false"])
  .optional()
  .transform((value) => value === "1" || value === "true");

export const refreshQuerySchema = z.object({ refresh: booleanFlag });

export const dashboardQuerySchema = z.object({
  projectId: azureProjectIdSchema.optional(),
});

export const workItemsQuerySchema = z
  .object({
    projectId: azureProjectIdSchema.optional(),
    state: z.enum(["open", "all"]).default("open"),
    assignee: z.enum(["me", "any"]).default("me"),
  })
  .refine((query) => query.assignee === "me" || query.projectId !== undefined, {
    message: "projectId is required when assignee is any",
    path: ["projectId"],
  });

export const pullRequestsQuerySchema = z
  .object({
    projectId: azureProjectIdSchema.optional(),
    role: z.enum(["author", "reviewer", "all", "everyone"]).default("all"),
    page: pageQuery,
  })
  .extend(pullRequestFiltersSchema.shape)
  .refine((query) => query.role !== "everyone" || query.projectId !== undefined, {
    message: "projectId is required when role is everyone",
    path: ["projectId"],
  });

export const runsQuerySchema = z.object({
  top: z.coerce.number().int().min(1).max(100).default(20),
});

export const buildsQuerySchema = z.object({
  status: z
    .string()
    .regex(/^(inProgress|notStarted|completed|cancelling|postponed)(,(inProgress|notStarted|completed|cancelling|postponed))*$/)
    .default("inProgress,notStarted"),
  top: z.coerce.number().int().min(1).max(100).default(50),
});

export const commitsQuerySchema = z.object({
  author: z.enum(["me", "any"]).default("any"),
  branch: z.string().trim().min(1).max(256).optional(),
  top: z.coerce.number().int().min(1).max(100).default(30),
});


export const myWorkQuerySchema = workItemFiltersSchema.extend({
  projectId: azureProjectIdSchema.optional(),
  page: pageQuery,
  /** Show snoozed and abandoned tickets instead of the active ones. */
  hidden: booleanFlag.catch(false),
  /** "current": only tickets in their project's current sprint; absent: current when any are, else all. */
  sprint: z.enum(["current", "all"]).optional().catch(undefined),
  /** Also list tickets closed in the last days. */
  closed: booleanFlag.catch(false),
  /** Only tickets that need something from me (blocked, SOP gaps, idle…). */
  attention: booleanFlag.catch(false),
  /** "status": sections (in progress, to do, resolved, done) with stories inside; "story": story groups only. */
  groupBy: z.enum(["status", "story"]).optional().catch(undefined),
});

export const teamWorkQuerySchema = workItemFiltersSchema.extend({
  scope: z.enum(["open", "all"]).catch("open").default("open"),
  page: pageQuery,
});

/** Filters are optional and never fail validation: anything unexpected means "no filter". */
const reportFilter = z.string().trim().max(200).catch("").default("");

export const sopReportRunQuerySchema = z.object({
  page: pageQuery,
  rulePage: pageQuery,
  personPage: pageQuery,
  person: reportFilter,
  role: z.enum(REPORT_ROLES).or(z.literal("")).catch("").default(""),
  rule: reportFilter,
  type: reportFilter,
  state: reportFilter,
});

export const sopReportRunsQuerySchema = z.object({ page: pageQuery });

export const sopProjectsPageQuerySchema = z.object({ page: pageQuery, elsewherePage: pageQuery });

/** Any list paged on the server with only a page number. */
export const pageOnlyQuerySchema = z.object({ page: pageQuery });

/** Pipelines: without a page, `build` opens the page holding the pipeline of that run. */
export const pipelinesQuerySchema = z.object({
  page: pageQuery,
  build: z.coerce.number().int().positive().optional().catch(undefined),
});

const dashboardListQuery = {
  projectId: azureProjectIdSchema.optional(),
  page: pageQuery,
  /** Show snoozed and abandoned items instead of the active ones. */
  hidden: booleanFlag.catch(false),
};

export const recommendationsQuerySchema = z.object({
  ...dashboardListQuery,
  category: z.enum(["BLOCKER", "FAILED_PIPELINE", "REVIEW", "SOP", "TIME", "STALE"]).or(z.literal("")).catch("").default(""),
});

export const dashboardPullRequestsQuerySchema = z.object({ ...dashboardListQuery, ...pullRequestFiltersSchema.shape });

export const pipelineRunsQuerySchema = z.object({ ...dashboardListQuery, result: z.string().trim().max(100).catch("").default("") });

export const reportRunIdSchema = z.string().uuid("Invalid report id");
