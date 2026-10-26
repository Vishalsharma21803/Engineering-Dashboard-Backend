import type { AiModelOption } from "./types.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cache writes bill at 1.25x input; cache reads at the model's cache rate (or 10% of input). */
export function estimateCostUsd(model: AiModelOption, usage: TokenUsage): number {
  const cacheRead = model.cacheReadPerMTok ?? model.inputPerMTok * 0.1;
  const cost =
    (usage.inputTokens * model.inputPerMTok +
      usage.cacheWriteTokens * model.inputPerMTok * 1.25 +
      usage.cacheReadTokens * cacheRead +
      usage.outputTokens * model.outputPerMTok) /
    1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}
