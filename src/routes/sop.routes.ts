import { Router } from "express";

import {
  getDefaultRulebookController,
  getDefaultVersionController,
  getEffectiveRulebookController,
  getPersonalRulebookController,
  getPersonalVersionController,
  listDefaultVersionsController,
  listPersonalVersionsController,
  saveDefaultRulebookController,
  enqueueAiChecksController,
  listAiChecksController,
  savePersonalRulebookController,
  testSopRulesController,
  validateRulebookController,
} from "../controllers/sop.controller.js";
import { requireJson } from "../controllers/controller-helpers.js";
import { requireSopAdmin } from "../lib/sop-admin.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { loadAzureCredential } from "../middleware/azure-credential.middleware.js";

// Mounted at /api/sop. Everyone can read the default rules; only SOP owners save them.
const router = Router();

router.use(authenticate);

router.get("/rulebook", getDefaultRulebookController);
router.get("/rulebook/versions", listDefaultVersionsController);
router.get("/rulebook/versions/:version", getDefaultVersionController);
router.put("/rulebook", requireJson, requireSopAdmin, saveDefaultRulebookController);
router.get("/my-rules", getPersonalRulebookController);
router.get("/my-rules/versions", listPersonalVersionsController);
router.get("/my-rules/versions/:version", getPersonalVersionController);
router.put("/my-rules", requireJson, savePersonalRulebookController);
router.post("/validate", requireJson, validateRulebookController);
router.get("/effective", getEffectiveRulebookController);
// Reads one ticket from Azure to try rules on it; never writes to Azure.
router.post("/test/:credentialId", requireJson, loadAzureCredential, testSopRulesController);
// AI checks: results are private to the signed-in user.
router.post("/ai/:credentialId/check", requireJson, loadAzureCredential, enqueueAiChecksController);
router.get("/ai/:credentialId/results", loadAzureCredential, listAiChecksController);

export default router;
