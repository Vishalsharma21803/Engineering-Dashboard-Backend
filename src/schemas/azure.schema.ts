import { z } from "zod";

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

const booleanFlag = z
  .enum(["1", "0", "true", "false"])
  .optional()
  .transform((value) => value === "1" || value === "true");

export const refreshQuerySchema = z.object({ refresh: booleanFlag });

export const dashboardQuerySchema = z.object({
  projectId: azureProjectIdSchema.optional(),
});

export const workItemsQuerySchema = z.object({
  projectId: azureProjectIdSchema.optional(),
  state: z.enum(["open", "all"]).default("open"),
});

export const pullRequestsQuerySchema = z.object({
  projectId: azureProjectIdSchema.optional(),
  role: z.enum(["author", "reviewer", "all"]).default("all"),
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
