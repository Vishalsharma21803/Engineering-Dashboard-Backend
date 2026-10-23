import type { AzureClient } from "../../lib/azure/client.js";
import type {
  RawCommit,
  RawList,
  RawRef,
  RawRepository,
} from "../../lib/azure/azure-api.types.js";
import type {
  AzureIdentity,
  BranchSummary,
  CommitSummary,
  RepositorySummary,
} from "../../types/azure.types.js";
import { stripRefPrefix, toIdentityRef } from "./mappers.js";

const BRANCH_PAGE_SIZE = 200;
const BRANCH_MAX_PAGES = 5;

export async function listRepositories(
  client: AzureClient,
  projectId: string
): Promise<RepositorySummary[]> {
  const data = await client.get<RawList<RawRepository>>([
    projectId,
    "_apis",
    "git",
    "repositories",
  ]);

  return (data.value ?? [])
    .map((repo) => ({
      id: repo.id,
      name: repo.name,
      defaultBranch: stripRefPrefix(repo.defaultBranch),
      size: repo.size ?? null,
      isDisabled: repo.isDisabled ?? false,
      webUrl: repo.webUrl ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listBranches(
  client: AzureClient,
  projectId: string,
  repositoryId: string
): Promise<{ branches: BranchSummary[]; truncated: boolean }> {
  const { items, truncated } = await client.getAll<RawRef>(
    [projectId, "_apis", "git", "repositories", repositoryId, "refs"],
    { query: { filter: "heads/", $top: BRANCH_PAGE_SIZE }, maxPages: BRANCH_MAX_PAGES }
  );

  return {
    branches: items.map((ref) => ({
      name: stripRefPrefix(ref.name) ?? ref.name,
      objectId: ref.objectId,
      creator: toIdentityRef(ref.creator),
    })),
    truncated,
  };
}

export async function listCommits(
  client: AzureClient,
  identity: AzureIdentity,
  projectId: string,
  repositoryId: string,
  options: { mine: boolean; branch?: string | undefined; top: number }
): Promise<CommitSummary[]> {
  const data = await client.get<RawList<RawCommit>>(
    [projectId, "_apis", "git", "repositories", repositoryId, "commits"],
    {
      query: {
        "searchCriteria.$top": options.top,
        "searchCriteria.author": options.mine
          ? (identity.email ?? identity.displayName)
          : undefined,
        "searchCriteria.itemVersion.version": options.branch,
      },
    }
  );

  return (data.value ?? []).map((commit) => ({
    commitId: commit.commitId,
    author: {
      name: commit.author?.name ?? "Unknown",
      email: commit.author?.email ?? null,
      date: commit.author?.date ?? null,
    },
    comment: commit.comment ?? "",
    webUrl: commit.remoteUrl ?? null,
  }));
}
