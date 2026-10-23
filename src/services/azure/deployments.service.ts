import type { AzureClient } from "../../lib/azure/client.js";
import type {
  RawEnvironment,
  RawEnvironmentDeployment,
  RawList,
  RawRelease,
} from "../../lib/azure/azure-api.types.js";
import { createLimiter, mapWithLimit } from "../../lib/azure/limiter.js";
import type { Deployments } from "../../types/azure.types.js";
import { toSection } from "./section.js";

const ENVIRONMENTS_API_VERSION = "7.1-preview.1";
const MAX_ENVIRONMENTS = 25;
const DEPLOYMENTS_PER_ENVIRONMENT = 5;
const RELEASES_TOP = 20;

export async function getDeployments(
  client: AzureClient,
  projectId: string
): Promise<Deployments> {
  const limit = createLimiter(4);

  const [environments, releases] = await Promise.all([
    toSection(async () => {
      const data = await client.get<RawList<RawEnvironment>>(
        [projectId, "_apis", "distributedtask", "environments"],
        { apiVersion: ENVIRONMENTS_API_VERSION, query: { $top: MAX_ENVIRONMENTS } }
      );

      return mapWithLimit(data.value ?? [], limit, async (environment) => {
        const records = await client.get<RawList<RawEnvironmentDeployment>>(
          [
            projectId,
            "_apis",
            "distributedtask",
            "environments",
            String(environment.id),
            "environmentdeploymentrecords",
          ],
          {
            apiVersion: ENVIRONMENTS_API_VERSION,
            query: { top: DEPLOYMENTS_PER_ENVIRONMENT },
          }
        );

        return {
          environmentId: environment.id,
          environmentName: environment.name,
          lastDeployments: (records.value ?? []).map((record) => ({
            id: record.id,
            definitionName: record.definition?.name ?? null,
            stageName: record.stageName ?? null,
            result: record.result ?? null,
            startTime: record.startTime ?? null,
            finishTime: record.finishTime ?? null,
            buildId: record.owner?.id ?? null,
          })),
        };
      });
    }),
    toSection(async () => {
      const data = await client.get<RawList<RawRelease>>(
        [projectId, "_apis", "release", "releases"],
        {
          host: "vsrm",
          query: { $top: RELEASES_TOP, $expand: "environments" },
        }
      );

      return (data.value ?? []).map((release) => ({
        id: release.id,
        name: release.name,
        status: release.status ?? "unknown",
        definitionName: release.releaseDefinition?.name ?? null,
        createdOn: release.createdOn ?? null,
        environments: (release.environments ?? []).map((environment) => ({
          name: environment.name ?? "Unknown",
          status: environment.status ?? "unknown",
        })),
        webUrl: release._links?.web?.href ?? null,
      }));
    }),
  ]);

  return { environments, releases };
}
