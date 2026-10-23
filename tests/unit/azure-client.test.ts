import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { ApprovalTicket, isTicketConsumed } from "../../src/lib/azure/approval-ticket.js";
import { AzureClient, toReleaseManagementUrl } from "../../src/lib/azure/client.js";
import { AzureApiError } from "../../src/lib/azure/errors.js";
import { server } from "../setup.js";

const ORG = "https://dev.azure.com/unit-org";
const PAT = "unit-test-pat-0123456789abcdef";

function client(credentialId = "cred-unit", refresh = false) {
  return new AzureClient({ credentialId, organizationUrl: ORG, patToken: PAT, refresh });
}

function connectionData(status = 200) {
  return http.get(`${ORG}/_apis/connectionData`, () =>
    status === 200
      ? HttpResponse.json({ authenticatedUser: { id: "me" } })
      : new HttpResponse(null, { status })
  );
}

async function reasonOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AzureApiError) {
      return error.reason;
    }

    return error instanceof Error ? error.message : "unknown";
  }

  return "resolved";
}

describe("AzureClient", () => {
  it("sends Basic auth with the PAT and the api-version", async () => {
    let seen: Request | null = null;
    server.use(
      http.get(`${ORG}/_apis/projects`, ({ request }) => {
        seen = request;
        return HttpResponse.json({ value: [] });
      })
    );

    await client().get(["_apis", "projects"]);

    expect(seen!.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`
    );
    expect(new URL(seen!.url).searchParams.get("api-version")).toBe("7.1");
  });

  it("encodes each path segment and rejects traversal segments", () => {
    const url = client().buildUrl(["My Project/../x", "_apis", "wit"]);
    expect(url.pathname).toBe("/unit-org/My%20Project%2F..%2Fx/_apis/wit");
    expect(() => client().buildUrl(["..", "_apis"])).toThrow("INVALID_AZURE_PATH_SEGMENT");
  });

  it("derives the release management host", () => {
    expect(toReleaseManagementUrl("https://dev.azure.com/org")).toBe("https://vsrm.dev.azure.com/org");
    expect(toReleaseManagementUrl("https://org.visualstudio.com")).toBe("https://org.vsrm.visualstudio.com");
  });

  it.each([
    [203, "AZURE_PAT_INVALID"],
    [302, "AZURE_PAT_INVALID"],
    [403, "AZURE_INSUFFICIENT_SCOPE"],
    [404, "AZURE_NOT_FOUND"],
    [409, "AZURE_CONFLICT"],
    [412, "AZURE_CONFLICT"],
    [400, "AZURE_BAD_REQUEST"],
    [500, "AZURE_UPSTREAM_ERROR"],
  ])("maps status %i to %s", async (status, reason) => {
    server.use(http.get(`${ORG}/_apis/projects`, () => new HttpResponse(null, { status })));
    expect(await reasonOf(client().get(["_apis", "projects"], { cacheTtlMs: 0 }))).toBe(reason);
  });

  it("treats 401 as a missing scope when the PAT itself is still valid", async () => {
    server.use(
      connectionData(200),
      http.get(`${ORG}/p/_apis/build/builds`, () => new HttpResponse(null, { status: 401 }))
    );

    expect(await reasonOf(client().get(["p", "_apis", "build", "builds"]))).toBe(
      "AZURE_INSUFFICIENT_SCOPE"
    );
  });

  it("treats 401 as an invalid PAT when connectionData also fails", async () => {
    server.use(
      connectionData(401),
      http.get(`${ORG}/p/_apis/build/builds`, () => new HttpResponse(null, { status: 401 }))
    );

    expect(await reasonOf(client().get(["p", "_apis", "build", "builds"]))).toBe(
      "AZURE_PAT_INVALID"
    );
  });

  it("treats an HTML 200 (sign-in page) as an invalid PAT", async () => {
    server.use(http.get(`${ORG}/_apis/projects`, () => HttpResponse.html("<html>Sign in</html>")));
    expect(await reasonOf(client().get(["_apis", "projects"]))).toBe("AZURE_PAT_INVALID");
  });

  it("maps network failures to an upstream error", async () => {
    server.use(http.get(`${ORG}/_apis/projects`, () => HttpResponse.error()));
    expect(await reasonOf(client().get(["_apis", "projects"]))).toBe("AZURE_UPSTREAM_ERROR");
  });

  it("retries a read once when throttled with a short Retry-After", async () => {
    let calls = 0;
    server.use(
      http.get(`${ORG}/_apis/projects`, () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, { status: 429, headers: { "Retry-After": "0" } })
          : HttpResponse.json({ value: [{ id: "1" }] });
      })
    );

    await expect(client().get(["_apis", "projects"])).resolves.toEqual({ value: [{ id: "1" }] });
    expect(calls).toBe(2);
  });

  it("does not wait on long Retry-After values", async () => {
    server.use(
      http.get(`${ORG}/_apis/projects`, () =>
        new HttpResponse(null, { status: 429, headers: { "Retry-After": "120" } })
      )
    );

    const error = await client().get(["_apis", "projects"]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AzureApiError);
    expect((error as AzureApiError).retryAfterSeconds).toBe(120);
    expect((error as AzureApiError).httpStatus).toBe(503);
  });

  it("follows continuation tokens", async () => {
    server.use(
      http.get(`${ORG}/_apis/projects`, ({ request }) => {
        const token = new URL(request.url).searchParams.get("continuationToken");
        return token
          ? HttpResponse.json({ value: [{ id: "2" }] })
          : HttpResponse.json({ value: [{ id: "1" }] }, { headers: { "x-ms-continuationtoken": "next" } });
      })
    );

    const result = await client().getAll<{ id: string }>(["_apis", "projects"]);
    expect(result).toEqual({ items: [{ id: "1" }, { id: "2" }], truncated: false });
  });

  it("caches reads per credential and bypasses the cache on refresh", async () => {
    let calls = 0;
    server.use(
      http.get(`${ORG}/_apis/projects`, () => {
        calls += 1;
        return HttpResponse.json({ value: [] });
      })
    );

    await client("cache-a").get(["_apis", "projects"]);
    await client("cache-a").get(["_apis", "projects"]);
    expect(calls).toBe(1);

    await client("cache-b").get(["_apis", "projects"]);
    expect(calls).toBe(2);

    await client("cache-a", true).get(["_apis", "projects"]);
    expect(calls).toBe(3);
  });

  it("allows only allowlisted read POSTs without a ticket", async () => {
    let posted = false;
    server.use(
      http.post(`${ORG}/*`, () => {
        posted = true;
        return HttpResponse.json({});
      })
    );

    await expect(client().readPost(["_apis", "wit", "workitems"], {})).rejects.toThrow(
      "WRITE_WITHOUT_APPROVAL"
    );
    expect(posted).toBe(false);
  });

  it("refuses writes without a valid, unused ticket for the same credential", async () => {
    let writes = 0;
    server.use(
      http.patch(`${ORG}/*`, () => {
        writes += 1;
        return HttpResponse.json({ id: 1 });
      })
    );

    const azure = client("cred-w");

    await expect(
      azure.write({} as ApprovalTicket, "PATCH", ["_apis", "wit", "workitems", "1"], [])
    ).rejects.toThrow("WRITE_WITHOUT_APPROVAL");

    const foreignTicket = ApprovalTicket.issue("action-1", "other-credential");
    await expect(
      azure.write(foreignTicket, "PATCH", ["_apis", "wit", "workitems", "1"], [])
    ).rejects.toThrow("WRITE_WITHOUT_APPROVAL");
    expect(writes).toBe(0);

    const ticket = ApprovalTicket.issue("action-1", "cred-w");
    await azure.write(ticket, "PATCH", ["_apis", "wit", "workitems", "1"], []);
    expect(writes).toBe(1);

    await expect(
      azure.write(ticket, "PATCH", ["_apis", "wit", "workitems", "1"], [])
    ).rejects.toThrow("WRITE_WITHOUT_APPROVAL");
    expect(writes).toBe(1);
  });

  it("exposes the upstream validation message on rejected writes", async () => {
    server.use(
      http.patch(`${ORG}/*`, () =>
        HttpResponse.json({ message: "TF401320: Rule Error" }, { status: 400 })
      )
    );

    const error = await client("cred-msg")
      .write(ApprovalTicket.issue("a", "cred-msg"), "PATCH", ["_apis", "wit", "workitems", "1"], [])
      .catch((caught: unknown) => caught);

    expect((error as AzureApiError).upstreamMessage).toBe("TF401320: Rule Error");
  });

  it("accepts an accepted write with a non-JSON body", async () => {
    server.use(http.patch(`${ORG}/*`, () => new HttpResponse("ok", { status: 200 })));

    await expect(
      client("cred-empty").write(
        ApprovalTicket.issue("a", "cred-empty"),
        "PATCH",
        ["p", "_apis", "build", "builds", "1", "stages", "Build"],
        {}
      )
    ).resolves.toBeUndefined();
  });

  it("does not consume the ticket when the URL is invalid", async () => {
    const ticket = ApprovalTicket.issue("a", "cred-url");

    await expect(client("cred-url").write(ticket, "PATCH", [".."], {})).rejects.toThrow(
      "INVALID_AZURE_PATH_SEGMENT"
    );
    expect(isTicketConsumed(ticket)).toBe(false);
  });

  it("blocks unmocked external requests in tests", async () => {
    expect(await reasonOf(client().get(["_apis", "unmocked-endpoint"], { cacheTtlMs: 0 }))).toBe(
      "AZURE_UPSTREAM_ERROR"
    );
  });

  it("never serializes the PAT", () => {
    const serialized = JSON.stringify(client());
    expect(serialized).not.toContain(PAT);
    expect(serialized).not.toContain(Buffer.from(`:${PAT}`).toString("base64"));
  });
});
