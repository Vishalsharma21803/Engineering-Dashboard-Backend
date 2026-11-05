import { AppError } from "../../lib/app-error.js";
import type { AzureClient } from "../../lib/azure/client.js";
import { prisma } from "../../lib/prisma.js";
import type { StateCategory } from "../../types/azure.types.js";
import { stripRefPrefix } from "../azure/mappers.js";
import { listRepositories } from "../azure/repositories.service.js";
import { getWorkItemTypeFieldNames, getWorkItemTypeStates, listWorkItemTypeNames, WORK_ITEM_FIELDS } from "../azure/work-items.service.js";
import {
  DEFAULT_BRANCH_PATTERN,
  DEFAULT_CATEGORIES,
  DEFAULT_WORK_ITEM_TYPES,
  profileFromSettings,
  projectSettingsSchema,
  settingsFromLegacyProfile,
  type ProjectSettings,
} from "./project-settings.js";
import { blockSpans, parseRulebook } from "./rulebook.parser.js";
import { ITEM_KINDS, SOP_STAGES, type ProjectProfile, type SopStage } from "./rulebook.types.js";
import { STARTER_PROJECT_BLOCKS } from "./starter-rulebook.js";
import { logFallback } from "../../lib/log-fallback.js";

const MOVED_KEY = "sop.projectsMovedFromRulebook";
/** Estimate-type rules that are checked once a ticket is estimated, not before work starts. */
const ESTIMATION_RULES = new Set(["STR-04", "STR-05", "STR-14"]);

export const nameKeyOf = (projectName: string) => projectName.trim().toLowerCase();

/* ------------------------------------------------------- one-time move */

export interface MovedRulebook {
  content: string;
  /** Valid project blocks, as set-ups to create. */
  imports: Array<{ projectName: string; settings: ProjectSettings }>;
  /** Project blocks that could not be read; they stay in the text so nothing is lost silently. */
  kept: string[];
  changed: boolean;
}

/**
 * Takes valid project blocks out of the rulebook text (as set-ups) and re-times the
 * estimate rules to Estimations. Blocks that cannot be imported stay in the text,
 * where the editor points to the Projects tab for them.
 */
export function moveProjectsOutOfRulebook(content: string): MovedRulebook {
  const { lines, spans } = blockSpans(content);
  const drop = new Set<number>();
  const edits = new Map<number, string>();
  const imports: MovedRulebook["imports"] = [];
  const kept: string[] = [];
  const importedKeys = new Set<string>();

  for (const span of spans) {
    if (span.header?.kind === "project") {
      const text = lines.slice(span.start, span.end).join("\n");
      const profile = parseRulebook(text, "default", { legacyProjects: true }).projects[0];
      const settings = profile ? settingsFromLegacyProfile(profile) : null;
      const name = profile?.project ?? String(span.header.project ?? "(unnamed)");

      if (!profile || !settings || importedKeys.has(nameKeyOf(profile.project))) {
        kept.push(name);
        continue;
      }

      importedKeys.add(nameKeyOf(profile.project));
      imports.push({ projectName: profile.project, settings });
      for (let line = span.start; line < span.end; line += 1) drop.add(line);
      continue;
    }

    if (typeof span.header?.id === "string" && ESTIMATION_RULES.has(span.header.id) && span.header.when === "before-active") {
      for (let line = span.start + 1; line < span.end; line += 1) {
        const text = lines[line] ?? "";

        if (/^\s*when:\s*["']?before-active["']?\s*(#.*)?$/.test(text)) {
          edits.set(line, text.replace(/(["']?)before-active\1/, "at-estimation"));
          break;
        }
      }
    }
  }

  const next = lines.flatMap((line, index) => (drop.has(index) ? [] : [edits.get(index) ?? line])).join("\n");
  return { content: next, imports, kept, changed: next !== lines.join("\n") };
}

/**
 * Projects used to be `kind: project` blocks inside the default rulebook. The
 * first time project set-ups are needed, those blocks become set-ups and a new
 * rulebook version without them is saved (recorded with a note). Runs once; a
 * block that cannot be imported never blocks the app (it stays in the text).
 */
export async function ensureProjectsMoved(): Promise<void> {
  if (await prisma.appSetting.findUnique({ where: { key: MOVED_KEY }, select: { key: true } })) {
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // The unique key doubles as a lock: a second server doing the same move fails here and rolls back.
      await tx.appSetting.create({ data: { key: MOVED_KEY, value: { movedAt: new Date().toISOString() }, updatedBy: null } });

      const latest = await tx.rulebook.findFirst({ orderBy: { version: "desc" } });
      const moved = moveProjectsOutOfRulebook(latest?.content ?? STARTER_PROJECT_BLOCKS);

      for (const { projectName, settings } of moved.imports) {
        const nameKey = nameKeyOf(projectName);

        if (await tx.sopProject.findUnique({ where: { nameKey }, select: { id: true } })) {
          continue;
        }

        const created = await tx.sopProject.create({
          data: { nameKey, projectName, settings: settings as object, createdBy: null, updatedBy: null },
        });
        await tx.sopProjectChange.create({
          data: { sopProjectId: created.id, projectName, kind: "IMPORTED", settings: settings as object, changedBy: null },
        });
      }

      if (latest && moved.changed) {
        const keptNote = moved.kept.length ? ` Could not move: ${moved.kept.join(", ")} (set them up on the Projects tab, then delete their blocks).` : "";
        await tx.rulebook.create({
          data: {
            version: latest.version + 1,
            content: moved.content,
            note: `Projects moved to the Projects tab; estimate, time and due-date rules now checked at Estimations.${keptNote}`.slice(0, 500),
            createdBy: null,
          },
        });
      }
    });
  } catch (error) {
    // Another process did (or is doing) the move.
    if (await prisma.appSetting.findUnique({ where: { key: MOVED_KEY }, select: { key: true } })) {
      return;
    }

    // Never take the SOP pages down: log, carry on with the set-ups that exist, retry next time.
    console.error("Moving SOP projects out of the rulebook failed; will retry:", error);
  }
}

/* ------------------------------------------------------------ set-ups */

export interface ProjectSetUp {
  projectName: string;
  settings: ProjectSettings;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Whether the viewer may change or remove it: its creator or an SOP owner. */
  canEdit: boolean;
}

/** Who is looking at set-ups, for `canEdit`. */
export interface SetUpViewer {
  userId: string;
  isAdmin: boolean;
}

/** Set-ups imported from the old rulebook have no creator: only SOP owners may change them. */
const mayChange = (createdBy: string | null, viewer: SetUpViewer) => viewer.isAdmin || (createdBy !== null && createdBy === viewer.userId);

function assertMayChange(createdBy: string | null, viewer: SetUpViewer): void {
  if (!mayChange(createdBy, viewer)) {
    throw new AppError(
      403,
      "PROJECT_SETUP_NOT_YOURS",
      createdBy === null
        ? "Only an SOP owner can change this project's set-up (it was set up before owners were recorded)"
        : "Only the person who set up this project or an SOP owner can change it"
    );
  }
}

const isUniqueConstraintError = (error: unknown) => (error as { code?: unknown } | null)?.code === "P2002";

async function userNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  const users = unique.length ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
  return new Map(users.map((user) => [user.id, user.name]));
}

function readSettings(value: unknown): ProjectSettings {
  // Stored settings were validated on save; parsing again applies defaults added later.
  return projectSettingsSchema.parse(value);
}

/** Every set-up; `canEdit` is false for all when no viewer is given. */
export async function listProjectSetUps(viewer?: SetUpViewer): Promise<ProjectSetUp[]> {
  await ensureProjectsMoved();
  const rows = await prisma.sopProject.findMany({ orderBy: { projectName: "asc" } });
  const names = await userNames(rows.flatMap((row) => [row.createdBy, row.updatedBy]));

  return rows.map((row) => ({
    projectName: row.projectName,
    settings: readSettings(row.settings),
    createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    updatedBy: row.updatedBy ? (names.get(row.updatedBy) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canEdit: viewer ? mayChange(row.createdBy, viewer) : false,
  }));
}

/**
 * Profiles the SOP checks use. A user's own checks skip projects they switched
 * off; team reports use every set-up project.
 */
export async function getProjectProfiles(userId: string | null): Promise<{ profiles: ProjectProfile[]; switchedOff: string[] }> {
  await ensureProjectsMoved();
  const [rows, exclusions] = await Promise.all([
    prisma.sopProject.findMany({ select: { id: true, projectName: true, settings: true } }),
    userId ? prisma.sopProjectExclusion.findMany({ where: { userId }, select: { sopProjectId: true } }) : Promise.resolve([]),
  ]);
  const off = new Set(exclusions.map((row) => row.sopProjectId));

  return {
    profiles: rows.filter((row) => !off.has(row.id)).map((row) => profileFromSettings(row.projectName, readSettings(row.settings))),
    switchedOff: rows.filter((row) => off.has(row.id)).map((row) => row.projectName),
  };
}

/** The shared set-up of one project (no user filter): for facts such as its Testing stage or category field. */
export async function getSharedProjectProfile(projectName: string): Promise<ProjectProfile | null> {
  await ensureProjectsMoved();
  const row = await prisma.sopProject.findUnique({ where: { nameKey: nameKeyOf(projectName) } });
  return row ? profileFromSettings(row.projectName, readSettings(row.settings)) : null;
}

/**
 * Anyone may set a new project up; only its creator or an SOP owner may change
 * it later. Every change is recorded. The branch pattern is a regular
 * expression run in everyone's checks, so only SOP owners may change it (others
 * keep the current one).
 */
export async function saveProjectSetUp(
  userId: string,
  projectName: string,
  input: unknown,
  options: { canSetBranchPattern: boolean; isAdmin: boolean }
): Promise<ProjectSetUp> {
  await ensureProjectsMoved();
  const requested = projectSettingsSchema.parse(input);
  const nameKey = nameKeyOf(projectName);
  const viewer = { userId, isAdmin: options.isAdmin };

  const save = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.sopProject.findUnique({ where: { nameKey }, select: { id: true, settings: true, createdBy: true } });

      if (existing) {
        assertMayChange(existing.createdBy, viewer);
      }

      const settings: ProjectSettings = options.canSetBranchPattern
        ? requested
        : { ...requested, branchPattern: existing ? readSettings(existing.settings).branchPattern : DEFAULT_BRANCH_PATTERN };
      const saved = existing
        ? await tx.sopProject.update({ where: { nameKey }, data: { settings: settings as object, updatedBy: userId, projectName: projectName.trim() } })
        : await tx.sopProject.create({ data: { nameKey, projectName: projectName.trim(), settings: settings as object, createdBy: userId, updatedBy: userId } });

      await tx.sopProjectChange.create({
        data: { sopProjectId: saved.id, projectName: saved.projectName, kind: existing ? "UPDATED" : "CREATED", settings: settings as object, changedBy: userId },
      });
    });

  try {
    await save();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    // Someone else set the same project up at the same moment: run again, now as a change to theirs (owner check included).
    await save();
  }

  const saved = (await listProjectSetUps(viewer)).find((setUp) => nameKeyOf(setUp.projectName) === nameKey);

  if (!saved) {
    throw new AppError(500, "PROJECT_SAVE_FAILED", "The project set-up could not be read back");
  }

  return saved;
}

/** Removes a set-up for everyone (its history stays). Only its creator or an SOP owner may. */
export async function removeProjectSetUp(userId: string, projectName: string, options: { isAdmin: boolean }): Promise<void> {
  await ensureProjectsMoved();
  const nameKey = nameKeyOf(projectName);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.sopProject.findUnique({ where: { nameKey } });

    if (!existing) {
      throw new AppError(404, "PROJECT_NOT_SET_UP", "This project is not set up for SOP checks");
    }

    assertMayChange(existing.createdBy, { userId, isAdmin: options.isAdmin });

    await tx.sopProjectChange.create({
      data: { sopProjectId: null, projectName: existing.projectName, kind: "REMOVED", settings: existing.settings as object, changedBy: userId },
    });
    await tx.sopProject.delete({ where: { nameKey } });
  });
}

export async function listProjectChanges(projectName: string) {
  const rows = await prisma.sopProjectChange.findMany({
    where: { projectName: { equals: projectName.trim(), mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const names = await userNames(rows.map((row) => row.changedBy));

  return rows.map((row) => ({
    kind: row.kind,
    changedBy: row.changedBy ? (names.get(row.changedBy) ?? "Unknown user") : "Relay",
    createdAt: row.createdAt.toISOString(),
  }));
}

/** A user's own on/off switch for a set-up project (all are on by default). */
export async function setProjectIncluded(userId: string, projectName: string, included: boolean): Promise<void> {
  await ensureProjectsMoved();
  const project = await prisma.sopProject.findUnique({ where: { nameKey: nameKeyOf(projectName) }, select: { id: true } });

  if (!project) {
    throw new AppError(404, "PROJECT_NOT_SET_UP", "Set this project up before choosing whether to check it");
  }

  if (included) {
    await prisma.sopProjectExclusion.deleteMany({ where: { userId, sopProjectId: project.id } });
  } else {
    await prisma.sopProjectExclusion.upsert({
      where: { userId_sopProjectId: { userId, sopProjectId: project.id } },
      create: { userId, sopProjectId: project.id },
      update: {},
    });
  }
}

/* ---------------------------------------------------- Azure suggestions */

const STAGE_BY_CATEGORY: Partial<Record<StateCategory, SopStage>> = {
  Proposed: "ready",
  InProgress: "active",
  Resolved: "review",
  Completed: "done",
};

/** A sensible SOP stage for a state: its name first (Estimations, Review, Testing, QA, UAT), then Azure's category. */
export function suggestStage(state: string, category: StateCategory): SopStage | null {
  if (/estimat/i.test(state)) return "estimation";
  if (/\buat\b|acceptance/i.test(state)) return "uat";
  if (/\bqa\b|quality/i.test(state)) return "qa";
  if (/test/i.test(state)) return "testing";
  if (/review/i.test(state)) return "review";
  return STAGE_BY_CATEGORY[category] ?? null;
}

export interface ProjectSuggestion {
  /** Every state of the project's work item types, with Azure's category. */
  states: Array<{ name: string; category: StateCategory; types: string[] }>;
  /** Fields found on the project's types that can serve as Category / Target completion. */
  fieldCandidates: { category: string[]; targetCompletion: string[] };
  /** Pre-filled settings: the existing set-up if there is one, otherwise a suggestion from Azure. */
  settings: ProjectSettings;
  setUp: boolean;
}

/** Reads the project from Azure (read-only) to pre-fill its set-up form. */
export async function suggestProjectSetUp(client: AzureClient, projectName: string, projectId: string): Promise<ProjectSuggestion> {
  const knownTypes = new Set(ITEM_KINDS.flatMap((kind) => DEFAULT_WORK_ITEM_TYPES[kind]));
  const typeNames = (await listWorkItemTypeNames(client, projectName)).filter((type) => knownTypes.has(type));
  const perType = await Promise.all(
    typeNames.map(async (type) => ({
      type,
      states: await getWorkItemTypeStates(client, projectName, type),
      fields: await getWorkItemTypeFieldNames(client, projectName, type),
    }))
  );

  const states = new Map<string, { name: string; category: StateCategory; types: string[] }>();

  for (const entry of perType) {
    for (const state of entry.states) {
      const existing = states.get(state.name.toLowerCase()) ?? { name: state.name, category: state.category, types: [] };
      existing.types.push(entry.type);
      states.set(state.name.toLowerCase(), existing);
    }
  }

  const allFields = new Set(perType.flatMap((entry) => [...entry.fields]));
  const fieldCandidates = {
    category: [WORK_ITEM_FIELDS.activity, "Microsoft.VSTS.Common.Discipline"].filter((field) => allFields.has(field)),
    targetCompletion: [WORK_ITEM_FIELDS.dueDate, "Microsoft.VSTS.Scheduling.TargetDate"].filter((field) => allFields.has(field)),
  };

  const existing = await getSharedProjectProfile(projectName);

  if (existing) {
    const row = await prisma.sopProject.findUnique({ where: { nameKey: nameKeyOf(projectName) }, select: { settings: true } });
    return { states: [...states.values()], fieldCandidates, settings: readSettings(row?.settings), setUp: true };
  }

  const stages: Partial<Record<SopStage, string[]>> = {};

  for (const state of states.values()) {
    const stage = suggestStage(state.name, state.category);

    if (stage) {
      stages[stage] = [...(stages[stage] ?? []), state.name];
    }
  }

  let prTargetBranch: string | null = "develop";

  try {
    const repositories = await listRepositories(client, projectId);
    prTargetBranch = stripRefPrefix(repositories.find((repo) => repo.defaultBranch)?.defaultBranch ?? null) ?? "develop";
  } catch (error) {
    // No code access: keep the common default.
    logFallback("Reading repositories for the PR target branch failed; using develop", error);
  }

  return {
    states: [...states.values()],
    fieldCandidates,
    setUp: false,
    settings: projectSettingsSchema.parse({
      stages: Object.fromEntries(SOP_STAGES.filter((stage) => stages[stage]?.length).map((stage) => [stage, stages[stage]])),
      fields: { category: fieldCandidates.category[0] ?? null, targetCompletion: fieldCandidates.targetCompletion[0] ?? null },
      categories: fieldCandidates.category.length ? DEFAULT_CATEGORIES : {},
      prTargetBranch,
    }),
  };
}
