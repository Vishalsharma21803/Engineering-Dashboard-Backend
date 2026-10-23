import "dotenv/config";

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import authRoutes from "./routes/auth.routes.js";
import credentialRoutes from "./routes/credential.routes.js";
import { assertEncryptionConfigured } from "./lib/encryption.js";

assertEncryptionConfigured();

const app = express();

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN ?? "http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/", (_req, res) => {
  res.json({ message: "all is working fine" });
});

app.use("/api/auth", authRoutes);
app.use("/api/credentials", credentialRoutes);

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`server is listening on port ${PORT}`);
});
