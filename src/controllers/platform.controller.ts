import type { Request, Response } from "express";
import { z } from "zod";

import { connectPlatform, listPlatforms, PLATFORM_IDS, PlatformFieldsError } from "../services/credentials/platform-registry.js";
import { sendError, sendValidationError } from "./controller-helpers.js";

const connectSchema = z
  .object({
    platform: z.enum(PLATFORM_IDS),
    // An empty label means none.
    label: z
      .string()
      .trim()
      .max(100, "Label must not exceed 100 characters")
      .optional()
      .transform((value) => (value ? value : undefined)),
    fields: z.record(z.string(), z.string().max(5000, "This value is too long")),
  })
  .strict();

/** The platforms a credential can be added for, with the fields each one needs. */
export function listPlatformsController(_req: Request, res: Response): void {
  res.json({ platforms: listPlatforms() });
}

/** Adds a credential for any platform in the registry; the platform's own rules validate and save it. */
export async function connectPlatformController(req: Request, res: Response): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ message: "Authentication required" });
    return;
  }

  const body = connectSchema.safeParse(req.body);

  if (!body.success) {
    sendValidationError(res, body.error);
    return;
  }

  try {
    const result = await connectPlatform(req.userId, body.data);
    res.status(201).json({ message: `${result.name} connected`, ...result });
  } catch (error) {
    if (error instanceof PlatformFieldsError) {
      sendValidationError(res, error.zodError);
      return;
    }

    await sendError(res, error, "Adding the credential failed");
  }
}
