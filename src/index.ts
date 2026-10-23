import "dotenv/config";

import { createApp } from "./app.js";
import { assertEncryptionConfigured } from "./lib/encryption.js";

assertEncryptionConfigured();

const app = createApp();

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`server is listening on port ${PORT}`);
});
