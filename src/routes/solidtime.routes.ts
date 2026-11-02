import { Router } from "express";

import { requireJson } from "../controllers/controller-helpers.js";
import {
  accuracyController,
  verificationController,
  catalogController,
  profileController,
  draftController,
  draftEstimateController,
  timeCsvController,
  createConnectionController,
  listClientsController,
  listConnectionsController,
  listMembershipsController,
  listProjectsController,
  listTagsController,
  listTasksController,
  ticketTimeController,
  ticketTimesController,
  timerController,
  timesheetController,
  unlinkedController,
  updateConnectionController,
  validateConnectionController,
} from "../controllers/solidtime.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { loadSolidtimeConnection } from "../middleware/solidtime-connection.middleware.js";

// Mounted at /api/solidtime. Connections are managed here; everything under
// /:credentialId only reads Solidtime. Changes go through /api/actions (approval).
const router = Router();

router.use(authenticate);

router.get("/connections", listConnectionsController);
router.post("/connections", requireJson, createConnectionController);
router.patch("/connections/:credentialId", requireJson, updateConnectionController);
router.post("/connections/:credentialId/validate", validateConnectionController);
router.get("/connections/:credentialId/memberships", listMembershipsController);

const read = Router({ mergeParams: true });
read.use(loadSolidtimeConnection);
read.get("/profile", profileController);
read.get("/catalog", catalogController);
read.get("/projects", listProjectsController);
read.get("/tasks", listTasksController);
read.get("/tags", listTagsController);
read.get("/clients", listClientsController);
read.get("/timer", timerController);
read.get("/timesheet", timesheetController);
read.get("/unlinked", unlinkedController);
read.get("/tickets/:ticketId/time", ticketTimeController);
read.get("/ticket-times", ticketTimesController);
read.get("/draft", draftController);
read.get("/verification", verificationController);
read.get("/reports/accuracy", accuracyController);
read.get("/reports/time.csv", timeCsvController);

// Not a Solidtime change: asks the user's AI for hours on a draft (POST: it spends AI credit).
router.post("/:credentialId/draft/estimate", requireJson, loadSolidtimeConnection, draftEstimateController);

router.use("/:credentialId", read);

export default router;
