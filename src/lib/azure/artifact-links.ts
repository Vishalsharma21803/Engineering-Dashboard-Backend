export interface PullRequestArtifact {
  projectId: string;
  repositoryId: string;
  pullRequestId: number;
}

export type ArtifactLink =
  | ({ kind: "pullRequest" } & PullRequestArtifact)
  | { kind: "commit"; projectId: string; repositoryId: string; commitId: string }
  | { kind: "branch"; projectId: string; repositoryId: string; refName: string }
  | { kind: "build"; buildId: number };

const PREFIX = "vstfs:///";

function splitArtifactId(value: string): string[] {
  // Artifact ids are "/"-separated after URL-decoding (%2F or %2f).
  return decodeURIComponent(value).split("/");
}

/** Parses Azure DevOps vstfs:/// artifact URIs found on work item relations. */
export function parseArtifactLink(uri: string): ArtifactLink | null {
  if (!uri.toLowerCase().startsWith(PREFIX.toLowerCase())) {
    return null;
  }

  const [tool, type, ...rest] = uri.slice(PREFIX.length).split("/");
  const id = rest.join("/");

  if (!tool || !type || !id) {
    return null;
  }

  let parts: string[];

  try {
    parts = splitArtifactId(id);
  } catch {
    return null;
  }

  const kind = `${tool}/${type}`.toLowerCase();

  if (kind === "git/pullrequestid" && parts.length === 3) {
    const [projectId, repositoryId, prId] = parts;
    const pullRequestId = Number(prId);

    if (projectId && repositoryId && Number.isInteger(pullRequestId) && pullRequestId > 0) {
      return { kind: "pullRequest", projectId, repositoryId, pullRequestId };
    }
  }

  if (kind === "git/commit" && parts.length === 3) {
    const [projectId, repositoryId, commitId] = parts;

    if (projectId && repositoryId && commitId) {
      return { kind: "commit", projectId, repositoryId, commitId };
    }
  }

  if (kind === "git/ref" && parts.length >= 3) {
    const [projectId, repositoryId, ...refParts] = parts;
    const refName = refParts.join("/").replace(/^GB/, "");

    if (projectId && repositoryId && refName) {
      return { kind: "branch", projectId, repositoryId, refName };
    }
  }

  if (kind === "build/build" && parts.length === 1) {
    const buildId = Number(parts[0]);

    if (Number.isInteger(buildId) && buildId > 0) {
      return { kind: "build", buildId };
    }
  }

  return null;
}

export function pullRequestArtifactUri(pr: PullRequestArtifact): string {
  return `${PREFIX}Git/PullRequestId/${encodeURIComponent(
    `${pr.projectId}/${pr.repositoryId}/${pr.pullRequestId}`
  )}`;
}
