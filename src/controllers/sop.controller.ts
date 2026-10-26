import type { Request, Response } from "express";
import type { z } from "zod";

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
  validateDefaultContent,
  validatePersonalContent,
} from "../services/sop/rulebook.service.js";
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
      res.status(401).json({ message: "Authentication required" });
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

export const saveDefaultRulebookController = sopRoute("Saving rulebook failed", async (req, userId) => {
  const input = parse(saveDefaultRulebookSchema, req.body);
  return { message: "Rulebook saved", rulebook: await saveDefaultRulebook(input.content, userId, input.note) };
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

export const savePersonalRulebookController = sopRoute("Saving your rules failed", async (req, userId) => ({
  message: "Your rules were saved",
  rulebook: await savePersonalRulebook(userId, parse(savePersonalRulebookSchema, req.body).content),
}));

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

type AzureSopHandler = (req: Request, client: NonNullable<Request["azure"]>, userId: string) => Promise<unknown>;

/** SOP routes that need the user's Azure connection. They read Azure only. */
function azureSopRoute(label: string, handler: AzureSopHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    const azure = req.azure;

    if (!azure || !req.userId) {
      res.status(401).json({ message: "Authentication required" });
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
  const [setUps, mine] = await Promise.all([listProjectSetUps(), getProjectProfiles(userId)]);
  const off = new Set(mine.switchedOff.map(nameKeyOf));
  return { projects: setUps.map((setUp) => ({ ...setUp, checkedForMe: !off.has(nameKeyOf(setUp.projectName)) })) };
});

/** Anyone may set a project up or change it; the change is recorded. */
export const saveProjectSetUpController = sopRoute("Saving the project set-up failed", async (req, userId) => {
  const projectName = parse(projectNameParamSchema, req.params.projectName);
  const { settings } = parse(saveProjectSetUpSchema, req.body);
  // Invalid settings come back as field errors ({ field: "settings.stages", message }) like other forms.
  return {
    project: await saveProjectSetUp(userId, projectName, parse(projectSettingsSchema, settings), {
      canSetBranchPattern: await isUserSopAdmin(userId),
    }),
  };
});

export const removeProjectSetUpController = sopRoute("Removing the project set-up failed", async (req, userId) => {
  await removeProjectSetUp(userId, parse(projectNameParamSchema, req.params.projectName));
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
  return { projectName, checked };
});

/** The organization's Azure projects, marked with their SOP set-up and this user's choice. Reads Azure only. */
export const listAzureProjectsForSopController = azureSopRoute("Loading Azure projects failed", async (_req, azure, userId) => {
  const [{ projects }, setUps, mine] = await Promise.all([listProjects(azure.client), listProjectSetUps(), getProjectProfiles(userId)]);
  const setUpKeys = new Set(setUps.map((setUp) => nameKeyOf(setUp.projectName)));
  const off = new Set(mine.switchedOff.map(nameKeyOf));

  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      setUp: setUpKeys.has(nameKeyOf(project.name)),
      checkedForMe: setUpKeys.has(nameKeyOf(project.name)) && !off.has(nameKeyOf(project.name)),
    })),
  };
});

/** Pre-fill for the set-up form, read from Azure: states, candidate fields, default branch. */
export const suggestProjectSetUpController = azureSopRoute("Reading the project from Azure failed", async (req, azure) => {
  const project = await getProject(azure.client, parse(projectNameParamSchema, req.params.projectId));
  return { suggestion: { projectName: project.name, ...(await suggestProjectSetUp(azure.client, project.name, project.id)) } };
});
