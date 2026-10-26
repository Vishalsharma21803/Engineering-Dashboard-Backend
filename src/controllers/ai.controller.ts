import type { Request, Response } from "express";
import type { z } from "zod";

import {
  aiCredentialIdSchema,
  createAiCredentialSchema,
  modelsQuerySchema,
  openRouterAllowlistSchema,
  updateAiCredentialSchema,
  updateAiPreferenceSchema,
} from "../schemas/ai.schema.js";
import {
  createAiCredential,
  deleteAiCredential,
  getAiApiKey,
  listAiCredentials,
  updateAiCredential,
  validateAiCredential,
} from "../services/ai/ai-credential.service.js";
import { listOpenRouterModels } from "../lib/ai/openrouter.js";
import { getOpenRouterAllowlist, listModels, setOpenRouterAllowlist } from "../services/ai/ai-models.service.js";
import { getAiPreference, updateAiPreference } from "../services/ai/ai-preference.service.js";
import { getUsageSummary } from "../services/ai/ai-usage.service.js";
import { sendError, sendValidationError } from "./controller-helpers.js";

class RequestValidationError extends Error {
  constructor(readonly zodError: z.ZodError) {
    super("Validation failed");
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new RequestValidationError(result.error);
  }

  return result.data;
}

/** Every AI route: require a session, validate, run, map errors. */
function aiRoute(label: string, status: number, handler: (req: Request, userId: string) => Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    try {
      res.status(status).json(await handler(req, req.userId));
    } catch (error) {
      if (error instanceof RequestValidationError) {
        sendValidationError(res, error.zodError);
        return;
      }

      await sendError(res, error, label);
    }
  };
}

export const listAiCredentialsController = aiRoute("Listing AI keys failed", 200, async (_req, userId) => ({
  credentials: await listAiCredentials(userId),
}));

export const createAiCredentialController = aiRoute("Saving AI key failed", 201, async (req, userId) => ({
  message: "AI key saved",
  credential: await createAiCredential(userId, parse(createAiCredentialSchema, req.body)),
}));

export const updateAiCredentialController = aiRoute("Updating AI key failed", 200, async (req, userId) => ({
  message: "AI key updated",
  credential: await updateAiCredential(
    userId,
    parse(aiCredentialIdSchema, req.params.id),
    parse(updateAiCredentialSchema, req.body ?? {})
  ),
}));

export const deleteAiCredentialController = aiRoute("Deleting AI key failed", 200, async (req, userId) => {
  await deleteAiCredential(userId, parse(aiCredentialIdSchema, req.params.id));
  return { message: "AI key deleted" };
});

export const validateAiCredentialController = aiRoute("Validating AI key failed", 200, async (req, userId) =>
  validateAiCredential(userId, parse(aiCredentialIdSchema, req.params.id))
);

export const listModelsController = aiRoute("Listing AI models failed", 200, async (req, userId) => {
  const { provider } = parse(modelsQuerySchema, req.query);
  const key = provider === "OPENROUTER" ? await getAiApiKey(userId, provider) : null;
  return { models: await listModels(provider, key) };
});

export const getAiPreferenceController = aiRoute("Loading AI settings failed", 200, async (_req, userId) => ({
  preference: await getAiPreference(userId),
}));

export const updateAiPreferenceController = aiRoute("Saving AI settings failed", 200, async (req, userId) => ({
  message: "AI settings saved",
  preference: await updateAiPreference(userId, parse(updateAiPreferenceSchema, req.body)),
}));

export const getAiUsageController = aiRoute("Loading AI usage failed", 200, async (_req, userId) => ({
  usage: await getUsageSummary(userId),
}));

/** The allowlist plus the full JSON-capable catalog, so owners can add models that are not yet allowed. */
export const getOpenRouterAllowlistController = aiRoute("Loading model allowlist failed", 200, async (_req, userId) => ({
  modelIds: await getOpenRouterAllowlist(),
  models: await listOpenRouterModels(await getAiApiKey(userId, "OPENROUTER")),
}));

export const setOpenRouterAllowlistController = aiRoute("Saving model allowlist failed", 200, async (req, userId) => ({
  message: "Model allowlist saved",
  modelIds: await setOpenRouterAllowlist(parse(openRouterAllowlistSchema, req.body).modelIds, userId),
}));
