import { z } from "zod";

import { azureProjectIdSchema, booleanFlag, pageQuery } from "./azure.schema.js";

const workItemTarget = z
  .object({
    projectId: azureProjectIdSchema,
    workItemId: z.number().int().positive(),
  })
  .strict();

const buildTarget = z
  .object({
    projectId: azureProjectIdSchema,
    buildId: z.number().int().positive(),
  })
  .strict();

const definitionTarget = z
  .object({
    projectId: azureProjectIdSchema,
    definitionId: z.number().int().positive(),
  })
  .strict();

const hours = z.number().finite().min(0).max(10_000);

export const UPDATABLE_WORK_FIELDS = [
  "originalEstimate",
  "remainingWork",
  "completedWork",
  "storyPoints",
  "effort",
  "priority",
] as const;

export type UpdatableWorkField = (typeof UPDATABLE_WORK_FIELDS)[number];

/** Text fields an AI fix (or a person) may replace in full. */
export const EDITABLE_TEXT_FIELDS = ["title", "description", "acceptanceCriteria"] as const;
export type EditableTextField = (typeof EDITABLE_TEXT_FIELDS)[number];

const tag = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !value.includes(";"), "Tags cannot contain ;");

const actionVariants = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("WORK_ITEM_COMMENT"),
    target: workItemTarget,
    params: z
      .object({
        text: z
          .string()
          .trim()
          .min(1, "Comment text is required")
          .max(10_000, "Comment must not exceed 10000 characters"),
      })
      .strict(),
  }),
  z.object({
    kind: z.literal("WORK_ITEM_UPDATE_FIELDS"),
    target: workItemTarget,
    params: z
      .object({
        originalEstimate: hours.optional(),
        remainingWork: hours.optional(),
        completedWork: hours.optional(),
        storyPoints: hours.optional(),
        effort: hours.optional(),
        priority: z.number().int().min(1).max(4).optional(),
      })
      .strict()
      .refine(
        (params) => Object.values(params).some((value) => value !== undefined),
        { message: "At least one field is required" }
      ),
  }),
  z.object({
    /** Time → Verify: Solidtime totals onto several tickets, approved together. */
    kind: z.literal("WORK_ITEMS_UPDATE_TIME"),
    target: z.object({}).strict().default({}),
    params: z
      .object({
        items: z
          .array(
            z
              .object({
                projectId: azureProjectIdSchema,
                workItemId: z.number().int().positive(),
                completedWork: hours,
                remainingWork: hours.optional(),
              })
              .strict()
          )
          .min(1, "Choose at least one ticket")
          .max(50, "Update at most 50 tickets at once")
          .refine((items) => new Set(items.map((item) => item.workItemId)).size === items.length, { message: "A ticket is listed twice" }),
      })
      .strict(),
  }),
  z.object({
    kind: z.literal("WORK_ITEM_TRANSITION_STATE"),
    target: workItemTarget,
    params: z.object({ state: z.string().trim().min(1).max(128) }).strict(),
  }),
  z.object({
    kind: z.literal("WORK_ITEM_LINK_PR"),
    target: workItemTarget,
    params: z
      .object({
        repositoryId: z.string().uuid("Invalid repository id"),
        pullRequestId: z.number().int().positive(),
      })
      .strict(),
  }),
  z.object({
    kind: z.literal("WORK_ITEM_CLOSE_AFTER_MERGE"),
    target: workItemTarget,
    params: z.object({}).strict(),
  }),
  z.object({
    kind: z.literal("WORK_ITEM_EDIT_TEXT"),
    target: workItemTarget,
    params: z
      .object({
        field: z.enum(EDITABLE_TEXT_FIELDS),
        text: z.string().trim().min(1, "Text is required").max(30_000),
      })
      .strict()
      .refine((params) => params.field !== "title" || (params.text.length <= 255 && !/[\r\n]/.test(params.text)), {
        message: "A title is one line of at most 255 characters",
        path: ["text"],
      }),
  }),
  z.object({
    kind: z.literal("WORK_ITEM_SET_CATEGORY"),
    target: workItemTarget,
    params: z.object({ category: z.string().trim().min(1).max(100) }).strict(),
  }),
  z.object({
    kind: z.literal("WORK_ITEM_ADD_TAGS"),
    target: workItemTarget,
    params: z.object({ tags: z.array(tag).min(1).max(10) }).strict(),
  }),
  z.object({
    kind: z.literal("PIPELINE_QUEUE_RUN"),
    target: definitionTarget,
    params: z
      .object({
        sourceBranch: z
          .string()
          .trim()
          .max(256)
          .regex(/^refs\/heads\/\S+$/, "Branch must look like refs/heads/<name>")
          .optional(),
      })
      .strict(),
  }),
  z.object({
    kind: z.literal("BUILD_RETRY_STAGE"),
    target: buildTarget,
    params: z
      .object({
        stageRefName: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_]+$/, "Invalid stage reference name"),
      })
      .strict(),
  }),
  z.object({
    kind: z.literal("BUILD_CANCEL"),
    target: buildTarget,
    params: z.object({}).strict(),
  }),
]);

/* ------------------------------------------------- Solidtime (time tracking) */

const uuid = z.string().uuid();
/** An instant sent by the browser (ISO); stored as Solidtime's whole-second UTC. */
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const entryDescription = z.string().trim().max(5000).nullable();
/** Solidtime has no "get one entry" call: an entry is found again by its id and exact start. */
const entryTarget = z.object({ entryId: uuid, entryStart: instant }).strict();

const entryFields = {
  description: entryDescription,
  projectId: uuid.nullable(),
  taskId: uuid.nullable(),
  tags: z.array(uuid).max(20).default([]),
  billable: z.boolean().default(false),
};

const newEntry = z
  .object({ start: instant, end: instant, ...entryFields })
  .strict()
  .refine((entry) => entry.end > entry.start, { message: "The end must be after the start", path: ["end"] })
  .refine((entry) => entry.end.getTime() - entry.start.getTime() <= 24 * 3_600_000, { message: "One entry can be at most 24 hours", path: ["end"] })
  .refine((entry) => entry.taskId === null || entry.projectId !== null, { message: "A task needs its project", path: ["taskId"] });

export const SOLIDTIME_ACTION_KINDS = [
  "SOLIDTIME_TIMER_START",
  "SOLIDTIME_TIMER_STOP",
  "SOLIDTIME_ENTRY_CREATE",
  "SOLIDTIME_ENTRY_UPDATE",
  "SOLIDTIME_ENTRY_DELETE",
  "SOLIDTIME_ENTRIES_CREATE",
  "SOLIDTIME_PROJECT_CREATE",
  "SOLIDTIME_TASK_CREATE",
  "SOLIDTIME_TAG_CREATE",
  "SOLIDTIME_CLIENT_CREATE",
] as const;

const solidtimeVariants = [
  z.object({
    kind: z.literal("SOLIDTIME_TIMER_START"),
    target: z.object({}).strict().default({}),
    params: z
      .object({
        /** When the Start button was pressed; the entry starts then, not at approval. */
        startedAt: instant,
        ...entryFields,
      })
      .strict()
      .refine((params) => params.taskId === null || params.projectId !== null, { message: "A task needs its project", path: ["taskId"] }),
  }),
  z.object({
    kind: z.literal("SOLIDTIME_TIMER_STOP"),
    target: entryTarget,
    params: z.object({ stoppedAt: instant }).strict(),
  }),
  z.object({ kind: z.literal("SOLIDTIME_ENTRY_CREATE"), target: z.object({}).strict().default({}), params: newEntry }),
  z.object({
    kind: z.literal("SOLIDTIME_ENTRY_UPDATE"),
    target: entryTarget,
    params: z
      .object({
        start: instant.optional(),
        end: instant.optional(),
        description: entryDescription.optional(),
        projectId: uuid.nullable().optional(),
        taskId: uuid.nullable().optional(),
        tags: z.array(uuid).max(20).optional(),
        billable: z.boolean().optional(),
      })
      .strict()
      .refine((params) => Object.values(params).some((value) => value !== undefined), { message: "Change at least one field" }),
  }),
  z.object({ kind: z.literal("SOLIDTIME_ENTRY_DELETE"), target: entryTarget, params: z.object({}).strict() }),
  z.object({
    kind: z.literal("SOLIDTIME_ENTRIES_CREATE"),
    target: z.object({}).strict().default({}),
    params: z.object({ entries: z.array(newEntry).min(1).max(50) }).strict(),
  }),
  z.object({
    kind: z.literal("SOLIDTIME_PROJECT_CREATE"),
    target: z.object({}).strict().default({}),
    params: z
      .object({
        name: z.string().trim().min(1).max(255),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #4f46e5").default("#4f46e5"),
        clientId: uuid.nullable().default(null),
        billable: z.boolean().default(false),
      })
      .strict(),
  }),
  z.object({
    kind: z.literal("SOLIDTIME_TASK_CREATE"),
    target: z.object({}).strict().default({}),
    params: z.object({ projectId: uuid, name: z.string().trim().min(1).max(255), estimatedHours: z.number().min(0).max(10_000).nullable().default(null) }).strict(),
  }),
  z.object({ kind: z.literal("SOLIDTIME_TAG_CREATE"), target: z.object({}).strict().default({}), params: z.object({ name: z.string().trim().min(1).max(255) }).strict() }),
  z.object({ kind: z.literal("SOLIDTIME_CLIENT_CREATE"), target: z.object({}).strict().default({}), params: z.object({ name: z.string().trim().min(1).max(255) }).strict() }),
] as const;

const allVariants = z.discriminatedUnion("kind", [...actionVariants.options, ...solidtimeVariants]);

export const proposeActionSchema = z
  .object({
    credentialId: z.string().uuid("Invalid credential id"),
    source: z.enum(["RECOMMENDATION", "USER", "AI_SUGGESTION"]).default("USER"),
  })
  .and(allVariants);

export type ProposeActionInput = z.infer<typeof proposeActionSchema>;
/** An Azure DevOps change. */
export type ActionVariant = z.infer<typeof actionVariants>;
/** A Solidtime change. */
export type SolidtimeActionVariant = z.infer<(typeof solidtimeVariants)[number]>;

export function isSolidtimeAction(input: ProposeActionInput): input is ProposeActionInput & SolidtimeActionVariant {
  return (SOLIDTIME_ACTION_KINDS as readonly string[]).includes(input.kind);
}

export const approveActionSchema = z
  .object({
    payloadHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "Invalid payload hash"),
  })
  .strict();

export const rejectActionSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const actionIdSchema = z.string().uuid("Invalid action id");

export const ACTION_STATUSES = [
  "PENDING",
  "APPROVED",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "EXPIRED",
] as const;

/** Narrows lists to one organization and, optionally, one project (matched by id or name). */
const scopeQuery = {
  credentialId: z.string().uuid().optional(),
  projectId: z.string().trim().min(1).max(256).optional(),
  projectName: z.string().trim().min(1).max(256).optional(),
};

export const listActionsQuerySchema = z.object({
  status: z.enum(ACTION_STATUSES).optional(),
  /** Decided actions only (everything except PENDING). */
  history: booleanFlag,
  ...scopeQuery,
  page: pageQuery,
});

export const listAuditLogsQuerySchema = z.object({
  actionId: z.string().uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  ...scopeQuery,
  page: pageQuery,
});

export type ActionScopeFilter = { credentialId?: string | undefined; projectId?: string | undefined; projectName?: string | undefined };
