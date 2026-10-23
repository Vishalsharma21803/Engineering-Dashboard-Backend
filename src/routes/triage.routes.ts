import { Router } from "express";

import { requireJson } from "../controllers/controller-helpers.js";
import {
  deleteTriageController,
  listTriageController,
  upsertTriageController,
} from "../controllers/triage.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

// Personal dashboard triage stored in Cockpit only; nothing here touches Azure DevOps.
const router = Router();

router.use(authenticate);

router.get("/", listTriageController);
router.put("/", requireJson, upsertTriageController);
// No body: cross-site forms cannot send DELETE, and cross-origin fetch needs CORS.
router.delete("/:id", deleteTriageController);

export default router;
