import type { Request, Response } from "express";
import { z } from "zod";

import { AppError } from "../lib/app-error.js";
import { projectSettingsSchema } from "../services/sop/project-settings.js";
import { isUserSopAdmin } from "../lib/sop-admin.js";
import {
  savePersonalRulebookSchema,
  saveDefaultRulebookSchema,
  aiCheckSchema,
  aiResultsQuerySchema,
  projectCheckedSchema,
  projectNameParamSchema,
  saveProjectSetUpSchema,
  testRulesSchema,
  validateRulebookSchema,
  versionParamSchema,
} from "../schemas/sop.schema.js";
import { testRulesOnTicket } from "../services/sop/sop-test.service.js";
import { deleteSopReportRun, getSopReportRun, listSopReportRuns, runSopReport } from "../services/sop/sop-report.service.js";
import { azureProjectIdSchema, reportRunIdSchema, sopProjectsPageQuerySchema, sopReportRunQuerySchema, sopReportRunsQuerySchema } from "../schemas/azure.schema.js";
import { paginate } from "../lib/pagination.js";
import { getProject, listProjects } from "../services/azure/projects.service.js";
import {
  getProjectProfiles,
  listProjectChanges,
  listProjectSetUps,
  nameKeyOf,
  removeProjectSetUp,
  saveProjectSetUp,
  setProjectIncluded,
  suggestProjectSetUp,
} from "../services/sop/sop-projects.service.js";
import { enqueueAiChecks, listAiChecks } from "../services/sop/ai/sop-ai.service.js";
import {
  RulebookValidationError,
  getDefaultRulebook,
  getDefaultVersion,
  getEffectiveRulebook,
  getPersonalRulebook,
  getPersonalVersion,
  listDefaultVersions,
  listPersonalVersions,
  saveDefaultRulebook,
  savePersonalRulebook,
  editDefaultRules,
  editPersonalRules,
  validateDefaultContent,
  validatePersonalContent,
} from "../services/sop/rulebook.service.js";
import { AI_REVIEW, BUILTIN_CHECKS, type BuiltinCheckName } from "../services/sop/builtin-checks.js";
import { ruleEditsSchema } from "../services/sop/rulebook.edits.js";
import { forgetDashboardLists } from "../services/work-item-list/dashboard-lists.service.js";
import { forgetMyWorkSnapshots } from "../services/work-item-list/my-work.service.js";
import { parseRulebook } from "../services/sop/rulebook.parser.js";
import { STARTER_RULEBOOK } from "../services/sop/starter-rulebook.js";
import type { RuleCard } from "../services/sop/rulebook.types.js";
import type { ParsedRulebook, RulebookError } from "../services/sop/rulebook.types.js";
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

/** Problems use the shared { field, message } error shape, with the line as the field. */
function toFieldErrors(problems: RulebookError[]) {
  return problems.map((problem) => ({ field: `line ${problem.line}`, message: problem.message }));
}

function summarize(parsed: Pick<ParsedRulebook, "projects" | "cards" | "overrides">) {
  return {
    projects: parsed.projects.map((project) => ({ project: project.project, stageSource: project.stageSource, stages: project.stages })),
    cards: parsed.cards.map((card) => ({
      id: card.id,
      title: card.title,
      checker: card.checker,
      uses: card.checker === "code" ? card.uses : null,
      appliesTo: card.appliesTo,
      when: card.when,
      severity: card.severity,
      origin: card.origin,
    })),
    overrides: parsed.overrides.map((override) => ({ id: override.id, severity: override.severity ?? null, params: override.params ?? null })),
  };
}

function sopRoute(label: string, handler: (req: Request, userId: string) => Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({
        message: "Authentication required",
        reason: "AUTH_REQUIRED",
      });
      return;
    }

    try {
      res.status(200).json(await handler(req, req.userId));
    } catch (error) {
      if (error instanceof RequestValidationError) {
        sendValidationError(res, error.zodError);
        return;
      }

      if (error instanceof RulebookValidationError) {
        res.status(422).json({ message: error.message, reason: error.reason, errors: toFieldErrors(error.problems) });
        return;
      }

      await sendError(res, error, label);
    }
  };
}

export const getDefaultRulebookController = sopRoute("Loading rulebook failed", async () => ({
  rulebook: await getDefaultRulebook(),
}));

export const listDefaultVersionsController = sopRoute("Listing rulebook versions failed", async () => ({
  versions: await listDefaultVersions(),
}));

export const getDefaultVersionController = sopRoute("Loading rulebook version failed", async (req) => ({
  rulebook: await getDefaultVersion(parse(versionParamSchema, req.params.version)),
}));

/**
 * SOP results in My work and the dashboard lists were computed with the old
 * rules or set-ups: rebuild them on the next read. No user = everyone's (shared rules).
 */
function sopChanged(userId?: string): void {
  forgetMyWorkSnapshots(userId);
  forgetDashboardLists(userId);
}

export const saveDefaultRulebookController = sopRoute("Saving rulebook failed", async (req, userId) => {
  const input = parse(saveDefaultRulebookSchema, req.body);
  const rulebook = await saveDefaultRulebook(input.content, userId, input.note);
  sopChanged();
  return { message: "Rulebook saved", rulebook };
});

export const getPersonalRulebookController = sopRoute("Loading your rules failed", async (_req, userId) => ({
  rulebook: await getPersonalRulebook(userId),
}));

export const listPersonalVersionsController = sopRoute("Listing your rule versions failed", async (_req, userId) => ({
  versions: await listPersonalVersions(userId),
}));

export const getPersonalVersionController = sopRoute("Loading your rule version failed", async (req, userId) => ({
  rulebook: await getPersonalVersion(userId, parse(versionParamSchema, req.params.version)),
}));

export const savePersonalRulebookController = sopRoute("Saving your rules failed", async (req, userId) => {
  const rulebook = await savePersonalRulebook(userId, parse(savePersonalRulebookSchema, req.body).content);
  sopChanged(userId);
  return { message: "Your rules were saved", rulebook };
});

/** Dry run for the editor: parse + validate without saving. */
export const validateRulebookController = sopRoute("Validating rulebook failed", async (req) => {
  const input = parse(validateRulebookSchema, req.body);

  if (input.scope === "default") {
    const parsed = validateDefaultContent(input.content);
    return { valid: parsed.errors.length === 0, errors: toFieldErrors(parsed.errors), summary: summarize(parsed) };
  }

  const { parsed, problems } = await validatePersonalContent(input.content);
  return { valid: problems.length === 0, errors: toFieldErrors(problems), summary: summarize(parsed) };
});

export const getEffectiveRulebookController = sopRoute("Loading effective rules failed", async (_req, userId) => {
  const effective = await getEffectiveRulebook(userId);
  return {
    defaultVersion: effective.defaultVersion,
    personalVersion: effective.personalVersion,
    issues: toFieldErrors(effective.issues),
    ...summarize({ projects: effective.projects, cards: effective.cards, overrides: [] }),
  };
});

/** One rule as the rules list shows and edits it. `defaults`: the default rule's level and settings, when the user changed them. */
function describeCard(card: RuleCard, defaults: RuleCard | undefined) {
  return {
    id: card.id,
    title: card.title,
    checker: card.checker,
    uses: card.checker === "code" ? card.uses : null,
    params: card.checker === "code" ? card.params : null,
    appliesTo: card.appliesTo,
    when: card.when,
    severity: card.severity,
    rule: card.rule,
    passesWhen: card.checker === "ai" ? card.passesWhen : null,
    failsWhen: card.checker === "ai" ? card.failsWhen : null,
    origin: card.origin,
    custom: card.id.startsWith("MY-"),
    /** A default rule the built-in starter also has, so "reset" can bring its version back. */
    inStarter: STARTER_IDS.has(card.id),
    defaults: card.origin === "personal" && defaults ? { severity: defaults.severity, params: defaults.checker === "code" ? defaults.params : null } : null,
  };
}

const STARTER_IDS = new Set(parseRulebook(STARTER_RULEBOOK, "default").cards.map((card) => card.id));

/** The built-in checks a rule can use, with their settings as JSON Schema (the rules list builds inputs from it). */
const CHECK_CATALOG = Object.entries(BUILTIN_CHECKS).map(([name, check]) => ({
  name,
  description: check.description,
  aiReview: AI_REVIEW[name as BuiltinCheckName] ?? null,
  params: z.toJSONSchema(check.params, { io: "input", unrepresentable: "any" }),
}));

export const getRulesListController = sopRoute("Loading the rules failed", async (_req, userId) => {
  const [effective, defaults, canEditDefaults] = await Promise.all([getEffectiveRulebook(userId), getDefaultRulebook(), isUserSopAdmin(userId)]);
  const defaultCards = validateDefaultContent(defaults.content).cards;
  const byId = new Map(defaultCards.map((card) => [card.id, card]));

  return {
    defaultVersion: effective.defaultVersion,
    personalVersion: effective.personalVersion,
    canEditDefaults,
    issues: toFieldErrors(effective.issues),
    rules: effective.cards.map((card) => describeCard(card, byId.get(card.id))),
    defaultRules: defaultCards.map((card) => describeCard(card, undefined)),
    checks: CHECK_CATALOG,
  };
});

export const editPersonalRulesController = sopRoute("Saving your rules failed", async (req, userId) => {
  const input = parse(ruleEditsSchema, req.body);
  const rulebook = await editPersonalRules(userId, input.baseVersion, input.edits);
  sopChanged(userId);
  return { message: "Your rules were saved", rulebook };
});

export const editDefaultRulesController = sopRoute("Saving the default rules failed", async (req, userId) => {
  const input = parse(ruleEditsSchema, req.body);
  const rulebook = await editDefaultRules(userId, input.baseVersion, input.edits, input.note);
  sopChanged();
  return { message: "Default rules saved", rulebook };
});

type AzureSopHandler = (req: Request, client: NonNullable<Request["azure"]>, userId: string) => Promise<unknown>;

/** SOP routes that need the user's Azure connection. They read Azure only. */
function azureSopRoute(label: string, handler: AzureSopHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    const azure = req.azure;

    if (!azure || !req.userId) {
      res.status(401).json({
        message: "Authentication required",
        reason: "AUTH_REQUIRED",
      });
      return;
    }

    try {
      res.status(200).json(await handler(req, azure, req.userId));
    } catch (error) {
      if (error instanceof RequestValidationError) {
        sendValidationError(res, error.zodError);
        return;
      }

      await sendError(res, error, label, { userId: req.userId, credentialId: azure.credentialId });
    }
  };
}

/** Evaluates saved or draft rules on one real ticket. Reads Azure only; saves nothing. */
export const testSopRulesController = azureSopRoute("Testing SOP rules failed", async (req, azure, userId) => {
  const body = parse(testRulesSchema, req.body);

  // Only SOP owners may test unsaved default rules (they apply to everyone).
  if (body.draft?.scope === "default" && !(await isUserSopAdmin(userId))) {
    throw new AppError(403, "SOP_ADMIN_REQUIRED", "Only SOP owners can test changes to the default rules");
  }

  return testRulesOnTicket(azure.client, userId, body);
});

/** Queues AI checks for tickets that changed since their last check (or all with force). */
export const enqueueAiChecksController = azureSopRoute("Queuing AI checks failed", async (req, azure, userId) => {
  const body = parse(aiCheckSchema, req.body);
  return enqueueAiChecks(azure.client, userId, azure.credentialId, body.workItemIds, { force: body.force });
});

export const listAiChecksController = azureSopRoute("Loading AI checks failed", async (req, azure, userId) => ({
  checks: await listAiChecks(userId, azure.credentialId, parse(aiResultsQuerySchema, req.query).ids),
}));

/* -------------------------------------------------------------- projects */

/** Projects set up for SOP checks, and whether each is checked for this user. */
export const listProjectSetUpsController = sopRoute("Loading SOP projects failed", async (_req, userId) => {
  const [setUps, mine] = await Promise.all([listProjectSetUps({ userId, isAdmin: await isUserSopAdmin(userId) }), getProjectProfiles(userId)]);
  const off = new Set(mine.switchedOff.map(nameKeyOf));
  return { projects: setUps.map((setUp) => ({ ...setUp, checkedForMe: !off.has(nameKeyOf(setUp.projectName)) })) };
});

/** Anyone may set a new project up; only its creator or an SOP owner may change it. The change is recorded. */
export const saveProjectSetUpController = sopRoute("Saving the project set-up failed", async (req, userId) => {
  const projectName = parse(projectNameParamSchema, req.params.projectName);
  const { settings } = parse(saveProjectSetUpSchema, req.body);
  const isAdmin = await isUserSopAdmin(userId);
  // Invalid settings come back as field errors ({ field: "settings.stages", message }) like other forms.
  const project = await saveProjectSetUp(userId, projectName, parse(projectSettingsSchema, settings), {
    canSetBranchPattern: isAdmin,
    isAdmin,
  });
  sopChanged();
  return { project };
});

export const removeProjectSetUpController = sopRoute("Removing the project set-up failed", async (req, userId) => {
  await removeProjectSetUp(userId, parse(projectNameParamSchema, req.params.projectName), { isAdmin: await isUserSopAdmin(userId) });
  sopChanged();
  return { message: "Project removed from SOP checks" };
});

export const listProjectChangesController = sopRoute("Loading project history failed", async (req) => ({
  changes: await listProjectChanges(parse(projectNameParamSchema, req.params.projectName)),
}));

/** The user's own switch: check this set-up project for me or not. */
export const setProjectCheckedController = sopRoute("Saving your project choice failed", async (req, userId) => {
  const projectName = parse(projectNameParamSchema, req.params.projectName);
  const { checked } = parse(projectCheckedSchema, req.body);
  await setProjectIncluded(userId, projectName, checked);
  sopChanged(userId);
  return { projectName, checked };
});

/** The organization's projects with their SOP status (10 per page), plus set-ups for projects not in it (10 per page). */
export const listAzureProjectsForSopController = azureSopRoute("Loading Azure projects failed", async (req, azure, userId) => {
  const { page, elsewherePage } = parse(sopProjectsPageQuerySchema, req.query);
  const [{ projects }, setUps, mine] = await Promise.all([
    listProjects(azure.client),
    listProjectSetUps({ userId, isAdmin: await isUserSopAdmin(userId) }),
    getProjectProfiles(userId),
  ]);
  const setUpKeys = new Set(setUps.map((setUp) => nameKeyOf(setUp.projectName)));
  const off = new Set(mine.switchedOff.map(nameKeyOf));
  const inOrganization = new Set(projects.map((project) => nameKeyOf(project.name)));

  return {
    projects: paginate(
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        setUp: setUpKeys.has(nameKeyOf(project.name)),
        checkedForMe: setUpKeys.has(nameKeyOf(project.name)) && !off.has(nameKeyOf(project.name)),
      })),
      page
    ),
    elsewhere: paginate(
      setUps
        .filter((setUp) => !inOrganization.has(nameKeyOf(setUp.projectName)))
        .map((setUp) => ({ projectName: setUp.projectName, checkedForMe: !off.has(nameKeyOf(setUp.projectName)) })),
      elsewherePage
    ),
  };
});

/** Pre-fill for the set-up form, read from Azure: states, candidate fields, default branch. */
export const suggestProjectSetUpController = azureSopRoute("Reading the project from Azure failed", async (req, azure) => {
  const project = await getProject(azure.client, parse(projectNameParamSchema, req.params.projectId));
  return { suggestion: { projectName: project.name, ...(await suggestProjectSetUp(azure.client, project.name, project.id)) } };
});

/* Team SOP report runs: read Azure, saved in Cockpit for the person who ran them. */

/** Runs the team SOP report for one project (default rules, code rules only) and saves it for this user. Reads Azure only. */
export const runSopReportController = azureSopRoute("Running the SOP report failed", async (req, azure, userId) => {
  const project = await getProject(azure.client, parse(azureProjectIdSchema, req.params.projectId));
  return { run: await runSopReport(azure.client, userId, project.name) };
});

/** This user's saved report runs for the project, newest first, 10 per page. */
export const listSopReportRunsController = azureSopRoute("Listing SOP report runs failed", async (req, azure, userId) => {
  const project = await getProject(azure.client, parse(azureProjectIdSchema, req.params.projectId));
  const { page } = parse(sopReportRunsQuerySchema, req.query);
  return { runs: await listSopReportRuns(userId, azure.credentialId, project.name, page) };
});

/** One saved run, filtered by person, role, rule, type or state, and paged on the server. */
export const getSopReportRunController = azureSopRoute("Reading the SOP report failed", async (req, azure, userId) => {
  const project = await getProject(azure.client, parse(azureProjectIdSchema, req.params.projectId));
  const runId = parse(reportRunIdSchema, req.params.runId);
  const { page, rulePage, personPage, ...filters } = parse(sopReportRunQuerySchema, req.query);
  return { report: await getSopReportRun(userId, azure.credentialId, project.name, runId, { filters, page, rulePage, personPage }) };
});

export const deleteSopReportRunController = azureSopRoute("Deleting the SOP report failed", async (req, azure, userId) => {
  const project = await getProject(azure.client, parse(azureProjectIdSchema, req.params.projectId));
  await deleteSopReportRun(userId, azure.credentialId, project.name, parse(reportRunIdSchema, req.params.runId));
  return { deleted: true };
});
