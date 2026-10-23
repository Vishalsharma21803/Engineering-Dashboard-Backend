import type { z } from "zod";
import type {
  createCredentialSchema,
  updateCredentialSchema,
} from "../schemas/credential.schema.js";

export type CreateCredentialInput = z.infer<
  typeof createCredentialSchema
>;
export type UpdateCredentialInput = z.infer<
  typeof updateCredentialSchema
>;
