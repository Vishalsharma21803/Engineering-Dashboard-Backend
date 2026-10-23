import type { z } from "zod";
import type { createCredentialSchema } from "../schemas/credential.schema.js";

export type CreateCredentialInput = z.infer<
  typeof createCredentialSchema
>;
