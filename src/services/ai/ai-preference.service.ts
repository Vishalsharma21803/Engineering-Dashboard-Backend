import { AppError } from "../../lib/app-error.js";
import type { AiEffort, AiProvider } from "../../lib/ai/types.js";
import { prisma } from "../../lib/prisma.js";
import { getAiApiKey } from "./ai-credential.service.js";
import { findModel } from "./ai-models.service.js";

export const DEFAULT_DAILY_LIMIT_USD = 2;

const preferenceSelect = {
  provider: true,
  model: true,
  effort: true,
  dailyLimitUsd: true,
  dataCollectionAcceptedAt: true,
  updatedAt: true,
} as const;

export async function getAiPreference(userId: string) {
  const preference = await prisma.aiPreference.findUnique({ where: { userId }, select: preferenceSelect });

  return (
    preference ?? {
      provider: null,
      model: null,
      effort: "MEDIUM" as const,
      dailyLimitUsd: DEFAULT_DAILY_LIMIT_USD,
      dataCollectionAcceptedAt: null,
      updatedAt: null,
    }
  );
}

export interface UpdateAiPreferenceInput {
  provider: AiProvider | null;
  model: string | null;
  effort: AiEffort;
  dailyLimitUsd: number;
  /** true = I accept that the chosen model's providers may store or train on ticket text. */
  acceptDataCollection: boolean;
}

/**
 * Validates the choice against the live model list: the user must hold a
 * key for the provider, the model must be offered, the effort supported,
 * and data-collecting (free) models need explicit consent.
 */
export async function updateAiPreference(userId: string, input: UpdateAiPreferenceInput) {
  const current = await getAiPreference(userId);
  const consentAt = input.acceptDataCollection ? (current.dataCollectionAcceptedAt ?? new Date()) : null;

  if (input.provider !== null) {
    if (input.model === null) {
      throw new AppError(422, "AI_MODEL_REQUIRED", "Choose a model for this provider");
    }

    const apiKey = await getAiApiKey(userId, input.provider);

    if (!apiKey) {
      throw new AppError(422, "AI_KEY_REQUIRED", "Add an API key for this provider first");
    }

    const model = await findModel(input.provider, input.model, input.provider === "OPENROUTER" ? apiKey : null);

    if (!model) {
      throw new AppError(422, "AI_MODEL_NOT_OFFERED", "This model is not available in Cockpit");
    }

    if (model.efforts.length > 0 && !model.efforts.includes(input.effort)) {
      throw new AppError(422, "AI_EFFORT_NOT_SUPPORTED", `${model.label} does not support ${input.effort.toLowerCase()} effort`);
    }

    if (model.mayCollectData && !input.acceptDataCollection) {
      throw new AppError(
        422,
        "DATA_COLLECTION_NOT_ACCEPTED",
        "This model's providers may store or train on ticket text. Accept the data notice to use it."
      );
    }
  }

  return prisma.aiPreference.upsert({
    where: { userId },
    create: {
      userId,
      provider: input.provider,
      model: input.provider === null ? null : input.model,
      effort: input.effort,
      dailyLimitUsd: input.dailyLimitUsd,
      dataCollectionAcceptedAt: consentAt,
    },
    update: {
      provider: input.provider,
      model: input.provider === null ? null : input.model,
      effort: input.effort,
      dailyLimitUsd: input.dailyLimitUsd,
      dataCollectionAcceptedAt: consentAt,
    },
    select: preferenceSelect,
  });
}
