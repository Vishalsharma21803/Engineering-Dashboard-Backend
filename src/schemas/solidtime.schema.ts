import { z } from "zod";

import { normalizeSolidtimeUrl } from "../lib/solidtime/url.js";
import { booleanFlag, pageQuery } from "./azure.schema.js";

export const solidtimeUrlSchema = z
  .string()
  .trim()
  .min(1, "The Solidtime address is required")
  .max(300, "The Solidtime address is too long")
  .transform((value, ctx) => {
    const result = normalizeSolidtimeUrl(value);

    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message });
      return z.NEVER;
    }

    return result.url;
  });

/** Solidtime API tokens are long JWTs. */
export const solidtimeTokenSchema = z
  .string()
  .trim()
  .min(20, "The API token looks too short")
  .max(5000, "The API token is too long")
  .regex(/^\S+$/, "The API token must not contain spaces");

const label = z.string().trim().min(1, "Label must not be empty").max(100, "Label must not exceed 100 characters");

export const createSolidtimeConnectionSchema = z.object({
  baseUrl: solidtimeUrlSchema,
  token: solidtimeTokenSchema,
  label: label.optional(),
});

const uuid = z.string().uuid();

export const updateSolidtimeConnectionSchema = z
  .object({
    label: label.nullable().optional(),
    token: solidtimeTokenSchema.optional(),
    organizationId: uuid.optional(),
    azureCredentialId: uuid.nullable().optional(),
    /** Azure project name -> Solidtime project id. */
    projectMap: z
      .record(z.string().trim().min(1).max(200), uuid)
      .refine((map) => Object.keys(map).length <= 500, "Too many project mappings")
      .transform((map) => Object.fromEntries(Object.entries(map).map(([name, id]) => [name.toLowerCase(), id])))
      .optional(),
    dailyTargetHours: z.number().min(0.5).max(24).optional(),
    timerAlertHours: z.number().min(1).max(48).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "Nothing to change" });

/** A local calendar day. */
export const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a day like 2026-10-27")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    // 2026-02-31 parses as March 3rd; a real day reads back the same.
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Not a real day");

/** At most 31 days; to defaults to from. */
export const dayRangeQuerySchema = z
  /** `day`: list only that day's entries (totals still cover from–to). */
  .object({ from: daySchema, to: daySchema.optional(), day: daySchema.optional(), page: pageQuery, ticketPage: pageQuery })
  .transform((value) => ({ ...value, to: value.to ?? value.from }))
  .refine((value) => value.to >= value.from, { message: "The end day is before the start day", path: ["to"] })
  .refine((value) => value.day === undefined || (value.day >= value.from && value.day <= value.to), { message: "The day is outside the period", path: ["day"] })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 31, { message: "Choose at most 31 days", path: ["to"] });

export const ticketIdParamSchema = z.coerce.number().int().positive().max(2_147_483_647);

export const ticketIdsQuerySchema = z.object({
  ids: z
    .string()
    .regex(/^\d+(,\d+)*$/, "ids must be comma-separated numbers")
    .transform((value) => [...new Set(value.split(",").map(Number))])
    .refine((ids) => ids.length <= 200, "At most 200 tickets at once"),
});

export const draftQuerySchema = z.object({ day: daySchema });

/** Which drafted rows the AI should estimate, and the hours already planned on the other rows of that draft. */
export const draftEstimateBodySchema = z.object({
  day: daySchema,
  ticketIds: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(50).transform((ids) => [...new Set(ids)]),
  plannedHours: z.number().min(0).max(24).default(0),
  /** When the other rows are planned (only used to avoid placing AI rows on top of them). */
  planned: z
    .array(z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }).refine((slot) => Date.parse(slot.end) > Date.parse(slot.start), "The end is before the start"))
    .max(50)
    .optional(),
});

export const accuracyQuerySchema = z
  .object({ from: daySchema, to: daySchema, personPage: pageQuery, typePage: pageQuery, ticketPage: pageQuery })
  .refine((value) => value.to >= value.from, { message: "The end day is before the start day", path: ["to"] })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 366, { message: "Choose at most a year", path: ["to"] });

/** Time → Verify: the tickets I logged time on between two days (at most a year). ?refresh=true reads Azure fresh. */
export const verificationQuerySchema = z
  .object({ from: daySchema, to: daySchema, refresh: booleanFlag })
  .refine((value) => value.to >= value.from, { message: "The end day is before the start day", path: ["to"] })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 366, { message: "Choose at most a year", path: ["to"] });

/** The time export: every day from `from` to `to` (at most a year). */
export const timeCsvQuerySchema = z
  .object({ from: daySchema, to: daySchema })
  .refine((value) => value.to >= value.from, { message: "The end day is before the start day", path: ["to"] })
  .refine((value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 <= 366, { message: "Choose at most a year", path: ["to"] });

export const catalogPageQuerySchema = z.object({ page: pageQuery, projectId: uuid.optional().catch(undefined) });
