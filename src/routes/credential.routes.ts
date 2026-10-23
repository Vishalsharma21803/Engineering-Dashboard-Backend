import { Router } from "express";

import {
  createCredentialController,
  deleteCredentialController,
  listCredentialsController,
  updateCredentialController,
  validateCredentialController,
} from "../controllers/credential.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();

router.use(authenticate);

router.post("/", createCredentialController);
router.get("/", listCredentialsController);
router.patch("/:id", updateCredentialController);
router.post("/:id/validate", validateCredentialController);
router.delete("/:id", deleteCredentialController);

export default router;
