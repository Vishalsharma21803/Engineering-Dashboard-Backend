import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import { clearAzureCache } from "../src/lib/azure/cache.js";

/**
 * Intercepts outgoing calls. Test handlers (server.use) win; anything else
 * that is not localhost (supertest) fails instead of reaching the network.
 */
export const server = setupServer(
  http.all(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, ({ request }) => {
    console.error(`Unmocked external request blocked: ${request.method} ${request.url}`);
    return HttpResponse.error();
  })
);

beforeAll(() => {
  server.listen({ onUnhandledFrame: "bypass" });
});

beforeEach(() => {
  clearAzureCache();
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
