
import "express-serve-static-core";
import type { AzureClient } from "../lib/azure/client.js";
import type { SolidtimeClient } from "../lib/solidtime/client.js";
import type { SolidtimeConnectionDto } from "../services/solidtime/connection.service.js";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
    azure?: {
      client: AzureClient;
      credentialId: string;
    };
    /** Set by loadSolidtimeConnection for /api/solidtime/:credentialId routes. */
    solidtime?: {
      client: SolidtimeClient;
      connection: SolidtimeConnectionDto & { organizationId: string; memberId: string };
    };
  }
}
