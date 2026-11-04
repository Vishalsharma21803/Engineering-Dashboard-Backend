import { z } from "zod";

import { MAX_CONTENT_LENGTH } from "../services/sop/rulebook.parser.js";
import { azureProjectIdSchema } from "./azure.schema.js";

const content = z.string().max(MAX_CONTENT_LENGTH, `Rulebook must not exceed ${MAX_CONTENT_LENGTH} characters`);

export const saveDefaultRulebookSchema = z
  .object({ content: content.min(1, "Rulebook must not be empty"), note: z.string().trim().max(200).optional() })
  .strict();

export const savePersonalRulebookSchema = z.object({ content }).strict();

export const validateRulebookSchema = z
  .object({ content, scope: z.enum(["default", "personal"]) })
  .strict();

export const versionParamSchema = z.coerce.number().int().min(0);

export const testRulesSchema = z
  .object({
    projectId: z.string().trim().min(1).max(200),
    workItemId: z.number().int().positive(),
    draft: z.object({ scope: z.enum(["default", "personal"]), content }).strict().optional(),
  })
  .strict();

// Shared by queueing and reading AI checks (the page sends one id); matches MAX_CHECKS_PER_REQUEST.
const workItemIds = z.array(z.number().int().positive()).min(1).max(50);

export const aiCheckSchema = z.object({ workItemIds, force: z.boolean().default(false) }).strict();

export const aiResultsQuerySchema = z.object({
  ids: z
    .string()
    .regex(/^\d+(,\d+)*$/, "ids must be comma-separated ticket numbers")
    .transform((value) => value.split(",").map(Number))
    .pipe(workItemIds),
});

export const projectNameParamSchema = azureProjectIdSchema;

export const saveProjectSetUpSchema = z.object({ settings: z.unknown() }).strict();

export const projectCheckedSchema = z.object({ checked: z.boolean() }).strict();
