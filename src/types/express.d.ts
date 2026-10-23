
import "express-serve-static-core";
import type { AzureClient } from "../lib/azure/client.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    azure?: {
      client: AzureClient;
      credentialId: string;
    };
  }
}
