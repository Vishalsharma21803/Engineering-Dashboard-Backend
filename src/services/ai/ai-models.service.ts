import { CLAUDE_MODELS } from "../../lib/ai/claude.js";
import { listOpenCodeModels } from "../../lib/ai/opencode.js";
import { listOpenRouterModels } from "../../lib/ai/openrouter.js";
import type { AiModelOption, AiProvider } from "../../lib/ai/types.js";
import { prisma } from "../../lib/prisma.js";

export const OPENROUTER_ALLOWLIST_KEY = "openrouter.modelAllowlist";

/** Empty list = every OpenRouter model that supports schema-checked JSON. */
export async function getOpenRouterAllowlist(): Promise<string[]> {
  const setting = await prisma.appSetting.findUnique({ where: { key: OPENROUTER_ALLOWLIST_KEY } });
  const value = setting?.value;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function setOpenRouterAllowlist(modelIds: string[], updatedBy: string): Promise<string[]> {
  const unique = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))].sort();

  await prisma.appSetting.upsert({
    where: { key: OPENROUTER_ALLOWLIST_KEY },
    create: { key: OPENROUTER_ALLOWLIST_KEY, value: unique, updatedBy },
    update: { value: unique, updatedBy },
  });

  return unique;
}

export async function listModels(
  provider: AiProvider,
  openRouterKey: string | null
): Promise<AiModelOption[]> {
  if (provider === "CLAUDE") {
    return CLAUDE_MODELS;
  }

  if (provider === "OPENCODE") {
    return listOpenCodeModels();
  }

  const [models, allowlist] = await Promise.all([
    listOpenRouterModels(openRouterKey),
    getOpenRouterAllowlist(),
  ]);

  return allowlist.length === 0 ? models : models.filter((model) => allowlist.includes(model.id));
}

export async function findModel(
  provider: AiProvider,
  modelId: string,
  openRouterKey: string | null
): Promise<AiModelOption | null> {
  const models = await listModels(provider, openRouterKey);
  return models.find((model) => model.id === modelId) ?? null;
}
