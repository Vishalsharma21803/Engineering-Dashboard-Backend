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

export const proposeActionSchema = z
  .object({
    credentialId: z.string().uuid("Invalid credential id"),
    source: z.enum(["RECOMMENDATION", "USER", "AI_SUGGESTION"]).default("USER"),
  })
  .and(actionVariants);

export type ProposeActionInput = z.infer<typeof proposeActionSchema>;
export type ActionVariant = z.infer<typeof actionVariants>;

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
