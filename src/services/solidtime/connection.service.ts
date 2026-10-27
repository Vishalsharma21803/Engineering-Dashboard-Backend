import { AppError } from "../../lib/app-error.js";
import { decryptSecret, encryptSecret } from "../../lib/encryption.js";
import { prisma } from "../../lib/prisma.js";
import { SolidtimeClient, clearSolidtimeCache } from "../../lib/solidtime/client.js";
import { SolidtimeApiError } from "../../lib/solidtime/errors.js";
import type { SolidtimeMe, SolidtimeMembership } from "../../lib/solidtime/types.js";
import { Platform, ValidationStatus } from "../../generated/prisma/enums.js";

/** Roles that may read everyone's time in a Solidtime organization (team views). */
const TEAM_ROLES = new Set(["owner", "admin", "manager"]);

export interface SolidtimeConnectionDto {
  credentialId: string;
  baseUrl: string;
  label: string | null;
  lastValidatedAt: string | null;
  lastValidationStatus: ValidationStatus | null;
  organizationId: string | null;
  organizationName: string | null;
  memberId: string | null;
  role: string | null;
  /** True when the role can see everyone's time (Manager, Admin, Owner). */
  canViewTeam: boolean;
  azureCredentialId: string | null;
  /** Azure project name (lower-cased) -> Solidtime project id. */
  projectMap: Record<string, string>;
  dailyTargetHours: number;
  timerAlertHours: number;
}

const CONNECTION_SELECT = {
  id: true,
  organizationUrl: true,
  label: true,
  lastValidatedAt: true,
  lastValidationStatus: true,
  solidtime: true,
} as const;

type Row = Awaited<ReturnType<typeof findRow>>;

async function findRow(userId: string, credentialId: string) {
  return prisma.credential.findFirst({ where: { id: credentialId, userId, platform: Platform.SOLIDTIME }, select: CONNECTION_SELECT });
}

function toDto(row: NonNullable<Row>): SolidtimeConnectionDto {
  const settings = row.solidtime;
  const map = settings?.projectMap;

  return {
    credentialId: row.id,
    baseUrl: row.organizationUrl,
    label: row.label,
    lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
    lastValidationStatus: row.lastValidationStatus,
    organizationId: settings?.organizationId ?? null,
    organizationName: settings?.organizationName ?? null,
    memberId: settings?.memberId ?? null,
    role: settings?.role ?? null,
    canViewTeam: TEAM_ROLES.has(settings?.role ?? ""),
    azureCredentialId: settings?.azureCredentialId ?? null,
    projectMap: map && typeof map === "object" && !Array.isArray(map) ? (map as Record<string, string>) : {},
    dailyTargetHours: settings?.dailyTargetHours ?? 8,
    timerAlertHours: settings?.timerAlertHours ?? 10,
  };
}

/** Checks a token against the server: who it belongs to and which organizations it can use. */
async function readAccount(baseUrl: string, token: string): Promise<{ me: SolidtimeMe; memberships: SolidtimeMembership[] }> {
  // A bad new token is reported as such; the stored connection is not marked invalid by it.
  const client = new SolidtimeClient({ credentialId: `check:${baseUrl}`, baseUrl, token, refresh: true });
  const me = await client.get<{ data: SolidtimeMe }>("users/me");
  const memberships = await client.get<{ data: SolidtimeMembership[] }>("users/me/memberships");

  return { me: me.data, memberships: (memberships.data ?? []).filter((membership) => membership.role !== "placeholder") };
}

function isUniqueError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export async function listSolidtimeConnections(userId: string): Promise<SolidtimeConnectionDto[]> {
  const rows = await prisma.credential.findMany({
    where: { userId, platform: Platform.SOLIDTIME },
    select: CONNECTION_SELECT,
    orderBy: { createdAt: "desc" },
  });

  return rows.map(toDto);
}

export async function getSolidtimeConnection(userId: string, credentialId: string): Promise<SolidtimeConnectionDto> {
  const row = await findRow(userId, credentialId);

  if (!row) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Solidtime connection not found");
  }

  return toDto(row);
}

/** Saves a new connection after the token is confirmed; with one organization it is chosen at once. */
export async function createSolidtimeConnection(
  userId: string,
  input: { baseUrl: string; token: string; label?: string | undefined }
): Promise<{ connection: SolidtimeConnectionDto; memberships: SolidtimeMembership[] }> {
  const { me, memberships } = await readAccount(input.baseUrl, input.token);
  const only = memberships.length === 1 ? memberships[0] : undefined;
  const firstAzure = await prisma.credential.findFirst({ where: { userId, platform: Platform.AZURE }, orderBy: { createdAt: "asc" }, select: { id: true } });

  try {
    const created = await prisma.credential.create({
      data: {
        userId,
        platform: Platform.SOLIDTIME,
        organizationUrl: input.baseUrl,
        label: input.label ?? null,
        encryptedPatToken: encryptSecret(input.token),
        lastValidatedAt: new Date(),
        lastValidationStatus: ValidationStatus.VALID,
        solidtime: {
          create: {
            organizationId: only?.organization.id ?? null,
            organizationName: only?.organization.name ?? null,
            memberId: only?.id ?? null,
            role: only?.role ?? null,
            solidtimeUserId: me.id,
            azureCredentialId: firstAzure?.id ?? null,
          },
        },
      },
      select: { id: true },
    });

    return { connection: await getSolidtimeConnection(userId, created.id), memberships };
  } catch (error) {
    if (isUniqueError(error)) {
      throw new AppError(409, "CREDENTIAL_ALREADY_EXISTS", "You are already connected to this Solidtime server");
    }

    throw error;
  }
}

/** Decrypts the token for one request. */
export async function solidtimeClientFor(userId: string, credentialId: string, options: { refresh?: boolean; background?: boolean } = {}) {
  const row = await prisma.credential.findFirst({
    where: { id: credentialId, userId, platform: Platform.SOLIDTIME },
    select: { id: true, organizationUrl: true, encryptedPatToken: true },
  });

  if (!row) {
    return null;
  }

  let token: string;

  try {
    token = decryptSecret(row.encryptedPatToken);
  } catch {
    console.error("Decrypting credential failed:", row.id);
    throw new AppError(500, "CREDENTIAL_UNREADABLE", "Stored credential could not be read");
  }

  return new SolidtimeClient({ credentialId: row.id, baseUrl: row.organizationUrl, token, refresh: options.refresh ?? false, background: options.background ?? false });
}

export async function listMemberships(userId: string, credentialId: string): Promise<SolidtimeMembership[]> {
  const client = await solidtimeClientFor(userId, credentialId, { refresh: true });

  if (!client) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Solidtime connection not found");
  }

  const response = await client.get<{ data: SolidtimeMembership[] }>("users/me/memberships");
  return (response.data ?? []).filter((membership) => membership.role !== "placeholder");
}

export interface UpdateSolidtimeInput {
  label?: string | null | undefined;
  token?: string | undefined;
  organizationId?: string | undefined;
  azureCredentialId?: string | null | undefined;
  projectMap?: Record<string, string> | undefined;
  dailyTargetHours?: number | undefined;
  timerAlertHours?: number | undefined;
}

export async function updateSolidtimeConnection(userId: string, credentialId: string, input: UpdateSolidtimeInput): Promise<SolidtimeConnectionDto> {
  const row = await findRow(userId, credentialId);

  if (!row) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Solidtime connection not found");
  }

  const credentialData: { label?: string | null; encryptedPatToken?: string; lastValidatedAt?: Date; lastValidationStatus?: ValidationStatus } = {};
  let memberships: SolidtimeMembership[] | null = null;

  const settings: Record<string, unknown> = {};

  if (input.token !== undefined) {
    const account = await readAccount(row.organizationUrl, input.token);
    memberships = account.memberships;
    settings.solidtimeUserId = account.me.id;
    credentialData.encryptedPatToken = encryptSecret(input.token);
    credentialData.lastValidatedAt = new Date();
    credentialData.lastValidationStatus = ValidationStatus.VALID;
  }

  if (input.label !== undefined) {
    credentialData.label = input.label;
  }

  if (input.organizationId !== undefined) {
    const choices = memberships ?? (await listMemberships(userId, credentialId));
    const chosen = choices.find((membership) => membership.organization.id === input.organizationId);

    if (!chosen) {
      throw new AppError(422, "SOLIDTIME_ORGANIZATION_UNKNOWN", "This token is not a member of that Solidtime organization");
    }

    const changed = chosen.organization.id !== row.solidtime?.organizationId;
    // Project ids belong to an organization: a new organization starts with no mapping.
    Object.assign(settings, { organizationId: chosen.organization.id, organizationName: chosen.organization.name, memberId: chosen.id, role: chosen.role, ...(changed ? { projectMap: {} } : {}) });
  } else if (memberships && row.solidtime?.organizationId) {
    // A new token must still belong to the chosen organization; its role may have changed.
    const current = memberships.find((membership) => membership.organization.id === row.solidtime?.organizationId);

    if (!current) {
      throw new AppError(422, "SOLIDTIME_ORGANIZATION_UNKNOWN", "The new token is not a member of the chosen Solidtime organization");
    }

    Object.assign(settings, { memberId: current.id, role: current.role });
  }

  if (input.azureCredentialId !== undefined) {
    if (input.azureCredentialId !== null) {
      const azure = await prisma.credential.findFirst({ where: { id: input.azureCredentialId, userId, platform: Platform.AZURE }, select: { id: true } });

      if (!azure) {
        throw new AppError(422, "AZURE_CREDENTIAL_UNKNOWN", "Choose one of your Azure DevOps connections");
      }
    }

    settings.azureCredentialId = input.azureCredentialId;
  }

  if (input.projectMap !== undefined) settings.projectMap = input.projectMap;
  if (input.dailyTargetHours !== undefined) settings.dailyTargetHours = input.dailyTargetHours;
  if (input.timerAlertHours !== undefined) settings.timerAlertHours = input.timerAlertHours;

  await prisma.$transaction([
    prisma.credential.update({ where: { id: row.id }, data: credentialData }),
    prisma.solidtimeConnection.upsert({ where: { credentialId: row.id }, create: { credentialId: row.id, ...settings }, update: settings }),
  ]);

  if (input.token !== undefined || input.organizationId !== undefined) {
    clearSolidtimeCache(row.id);
  }

  return getSolidtimeConnection(userId, credentialId);
}

/** Re-checks the stored token and records the result. */
export async function validateSolidtimeConnection(userId: string, credentialId: string): Promise<{ valid: boolean; lastValidatedAt: string }> {
  const client = await solidtimeClientFor(userId, credentialId, { refresh: true });

  if (!client) {
    throw new AppError(404, "CREDENTIAL_NOT_FOUND", "Solidtime connection not found");
  }

  let status: ValidationStatus = ValidationStatus.VALID;

  try {
    await client.get("users/me");
  } catch (error) {
    if (!(error instanceof SolidtimeApiError)) throw error;
    status = error.solidtimeReason === "SOLIDTIME_TOKEN_INVALID" ? ValidationStatus.INVALID : ValidationStatus.ERROR;

    if (status === ValidationStatus.ERROR) {
      await recordStatus(credentialId, status);
      throw error;
    }
  }

  const at = await recordStatus(credentialId, status);
  return { valid: status === ValidationStatus.VALID, lastValidatedAt: at.toISOString() };
}

async function recordStatus(credentialId: string, status: ValidationStatus): Promise<Date> {
  const at = new Date();
  await prisma.credential.update({ where: { id: credentialId }, data: { lastValidatedAt: at, lastValidationStatus: status } });
  return at;
}

/** Marks the connection invalid when Solidtime rejects the token mid-session. */
export async function markSolidtimeInvalid(credentialId: string): Promise<void> {
  try {
    await recordStatus(credentialId, ValidationStatus.INVALID);
  } catch (error) {
    console.error("Recording validation result failed:", error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * The user's Solidtime connection linked to an Azure organization (with its
 * organization chosen), ready to read. Null when there is none.
 */
export async function linkedSolidtimeFor(userId: string, azureCredentialId: string, options: { background?: boolean } = {}) {
  // The oldest linked connection, the same one the browser picks.
  const link = await prisma.solidtimeConnection.findFirst({
    where: { azureCredentialId, organizationId: { not: null }, memberId: { not: null }, credential: { userId } },
    orderBy: { createdAt: "asc" },
    select: { credentialId: true },
  });

  if (!link) {
    return null;
  }

  const [client, connection] = await Promise.all([solidtimeClientFor(userId, link.credentialId, options), getSolidtimeConnection(userId, link.credentialId)]);

  if (!client || !connection.organizationId || !connection.memberId) {
    return null;
  }

  return { client, connection: { ...connection, organizationId: connection.organizationId, memberId: connection.memberId } };
}
