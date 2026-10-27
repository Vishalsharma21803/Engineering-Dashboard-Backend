import { z } from "zod";

import { AppError } from "../../lib/app-error.js";
import { createAiCredentialSchema } from "../../schemas/ai.schema.js";
import { createCredentialSchema } from "../../schemas/credential.schema.js";
import { createSolidtimeConnectionSchema } from "../../schemas/solidtime.schema.js";
import { createAiCredential } from "../ai/ai-credential.service.js";
import { createCredential } from "../credential.service.js";
import { createSolidtimeConnection } from "../solidtime/connection.service.js";

/**
 * Every platform a user can add a credential for, defined once here. The
 * frontend draws the Add forms from this list (GET /api/credentials/platforms)
 * and sends one shape to POST /api/credentials/connect, which validates with the
 * platform's own schema and saves with its own service. Adding a platform means
 * adding an entry (fields + handler) here; storage stays in the existing tables.
 */

export type PlatformId = "azure" | "solidtime" | "claude" | "openrouter" | "opencode";
export type PlatformCategory = "integration" | "ai";
export type FieldType = "text" | "url" | "secret";

export interface PlatformField {
  /** The key sent in `fields`, and the field name in validation errors. */
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  hint?: string;
}

export interface PlatformDefinition {
  id: PlatformId;
  category: PlatformCategory;
  label: string;
  description: string;
  fields: PlatformField[];
  /** Where to create the token or key (shown as a link). */
  helpUrl?: string;
  /** AI providers: the provider enum the AI settings use. */
  aiProvider?: "CLAUDE" | "OPENROUTER" | "OPENCODE";
}

/** What was saved, for the response; `kind` tells which existing list it belongs to. */
export interface ConnectResult {
  kind: "credential" | "solidtime" | "ai";
  id: string;
  name: string;
  /** The created record as its own API returns it. */
  record: unknown;
}

interface PlatformEntry extends PlatformDefinition {
  connect: (userId: string, input: { label: string | undefined; fields: Record<string, string> }) => Promise<ConnectResult>;
}

/** Thrown with the platform schema's issues; field paths are the field names above. */
export class PlatformFieldsError extends Error {
  constructor(readonly zodError: z.ZodError) {
    super("Platform fields failed validation");
  }
}

function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new PlatformFieldsError(result.error);
  return result.data;
}

const labelPart = (label: string | undefined) => (label ? { label } : {});

function aiEntry(id: "claude" | "openrouter" | "opencode", provider: "CLAUDE" | "OPENROUTER" | "OPENCODE", meta: { label: string; description: string; placeholder: string; hint: string; helpUrl: string }): PlatformEntry {
  return {
    id,
    category: "ai",
    aiProvider: provider,
    label: meta.label,
    description: meta.description,
    helpUrl: meta.helpUrl,
    fields: [{ name: "apiKey", label: "API key", type: "secret", required: true, placeholder: meta.placeholder, hint: meta.hint }],
    connect: async (userId, { label, fields }) => {
      const input = parseWith(createAiCredentialSchema, { provider, apiKey: fields.apiKey ?? "", ...labelPart(label) });
      const credential = await createAiCredential(userId, input);
      return { kind: "ai", id: credential.id, name: meta.label, record: credential };
    },
  };
}

const ENTRIES: PlatformEntry[] = [
  {
    id: "azure",
    category: "integration",
    label: "Azure DevOps",
    description: "An organization URL and a personal access token. Cockpit reads your work items, pull requests and pipelines; changes are only proposed.",
    helpUrl: "https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate",
    fields: [
      { name: "organizationUrl", label: "Organization URL", type: "url", required: true, placeholder: "https://dev.azure.com/my-org", hint: "Use https://dev.azure.com/<organization> or https://<organization>.visualstudio.com." },
      { name: "patToken", label: "Personal access token", type: "secret", required: true, placeholder: "Paste your Azure DevOps PAT", hint: "Minimum 20 characters. Encrypted and never shown again." },
    ],
    connect: async (userId, { label, fields }) => {
      const input = parseWith(createCredentialSchema, { platform: "AZURE", organizationUrl: fields.organizationUrl ?? "", patToken: fields.patToken ?? "", ...labelPart(label) });

      try {
        const credential = await createCredential(userId, input);
        return { kind: "credential", id: credential.id, name: credential.label ?? credential.organizationUrl, record: credential };
      } catch (error) {
        if (error instanceof Error && error.message === "CREDENTIAL_ALREADY_EXISTS") {
          throw new AppError(409, "CREDENTIAL_ALREADY_EXISTS", "A credential for this Azure DevOps organization already exists");
        }
        throw error;
      }
    },
  },
  {
    id: "solidtime",
    category: "integration",
    label: "Solidtime",
    description: "Your Solidtime server and an API token, to track time on tickets. Every change to Solidtime is proposed first and runs after you approve it.",
    fields: [
      { name: "baseUrl", label: "Solidtime address", type: "url", required: true, placeholder: "https://", hint: "Your Solidtime server, e.g. https://time.example.com (or https://app.solidtime.io)." },
      { name: "token", label: "API token", type: "secret", required: true, hint: "In Solidtime: Profile settings → Create API token. Encrypted and never shown again." },
    ],
    connect: async (userId, { label, fields }) => {
      const input = parseWith(createSolidtimeConnectionSchema, { baseUrl: fields.baseUrl ?? "", token: fields.token ?? "", ...labelPart(label) });
      const result = await createSolidtimeConnection(userId, input);
      const connection = result.connection;
      return { kind: "solidtime", id: connection.credentialId, name: connection.label ?? connection.baseUrl.replace(/^https?:\/\//, ""), record: result };
    },
  },
  aiEntry("claude", "CLAUDE", {
    label: "Claude (Anthropic)",
    description: "Direct Claude API. Best quality and reliable JSON verdicts for SOP checks.",
    placeholder: "sk-ant-…",
    hint: "Create a key in the Anthropic Console and set a spend limit there.",
    helpUrl: "https://console.anthropic.com/settings/keys",
  }),
  aiEntry("openrouter", "OPENROUTER", {
    label: "OpenRouter",
    description: "Many models from many vendors, including free ones such as DeepSeek.",
    placeholder: "sk-or-…",
    hint: "Create a key in OpenRouter. Free models allow a limited number of requests per day.",
    helpUrl: "https://openrouter.ai/settings/keys",
  }),
  aiEntry("opencode", "OPENCODE", {
    label: "OpenCode",
    description: "OpenCode's pay-as-you-go gateway: DeepSeek, GLM, Kimi, MiniMax, Qwen and its free models.",
    placeholder: "Paste your API key",
    hint: "Create a key at opencode.ai. Checking the key is free. Its free models may only work inside the OpenCode app; paid models need credit.",
    helpUrl: "https://opencode.ai/auth",
  }),
];

const BY_ID = new Map(ENTRIES.map((entry) => [entry.id, entry]));
export const PLATFORM_IDS = ENTRIES.map((entry) => entry.id) as [PlatformId, ...PlatformId[]];

/** The registry as the browser sees it (no handlers). */
export function listPlatforms(): PlatformDefinition[] {
  return ENTRIES.map(({ connect: _connect, ...definition }) => definition);
}

/** Validates `fields` against the platform's own schema and saves them with its own service. */
export async function connectPlatform(userId: string, input: { platform: PlatformId; label?: string | undefined; fields: Record<string, string> }): Promise<ConnectResult> {
  const entry = BY_ID.get(input.platform);

  if (!entry) {
    throw new AppError(404, "PLATFORM_NOT_FOUND", "This platform is not supported");
  }

  // Only the platform's own fields go through.
  const known = new Set(entry.fields.map((field) => field.name));
  const fields = Object.fromEntries(Object.entries(input.fields).filter(([name]) => known.has(name)));
  return entry.connect(userId, { label: input.label, fields });
}
