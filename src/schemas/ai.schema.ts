import { z } from "zod";

export const aiProviderSchema = z.enum(["CLAUDE", "OPENROUTER", "OPENCODE"]);
export const aiEffortSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

const KEY_PREFIX: Record<z.infer<typeof aiProviderSchema>, string> = {
  CLAUDE: "sk-ant-",
  OPENROUTER: "sk-or-",
  // OpenCode does not document a key format.
  OPENCODE: "",
};

const apiKeySchema = z
  .string()
  .trim()
  .min(20, "API key is too short")
  .max(300, "API key must not exceed 300 characters")
  .regex(/^\S+$/, "API key must not contain whitespace");

const labelSchema = z.string().trim().min(1, "Label must not be empty").max(100, "Label must not exceed 100 characters");

export const createAiCredentialSchema = z
  .object({
    provider: aiProviderSchema,
    apiKey: apiKeySchema,
    label: labelSchema.optional(),
  })
  .strict()
  .refine((input) => input.apiKey.startsWith(KEY_PREFIX[input.provider]), {
    message: "This doesn't look like a key for the selected provider",
    path: ["apiKey"],
  });

export const updateAiCredentialSchema = z
  .object({
    apiKey: apiKeySchema.optional(),
    label: labelSchema.nullable().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, { message: "Nothing to update", path: ["body"] });

export const aiCredentialIdSchema = z.string().uuid("Invalid AI key id");

export const modelsQuerySchema = z.object({ provider: aiProviderSchema });

export const updateAiPreferenceSchema = z
  .object({
    provider: aiProviderSchema.nullable(),
    model: z.string().trim().min(1).max(200).nullable(),
    effort: aiEffortSchema,
    dailyLimitUsd: z.number().finite().min(0).max(100),
    acceptDataCollection: z.boolean(),
  })
  .strict();

export const openRouterAllowlistSchema = z
  .object({
    modelIds: z.array(z.string().trim().min(1).max(200)).max(200),
  })
  .strict();
