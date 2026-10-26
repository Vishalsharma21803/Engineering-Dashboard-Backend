import { Router } from "express";

import {
  createAiCredentialController,
  deleteAiCredentialController,
  getAiPreferenceController,
  getAiUsageController,
  getOpenRouterAllowlistController,
  listAiCredentialsController,
  listModelsController,
  setOpenRouterAllowlistController,
  updateAiCredentialController,
  updateAiPreferenceController,
  validateAiCredentialController,
} from "../controllers/ai.controller.js";
import { requireJson } from "../controllers/controller-helpers.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { requireSopAdmin } from "../lib/sop-admin.js";

// Mounted at /api/ai. Keys are write-only: no route ever returns one.
const router = Router();

router.use(authenticate);

// Routes with a body require JSON (cheap CSRF hardening); bodyless ones rely on SameSite cookies.
router.get("/credentials", listAiCredentialsController);
router.post("/credentials", requireJson, createAiCredentialController);
router.patch("/credentials/:id", requireJson, updateAiCredentialController);
router.delete("/credentials/:id", deleteAiCredentialController);
router.post("/credentials/:id/validate", validateAiCredentialController);
router.get("/models", listModelsController);
router.get("/preferences", getAiPreferenceController);
router.put("/preferences", requireJson, updateAiPreferenceController);
router.get("/usage", getAiUsageController);
router.get("/settings/openrouter-models", getOpenRouterAllowlistController);
router.put("/settings/openrouter-models", requireJson, requireSopAdmin, setOpenRouterAllowlistController);

export default router;
