import type { Request, Response } from "express";
import type { z } from "zod";

import { paginate } from "../lib/pagination.js";
import { SolidtimeApiError } from "../lib/solidtime/errors.js";
import { refreshQuerySchema } from "../schemas/azure.schema.js";
import { credentialIdSchema } from "../schemas/credential.schema.js";
import {
  accuracyQuerySchema,
  verificationQuerySchema,
  catalogPageQuerySchema,
  draftEstimateBodySchema,
  draftQuerySchema,
  timeCsvQuerySchema,
  createSolidtimeConnectionSchema,
  dayRangeQuerySchema,
  ticketIdParamSchema,
  ticketIdsQuerySchema,
  updateSolidtimeConnectionSchema,
} from "../schemas/solidtime.schema.js";
import {
  createSolidtimeConnection,
  listMemberships,
  listSolidtimeConnections,
  markSolidtimeInvalid,
  updateSolidtimeConnection,
  validateSolidtimeConnection,
} from "../services/solidtime/connection.service.js";
import { getActiveEntry, getMe, listClients, listProjects, listTags, listTasks } from "../services/solidtime/read.service.js";
import { isValidTimeZone } from "../lib/zoned-time.js";
import { candidateTicketIds } from "../services/solidtime/ticket-ids.js";
import { compareWithEstimate, getTicketTimes, TICKET_LOOKBACK_DAYS } from "../services/solidtime/ticket-time.service.js";
import { isFinished, linkedAzureClient, lookUpTickets } from "../services/solidtime/tickets.service.js";
import { getTimesheet, getUnlinkedEntries } from "../services/solidtime/timesheet.service.js";
import { draftDayFromAzure } from "../services/solidtime/draft.service.js";
import { estimateDraftHours } from "../services/solidtime/draft-ai.service.js";
import { estimateAccuracy, timeCsv } from "../services/solidtime/reports.service.js";
import { verifyTime } from "../services/solidtime/verification.service.js";
import { sendError, sendValidationError } from "./controller-helpers.js";

class RequestValidationError extends Error {
  constructor(readonly zodError: z.ZodError) {
    super("Request validation failed");
  }
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new RequestValidationError(result.error);
  }

  return result.data;
}

async function respondWithError(req: Request, res: Response, error: unknown, label: string, credentialId?: string): Promise<void> {
  if (error instanceof RequestValidationError) {
    sendValidationError(res, error.zodError);
    return;
  }

  if (error instanceof SolidtimeApiError && error.solidtimeReason === "SOLIDTIME_TOKEN_INVALID" && credentialId) {
    await markSolidtimeInvalid(credentialId);
  }

  if (error instanceof SolidtimeApiError && error.retryAfterSeconds !== null) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }

  await sendError(res, error, label);
}

type Handler = (req: Request, userId: string) => Promise<unknown>;

/** Signed-in user routes (connection management). They check tokens from the request, so a bad one never marks the stored connection invalid. */
export function userRoute(label: string, handler: Handler, status = 200) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    try {
      res.status(status).json(await handler(req, req.userId));
    } catch (error) {
      await respondWithError(req, res, error, label);
    }
  };
}

type ConnectedHandler = (req: Request, solidtime: NonNullable<Request["solidtime"]>, userId: string) => Promise<unknown>;

/** Routes behind loadSolidtimeConnection: reads only; Solidtime changes go through approved actions. */
export function solidtimeRoute(label: string, handler: ConnectedHandler) {
  return async (req: Request, res: Response): Promise<void> => {
    const solidtime = req.solidtime;

    if (!solidtime || !req.userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    try {
      res.status(200).json(await handler(req, solidtime, req.userId));
    } catch (error) {
      await respondWithError(req, res, error, label, solidtime.connection.credentialId);
    }
  };
}

/* ------------------------------------------------------------ connections */

export const listConnectionsController = userRoute("Listing Solidtime connections failed", async (_req, userId) => ({
  connections: await listSolidtimeConnections(userId),
}));

export const createConnectionController = userRoute(
  "Connecting Solidtime failed",
  async (req, userId) => createSolidtimeConnection(userId, parse(createSolidtimeConnectionSchema, req.body)),
  201
);

export const updateConnectionController = userRoute("Updating the Solidtime connection failed", async (req, userId) => ({
  connection: await updateSolidtimeConnection(userId, parse(credentialIdSchema, req.params.credentialId), parse(updateSolidtimeConnectionSchema, req.body)),
}));

export const validateConnectionController = userRoute("Checking the Solidtime token failed", async (req, userId) =>
  validateSolidtimeConnection(userId, parse(credentialIdSchema, req.params.credentialId))
);

export const listMembershipsController = userRoute("Reading Solidtime organizations failed", async (req, userId) => ({
  memberships: await listMemberships(userId, parse(credentialIdSchema, req.params.credentialId)),
}));

/* ------------------------------------------------------------------ reads */

/** Everything the timer and entry forms pick from (unpaged: these feed dropdowns). */
export const catalogController = solidtimeRoute("Reading Solidtime projects failed", async (_req, { client, connection }) => {
  const [projects, tasks, tags] = await Promise.all([
    listProjects(client, connection.organizationId),
    listTasks(client, connection.organizationId),
    listTags(client, connection.organizationId),
  ]);
  return { projects, tasks, tags };
});

export const listProjectsController = solidtimeRoute("Listing Solidtime projects failed", async (req, { client, connection }) => ({
  projects: paginate(await listProjects(client, connection.organizationId, "all"), parse(catalogPageQuerySchema, req.query).page),
}));

export const listTasksController = solidtimeRoute("Listing Solidtime tasks failed", async (req, { client, connection }) => {
  const { page, projectId } = parse(catalogPageQuerySchema, req.query);
  return { tasks: paginate(await listTasks(client, connection.organizationId, projectId), page) };
});

export const listTagsController = solidtimeRoute("Listing Solidtime tags failed", async (req, { client, connection }) => ({
  tags: paginate(await listTags(client, connection.organizationId), parse(catalogPageQuerySchema, req.query).page),
}));

export const listClientsController = solidtimeRoute("Listing Solidtime clients failed", async (req, { client, connection }) => ({
  clients: paginate(await listClients(client, connection.organizationId), parse(catalogPageQuerySchema, req.query).page),
}));

/** My Solidtime time zone: days in the time views are counted in it. */
export const profileController = solidtimeRoute("Reading your Solidtime profile failed", async (_req, { client }) => {
  const me = await getMe(client);
  return { profile: { name: me.name, timeZone: me.timezone && isValidTimeZone(me.timezone) ? me.timezone : "UTC" } };
});

/** My running timer, with the Azure ticket it names. */
export const timerController = solidtimeRoute("Reading the Solidtime timer failed", async (_req, { client, connection }, userId) => {
  const active = await getActiveEntry(client);

  // A timer in another organization is still "the" timer (Solidtime allows one per user).
  if (!active) {
    return { timer: null };
  }

  const lookup = await lookUpTickets(await linkedAzureClient(userId, connection.azureCredentialId), candidateTicketIds(active.description));
  return {
    timer: {
      entry: active,
      inThisOrganization: active.organization_id === connection.organizationId,
      tickets: [...lookup.tickets.values()].map((ticket) => ({ id: ticket.id, title: ticket.title, projectName: ticket.projectName })),
    },
  };
});

export const timesheetController = solidtimeRoute("Reading your timesheet failed", async (req, { client, connection }, userId) => {
  const range = parse(dayRangeQuerySchema, req.query);
  return { timesheet: await getTimesheet(client, connection, await linkedAzureClient(userId, connection.azureCredentialId), range) };
});

export const unlinkedController = solidtimeRoute("Reading unlinked entries failed", async (req, { client, connection }, userId) => {
  const range = parse(dayRangeQuerySchema, req.query);
  return { entries: await getUnlinkedEntries(client, connection, await linkedAzureClient(userId, connection.azureCredentialId), range) };
});

const lookbackStart = (now: Date) => new Date(now.getTime() - TICKET_LOOKBACK_DAYS * 86_400_000);

/**
 * All the time ever tracked on one ticket (mine, the team's if my role allows,
 * per person), compared with its Azure fields. ?refresh=true reads both fresh.
 */
export const ticketTimeController = solidtimeRoute("Reading time for the ticket failed", async (req, { client, connection }, userId) => {
  const ticketId = parse(ticketIdParamSchema, req.params.ticketId);
  const { refresh } = parse(refreshQuerySchema, req.query);
  const now = new Date();
  const azure = await linkedAzureClient(userId, connection.azureCredentialId, { refresh });
  const lookup = await lookUpTickets(azure, [ticketId]);
  const ticket = lookup.tickets.get(ticketId) ?? null;
  const times = await getTicketTimes(client, connection, [ticketId], { now, withPeople: true });
  const time = times.get(ticketId)!;
  const finished = ticket && azure ? await isFinished(azure, ticket) : false;

  return { time, ticket, comparison: ticket ? compareWithEstimate(time, ticket, { finished }) : null };
});

/** Time on several tickets at once (My work rows). */
export const ticketTimesController = solidtimeRoute("Reading time for tickets failed", async (req, { client, connection }) => {
  const { ids } = parse(ticketIdsQuerySchema, req.query);
  const now = new Date();
  const times = await getTicketTimes(client, connection, ids, { since: lookbackStart(now), now });
  return { times: [...times.values()] };
});

/**
 * A suggested day of entries from my Azure DevOps activity. Read-only; approving it is a separate action.
 * ?refresh=true (Rebuild) reads Azure fresh too, not only Solidtime.
 */
export const draftController = solidtimeRoute("Drafting the day from Azure DevOps failed", async (req, { client, connection }, userId) => {
  const { day } = parse(draftQuerySchema, req.query);
  const { refresh } = parse(refreshQuerySchema, req.query);
  return { draft: await draftDayFromAzure(client, connection, await linkedAzureClient(userId, connection.azureCredentialId, { refresh }), day) };
});

/** AI hours for drafted rows. Calls the user's AI provider (counted against their spend limit); writes nothing to Solidtime or Azure. */
export const draftEstimateController = solidtimeRoute("Estimating hours with AI failed", async (req, { client, connection }, userId) => {
  const body = parse(draftEstimateBodySchema, req.body);
  return { estimate: await estimateDraftHours(userId, client, connection, await linkedAzureClient(userId, connection.azureCredentialId), body) };
});

/** Time → Verify: each ticket I logged time on in the period, its Solidtime total next to Azure. Read-only. */
export const verificationController = solidtimeRoute("Checking time against Azure DevOps failed", async (req, { client, connection }, userId) => {
  const { from, to, refresh } = parse(verificationQuerySchema, req.query);
  return { verification: await verifyTime(client, connection, await linkedAzureClient(userId, connection.azureCredentialId, { refresh }), { from, to }) };
});

export const accuracyController = solidtimeRoute("Building the estimate accuracy report failed", async (req, { client, connection }, userId) => {
  const query = parse(accuracyQuerySchema, req.query);
  return { accuracy: await estimateAccuracy(client, connection, await linkedAzureClient(userId, connection.azureCredentialId), query) };
});

/** Time per person, day and ticket between two days, with each ticket's estimate figures, as CSV. */
export async function timeCsvController(req: Request, res: Response): Promise<void> {
  const solidtime = req.solidtime;

  if (!solidtime || !req.userId) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  try {
    const { from, to } = parse(timeCsvQuerySchema, req.query);
    const csv = await timeCsv(solidtime.client, solidtime.connection, await linkedAzureClient(req.userId, solidtime.connection.azureCredentialId), { from, to });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="time-${from}-to-${to}.csv"`);
    res.status(200).send(csv);
  } catch (error) {
    await respondWithError(req, res, error, "Exporting the time failed", solidtime.connection.credentialId);
  }
}
