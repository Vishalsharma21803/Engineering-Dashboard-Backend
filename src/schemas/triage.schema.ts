import { z } from "zod";

export const TRIAGE_STATUSES = ["SNOOZED", "ACKNOWLEDGED", "ABANDONED"] as const;

const MAX_SNOOZE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Azure DevOps project names cannot contain ":", and git refs cannot contain
 * ":" or whitespace, so ":" is a safe separator inside every key.
 */
export const triageItemKeySchema = z
  .string()
  .max(600)
  .regex(
    /^(wi:\d{1,10}|pr:[A-Za-z0-9-]{1,64}:\d{1,10}|pipeline:[^:\p{Cc}]{1,128}:\d{1,10}:[^:\s]{0,400}|project:[^:\p{Cc}]{1,128}|time:[A-Za-z0-9:-]{1,64})$/u,
    "Invalid item key"
  );

const signalSchema = z
  .string()
  .min(1)
  .max(700)
  .regex(/^[^\p{Cc}]+$/u, "Invalid signal");

export const upsertTriageSchema = z
  .object({
    credentialId: z.string().uuid("Invalid credential id"),
    itemKey: triageItemKeySchema,
    status: z.enum(TRIAGE_STATUSES),
    snoozedUntil: z.iso.datetime({ offset: true }).optional(),
    signals: z.array(signalSchema).max(1000).default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.status !== "SNOOZED") {
      if (input.snoozedUntil !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["snoozedUntil"],
          message: "Only snoozed items have an end date",
        });
      }
      return;
    }

    if (input.snoozedUntil === undefined) {
      ctx.addIssue({ code: "custom", path: ["snoozedUntil"], message: "Choose when the snooze ends" });
      return;
    }

    const msFromNow = Date.parse(input.snoozedUntil) - Date.now();

    if (msFromNow <= 0) {
      ctx.addIssue({ code: "custom", path: ["snoozedUntil"], message: "Snooze must end in the future" });
    } else if (msFromNow > MAX_SNOOZE_MS) {
      ctx.addIssue({ code: "custom", path: ["snoozedUntil"], message: "Snooze must end within a year" });
    }
  });

export const listTriageQuerySchema = z.object({
  credentialId: z.string().uuid("Invalid credential id"),
});

export const triageIdSchema = z.string().uuid("Invalid triage mark id");

export type UpsertTriageInput = z.infer<typeof upsertTriageSchema>;
