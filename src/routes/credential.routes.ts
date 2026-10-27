import { Router } from "express";

import {
  createCredentialController,
  deleteCredentialController,
  listCredentialsController,
  updateCredentialController,
  validateCredentialController,
} from "../controllers/credential.controller.js";
import { requireJson } from "../controllers/controller-helpers.js";
import { connectPlatformController, listPlatformsController } from "../controllers/platform.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authenticate);

router.post("/", requireJson, createCredentialController);
// The platform registry: what can be added, and one way to add any of it.
router.get("/platforms", listPlatformsController);
router.post("/connect", requireJson, connectPlatformController);
router.get("/", listCredentialsController);
router.patch("/:id", requireJson, updateCredentialController);
router.post("/:id/validate", validateCredentialController);
router.delete("/:id", deleteCredentialController);

export default router;
