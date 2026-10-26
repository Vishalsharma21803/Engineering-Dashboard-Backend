import { z } from "zod";

import { ITEM_KINDS, SOP_STAGES, type ItemKind, type ProjectProfile, type SopStage } from "./rulebook.types.js";

export const DEFAULT_WORK_ITEM_TYPES: Record<ItemKind, string[]> = {
  story: ["User Story", "Product Backlog Item", "Requirement"],
  task: ["Task"],
  bug: ["Bug"],
  feature: ["Feature"],
  epic: ["Epic"],
  impediment: ["Issue", "Impediment"],
};

export const DEFAULT_BRANCH_PATTERN = "^(feature|bugfix|hotfix)/[A-Za-z]*-?{id}-[a-z0-9]+(-[a-z0-9]+)*$";

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const name = z.string().trim().min(1).max(100);
const stateList = z.array(name).max(50);

/** Categories offered when a project is set up; they can be edited per project. */
export const DEFAULT_CATEGORIES: Record<string, string> = {
  Development: "Writing or changing application code, including bug fixes and refactoring.",
  Deployment: "Releasing, pipelines, environments, infrastructure and configuration changes.",
  Design: "UI/UX design, technical design or architecture work before implementation.",
  Documentation: "Writing or updating documentation, guides, READMEs or runbooks.",
  Requirements: "Analysing scope, clarifying requirements, writing stories or acceptance criteria.",
  Testing: "Writing or running tests, QA verification and test evidence.",
};

/** A project's SOP set-up as stored and sent over the API (camelCase JSON). */
export const projectSettingsSchema = z
  .object({
    stageSource: z.enum(["state", "board_column"]).default("state"),
    stages: z
      .partialRecord(z.enum(SOP_STAGES), stateList)
      .default({})
      .refine(
        (stages) => {
          const all = Object.values(stages).flat().map((state) => state.toLowerCase());
          return new Set(all).size === all.length;
        },
        { message: "A state can belong to only one SOP stage" }
      ),
    roles: z
      .object({ tl: z.array(name).max(50).default([]), qa: z.array(name).max(50).default([]), po: z.array(name).max(50).default([]) })
      .strict()
      .default({ tl: [], qa: [], po: [] }),
    fields: z
      .object({
        category: z.string().trim().max(200).nullable().default(null),
        targetCompletion: z.string().trim().max(200).nullable().default(null),
      })
      .strict()
      .default({ category: null, targetCompletion: null }),
    categories: z.record(name, z.string().trim().max(500)).default({}),
    workItemTypes: z.partialRecord(z.enum(ITEM_KINDS), z.array(name).max(20)).default({}),
    tagVocabulary: z.array(name).max(200).default([]),
    branchPattern: z
      .string()
      .max(200)
      .nullable()
      .default(DEFAULT_BRANCH_PATTERN)
      .refine((pattern) => {
        if (pattern === null) return true;
        try {
          new RegExp(pattern.replaceAll("{id}", "1"));
          return true;
        } catch {
          return false;
        }
      }, "branchPattern is not a valid regular expression"),
    prTargetBranch: z.string().trim().max(200).nullable().default("develop"),
    timeZone: z.string().refine(isTimeZone, "timeZone must be an IANA name such as UTC or Asia/Kolkata").default("UTC"),
  })
  .strict();

export type ProjectSettings = z.output<typeof projectSettingsSchema>;

/** The shape the SOP checks use. */
export function profileFromSettings(projectName: string, settings: ProjectSettings): ProjectProfile {
  return {
    project: projectName,
    stageSource: settings.stageSource,
    stages: Object.fromEntries(SOP_STAGES.map((stage) => [stage, settings.stages[stage] ?? []])) as Record<SopStage, string[]>,
    roles: settings.roles,
    fields: settings.fields,
    categories: settings.categories,
    workItemTypes: Object.fromEntries(
      ITEM_KINDS.map((kind) => [kind, settings.workItemTypes[kind] ?? DEFAULT_WORK_ITEM_TYPES[kind]])
    ) as Record<ItemKind, string[]>,
    tagVocabulary: settings.tagVocabulary,
    branchPattern: settings.branchPattern,
    prTargetBranch: settings.prTargetBranch,
    timeZone: settings.timeZone,
    line: 0,
  };
}

const clean = (values: string[], max = 100) => [...new Set(values.map((value) => value.trim().slice(0, max)).filter(Boolean))];

/**
 * Settings from an old rulebook `kind: project` block, tidied to today's rules:
 * states named like "Estimation(s)" under ready move to the new estimation stage,
 * a state listed under two stages keeps its first (earliest) stage, empty names
 * are dropped and over-long texts are shortened. Null when it still is not valid.
 */
export function settingsFromLegacyProfile(profile: ProjectProfile): ProjectSettings | null {
  const stages = Object.fromEntries(SOP_STAGES.map((stage) => [stage, clean(profile.stages[stage])])) as Record<SopStage, string[]>;
  const estimating = stages.ready.filter((state) => /^estimat/i.test(state));

  if (estimating.length > 0 && stages.estimation.length === 0) {
    stages.ready = stages.ready.filter((state) => !estimating.includes(state));
    stages.estimation = estimating;
  }

  const seen = new Set<string>();

  for (const stage of SOP_STAGES) {
    stages[stage] = stages[stage].filter((state) => {
      const key = state.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const result = projectSettingsSchema.safeParse({
    stageSource: profile.stageSource,
    stages: Object.fromEntries(Object.entries(stages).filter(([, states]) => states.length > 0)),
    roles: { tl: clean(profile.roles.tl), qa: clean(profile.roles.qa), po: clean(profile.roles.po) },
    fields: profile.fields,
    categories: Object.fromEntries(
      Object.entries(profile.categories)
        .map(([name, meaning]) => [name.trim().slice(0, 100), String(meaning ?? "").trim().slice(0, 500)])
        .filter(([name]) => name)
    ),
    workItemTypes: Object.fromEntries(Object.entries(profile.workItemTypes).map(([kind, types]) => [kind, clean(types)])),
    tagVocabulary: clean(profile.tagVocabulary).slice(0, 200),
    branchPattern: profile.branchPattern,
    prTargetBranch: profile.prTargetBranch,
    timeZone: profile.timeZone,
  });

  return result.success ? result.data : null;
}
