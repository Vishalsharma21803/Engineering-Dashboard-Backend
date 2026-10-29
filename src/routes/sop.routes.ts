import { Router } from "express";

import {
  deleteSopReportRunController,
  getSopReportRunController,
  listSopReportRunsController,
  runSopReportController,
  getDefaultRulebookController,
  getDefaultVersionController,
  getEffectiveRulebookController,
  getPersonalRulebookController,
  getPersonalVersionController,
  listDefaultVersionsController,
  listPersonalVersionsController,
  saveDefaultRulebookController,
  editDefaultRulesController,
  editPersonalRulesController,
  enqueueAiChecksController,
  getRulesListController,
  listAiChecksController,
  listAzureProjectsForSopController,
  listProjectChangesController,
  listProjectSetUpsController,
  removeProjectSetUpController,
  saveProjectSetUpController,
  setProjectCheckedController,
  suggestProjectSetUpController,
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
router.get("/rules", getRulesListController);
router.post("/my-rules/edits", requireJson, editPersonalRulesController);
router.post("/rulebook/edits", requireJson, requireSopAdmin, editDefaultRulesController);
// Projects: anyone may set one up (changes are recorded); each user chooses which are checked for them.
router.get("/projects", listProjectSetUpsController);
router.put("/projects/:projectName", requireJson, saveProjectSetUpController);
router.delete("/projects/:projectName", removeProjectSetUpController);
router.get("/projects/:projectName/history", listProjectChangesController);
router.put("/projects/:projectName/checked", requireJson, setProjectCheckedController);
// Reads the organization's projects from Azure to offer and pre-fill set-ups.
router.get("/azure-projects/:credentialId", loadAzureCredential, listAzureProjectsForSopController);
router.get("/azure-projects/:credentialId/:projectId/suggestion", loadAzureCredential, suggestProjectSetUpController);
// Reads one ticket from Azure to try rules on it; never writes to Azure.
router.post("/test/:credentialId", requireJson, loadAzureCredential, testSopRulesController);
// AI checks: results are private to the signed-in user.
router.post("/ai/:credentialId/check", requireJson, loadAzureCredential, enqueueAiChecksController);
router.get("/ai/:credentialId/results", loadAzureCredential, listAiChecksController);
// Team report runs: read Azure, saved privately for the person who ran them (kept until they delete them).
router.post("/reports/:credentialId/:projectId", requireJson, loadAzureCredential, runSopReportController);
router.get("/reports/:credentialId/:projectId", loadAzureCredential, listSopReportRunsController);
router.get("/reports/:credentialId/:projectId/:runId", loadAzureCredential, getSopReportRunController);
router.delete("/reports/:credentialId/:projectId/:runId", loadAzureCredential, deleteSopReportRunController);

export default router;
