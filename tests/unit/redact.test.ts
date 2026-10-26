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

  it("applies to provider error messages shown to users", () => {
    expect(providerMessage(JSON.stringify({ error: { message: "Bad key sk-ant-api03-SECRETSECRET" } }))).toBe("Bad key [redacted]");
  });
});
