import type { Prisma } from "../../generated/prisma/client.js";
import type { ActionScopeFilter } from "../../schemas/action.schema.js";

/** Prisma filter for actions in one organization and/or project (id or name, either case). */
export function actionScopeWhere(scope: ActionScopeFilter): Prisma.ProposedActionWhereInput {
  const projects = [scope.projectId, scope.projectName].filter((value): value is string => Boolean(value));

  return {
    ...(scope.credentialId ? { credentialId: scope.credentialId } : {}),
    ...(projects.length ? { OR: projects.map((value) => ({ projectId: { equals: value, mode: "insensitive" as const } })) } : {}),
  };
}
