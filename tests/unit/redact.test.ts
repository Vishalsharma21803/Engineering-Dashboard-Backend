import { describe, expect, it } from "vitest";

import { redactSecrets } from "../../src/lib/redact.js";
import { providerMessage } from "../../src/lib/ai/types.js";

describe("redactSecrets", () => {
  it("removes provider keys and long tokens but keeps ids and normal text", () => {
    expect(redactSecrets("Invalid key sk-or-v1-abcdef0123456789 supplied")).toBe("Invalid key [redacted] supplied");
    expect(redactSecrets("token 3k5w7xq9p2m4n6b8v0c1z3a5s7d9f2g4h6j8k0l2q4w6e8r0t2 rejected")).toBe("token [redacted] rejected");
    expect(redactSecrets("Project aaaaaaaa-0000-4000-8000-000000000001 not found")).toBe("Project aaaaaaaa-0000-4000-8000-000000000001 not found");
    expect(redactSecrets("TF401289: The field 'Remaining Work' is required.")).toBe("TF401289: The field 'Remaining Work' is required.");
  });

  it("keeps URL paths readable but still removes a token inside one", () => {
    const path = "GET api/v1/organizations/aaaaaaaa-0000-4000-8000-000000000001/time-entries failed";
    expect(redactSecrets(path)).toBe(path);
    expect(redactSecrets("_apis/wit/workitems/12345/updates/latest timed out")).toBe("_apis/wit/workitems/12345/updates/latest timed out");
    expect(redactSecrets("orgs/3k5w7xq9p2m4n6b8v0c1z3a5s7d9f2g4h6j8k0l2q4w6e8r0t2/projects")).toBe("orgs/[redacted]/projects");
  });

  it("removes base64 keys that contain / or +", () => {
    expect(redactSecrets("key q8Zt/9xY+3kLmN0pQ4rS7tUv/W2xYz5aB6cD8eF1gH== leaked")).toBe("key [redacted] leaked");
    expect(redactSecrets("key q8Zt9xY3kLmN0pQ4/rS7tUvW2xYz5aB6cD8eF1gH leaked")).toBe("key [redacted] leaked");
  });

  it("applies to provider error messages shown to users", () => {
    expect(providerMessage(JSON.stringify({ error: { message: "Bad key sk-ant-api03-SECRETSECRET" } }))).toBe("Bad key [redacted]");
  });
});
