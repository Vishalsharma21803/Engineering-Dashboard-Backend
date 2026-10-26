
import { Router } from "express";
import {
  login,
  register,
  me,
  logout,
} from "../controllers/auth.controller.js";
import { requireJson } from "../controllers/controller-helpers.js";
import { authenticate } from "../middleware/auth.middleware.js";


const router = Router();

router.post("/register", requireJson, register);
router.post("/login", requireJson, login);
router.get("/me", authenticate, me );
router.post("/logout", logout);

export default router;
