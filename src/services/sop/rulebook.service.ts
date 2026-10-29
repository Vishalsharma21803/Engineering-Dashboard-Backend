import { AppError } from "../../lib/app-error.js";
import { prisma } from "../../lib/prisma.js";
import { mergeRulebooks, type EffectiveRulebook } from "./rulebook.merge.js";
import { ensureProjectsMoved, getProjectProfiles, getSharedProjectProfile } from "./sop-projects.service.js";
import { parseRulebook } from "./rulebook.parser.js";
import { ensureRuleLevelsUpdated } from "./rule-levels.js";
import { applyRuleEdits, type RuleEdit } from "./rulebook.edits.js";
import type { ParsedRulebook, ProjectProfile, RulebookError } from "./rulebook.types.js";
import { STARTER_RULEBOOK } from "./starter-rulebook.js";

/** Version 0 is the built-in starter; saved versions start at 1. */
export const STARTER_VERSION = 0;

/** Thrown when a rulebook has errors; the controller returns them with line numbers. */
export class RulebookValidationError extends AppError {
  constructor(readonly problems: RulebookError[]) {
    super(422, "RULEBOOK_INVALID", `The rulebook has ${problems.length} problem(s)`);
    this.name = "RulebookValidationError";
  }
}

export interface RulebookVersion {
  version: number;
  content: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

async function authorNames(userIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  return new Map(users.map((user) => [user.id, user.name]));
}

export async function getDefaultRulebook(): Promise<RulebookVersion> {
  // Old rulebooks carried project blocks; they move to the Projects screen the first time.
  await ensureProjectsMoved();
  // Then the agreed rule levels (notices, removed rules), once.
  await ensureRuleLevelsUpdated();
  const latest = await prisma.rulebook.findFirst({ orderBy: { version: "desc" } });

  if (!latest) {
    return { version: STARTER_VERSION, content: STARTER_RULEBOOK, note: "Built-in WI-002 starter", createdBy: null, createdAt: null };
  }

  const names = await authorNames([latest.createdBy]);
  return {
    version: latest.version,
    content: latest.content,
    note: latest.note,
    createdBy: latest.createdBy ? (names.get(latest.createdBy) ?? null) : null,
    createdAt: latest.createdAt.toISOString(),
  };
}

export async function listDefaultVersions() {
  const rows = await prisma.rulebook.findMany({
    orderBy: { version: "desc" },
    select: { version: true, note: true, createdBy: true, createdAt: true },
    take: 100,
  });
  const names = await authorNames(rows.map((row) => row.createdBy));

  return [
    ...rows.map((row) => ({
      version: row.version,
      note: row.note,
      createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    })),
    { version: STARTER_VERSION, note: "Built-in WI-002 starter", createdBy: null, createdAt: null },
  ];
}

export async function getDefaultVersion(version: number): Promise<RulebookVersion> {
  if (version === STARTER_VERSION) {
    return { version, content: STARTER_RULEBOOK, note: "Built-in WI-002 starter", createdBy: null, createdAt: null };
  }

  const row = await prisma.rulebook.findUnique({ where: { version } });

  if (!row) {
    throw new AppError(404, "RULEBOOK_VERSION_NOT_FOUND", "Rulebook version not found");
  }

  const names = await authorNames([row.createdBy]);
  return {
    version: row.version,
    content: row.content,
    note: row.note,
    createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function validateDefaultContent(content: string): ParsedRulebook {
  return parseRulebook(content, "default");
}

/** Every save is a new version; nothing is edited in place. */
export async function saveDefaultRulebook(content: string, userId: string, note: string | undefined) {
  const parsed = validateDefaultContent(content);

  if (parsed.errors.length > 0) {
    throw new RulebookValidationError(parsed.errors);
  }

  const latest = await prisma.rulebook.findFirst({ orderBy: { version: "desc" }, select: { version: true } });

  await prisma.rulebook.create({
    data: { version: (latest?.version ?? STARTER_VERSION) + 1, content, note: note ?? null, createdBy: userId },
  });

  return getDefaultRulebook();
}

export async function getPersonalRulebook(userId: string) {
  const latest = await prisma.userRulebook.findFirst({ where: { userId }, orderBy: { version: "desc" } });

  return latest
    ? { version: latest.version, content: latest.content, createdAt: latest.createdAt.toISOString() }
    : { version: 0, content: "", createdAt: null };
}

export async function listPersonalVersions(userId: string) {
  const rows = await prisma.userRulebook.findMany({
    where: { userId },
    orderBy: { version: "desc" },
    select: { version: true, createdAt: true },
    take: 100,
  });

  return rows.map((row) => ({ version: row.version, createdAt: row.createdAt.toISOString() }));
}

export async function getPersonalVersion(userId: string, version: number) {
  const row = await prisma.userRulebook.findUnique({ where: { userId_version: { userId, version } } });

  if (!row) {
    throw new AppError(404, "RULEBOOK_VERSION_NOT_FOUND", "Rulebook version not found");
  }

  return { version: row.version, content: row.content, createdAt: row.createdAt.toISOString() };
}

/** Personal files are checked on their own and against the current default rules. */
export async function validatePersonalContent(content: string): Promise<{ parsed: ParsedRulebook; problems: RulebookError[] }> {
  const parsed = parseRulebook(content, "personal");
  const defaults = validateDefaultContent((await getDefaultRulebook()).content);
  const merged = mergeRulebooks(defaults, parsed);

  return { parsed, problems: [...parsed.errors, ...merged.issues] };
}

export async function savePersonalRulebook(userId: string, content: string) {
  const { problems } = await validatePersonalContent(content);

  if (problems.length > 0) {
    throw new RulebookValidationError(problems);
  }

  const latest = await prisma.userRulebook.findFirst({ where: { userId }, orderBy: { version: "desc" }, select: { version: true } });
  await prisma.userRulebook.create({ data: { userId, version: (latest?.version ?? 0) + 1, content } });

  return getPersonalRulebook(userId);
}

function versionConflict(): AppError {
  return new AppError(409, "RULEBOOK_CHANGED", "The rules were changed elsewhere since you opened them. Reload and try again.");
}

/** Two saves at once both take the next version number; the later one is a conflict, not a server error. */
async function savingNewVersion<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (error) {
    if ((error as { code?: unknown }).code === "P2002") {
      throw versionConflict();
    }

    throw error;
  }
}

/** Changes from the rules list, saved as a new version of the user's own rules. */
export async function editPersonalRules(userId: string, baseVersion: number, edits: RuleEdit[]) {
  const current = await getPersonalRulebook(userId);

  if (current.version !== baseVersion) {
    throw versionConflict();
  }

  return savingNewVersion(() => savePersonalRulebook(userId, applyRuleEdits(current.content, "personal", edits)));
}

/** Changes from the rules list to the default rules (SOP owners), saved as a new version. */
export async function editDefaultRules(userId: string, baseVersion: number, edits: RuleEdit[], note: string | undefined) {
  const current = await getDefaultRulebook();

  if (current.version !== baseVersion) {
    throw versionConflict();
  }

  return savingNewVersion(() => saveDefaultRulebook(applyRuleEdits(current.content, "default", edits), userId, note ?? "Changed from the rules list"));
}

export interface EffectiveRulebookInfo extends EffectiveRulebook {
  defaultVersion: number;
  personalVersion: number;
  /** Set-up projects this user switched SOP checks off for. */
  switchedOff: string[];
}

/**
 * The rules that judge this user's checks. `forTeamReports` ignores the
 * personal file, as agreed: team reports always use the default rules.
 */
export async function getEffectiveRulebook(userId: string, options: { forTeamReports?: boolean } = {}): Promise<EffectiveRulebookInfo> {
  const defaults = await getDefaultRulebook();
  const parsedDefaults = validateDefaultContent(defaults.content);
  // Projects come from the shared set-ups; a user's own checks skip the ones they switched off.
  const { profiles, switchedOff } = await getProjectProfiles(options.forTeamReports ? null : userId);

  if (options.forTeamReports) {
    return { ...mergeRulebooks(parsedDefaults, null), projects: profiles, switchedOff: [], defaultVersion: defaults.version, personalVersion: 0 };
  }

  const personal = await getPersonalRulebook(userId);
  const parsedPersonal = personal.content ? parseRulebook(personal.content, "personal") : null;

  return {
    ...mergeRulebooks(parsedDefaults, parsedPersonal),
    projects: profiles,
    switchedOff,
    defaultVersion: defaults.version,
    personalVersion: personal.version,
  };
}

/** Project facts (stages, fields) from the shared set-up, whoever asks. */
export async function getDefaultProjectProfile(projectName: string): Promise<ProjectProfile | null> {
  return getSharedProjectProfile(projectName);
}

/** Projects with a Testing stage move merged work to Testing, so "close after merge" would skip it. */
export async function isCloseAfterMergeAllowed(projectName: string): Promise<boolean> {
  const profile = await getDefaultProjectProfile(projectName);
  return !profile || profile.stages.testing.length === 0;
}
