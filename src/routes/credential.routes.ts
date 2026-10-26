import { Router } from "express";

import {
  createCredentialController,
  deleteCredentialController,
  listCredentialsController,
  updateCredentialController,
  validateCredentialController,
} from "../controllers/credential.controller.js";
import { requireJson } from "../controllers/controller-helpers.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authenticate);

router.post("/", requireJson, createCredentialController);
router.get("/", listCredentialsController);
router.patch("/:id", requireJson, updateCredentialController);
router.post("/:id/validate", validateCredentialController);
router.delete("/:id", deleteCredentialController);

export default router;
