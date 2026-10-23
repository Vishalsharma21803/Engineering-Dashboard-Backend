import { Router } from "express";

import {
  approveActionController,
  getActionController,
  listActionsController,
  proposeActionController,
  rejectActionController,
} from "../controllers/action.controller.js";
import { requireJson } from "../controllers/controller-helpers.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authenticate, requireJson);

router.post("/", proposeActionController);
router.get("/", listActionsController);
router.get("/:id", getActionController);
router.post("/:id/approve", approveActionController);
router.post("/:id/reject", rejectActionController);

export default router;
