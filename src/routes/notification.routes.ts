import { Router } from "express";

import { requireJson } from "../controllers/controller-helpers.js";
import {
  listNotificationsController,
  readAllNotificationsController,
  updateNotificationController,
} from "../controllers/notification.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

// Stored in Cockpit only; nothing here touches Azure DevOps or Solidtime.
const router = Router();

router.use(authenticate);

router.get("/", listNotificationsController);
router.post("/read-all", requireJson, readAllNotificationsController);
router.patch("/:id", requireJson, updateNotificationController);

export default router;
