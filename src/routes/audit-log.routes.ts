import { Router } from "express";

import { listAuditLogsController } from "../controllers/action.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

// Read-only: audit rows are append-only and cannot be changed through the API.
const router = Router();

router.use(authenticate);

router.get("/", listAuditLogsController);

export default router;
