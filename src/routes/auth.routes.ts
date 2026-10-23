
import { Router } from "express";
import {
  login,
  register,
  me,
  logout,
} from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";


const router = Router();

router.post("/register", register);
router.post("/login", login);
router.get("/me", authenticate, me );
router.post("/logout", logout);

export default router;
