import { z } from "zod";

type NormalizedOrganizationUrl =
  | { ok: true; url: string }
  | { ok: false; message: string };

function normalizeOrganizationUrl(
  value: string
): NormalizedOrganizationUrl {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      message:
        "Enter a valid organization URL, for example https://dev.azure.com/my-org",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      message: "Organization URL must use HTTPS",
    };
  }

  if (url.username || url.password || url.port || url.search || url.hash) {
    return {
      ok: false,
      message:
        "Organization URL must not contain credentials, a port, a query, or a fragment",
    };
  }

  const hostname = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");

  if (hostname === "dev.azure.com") {
    const organization = path.startsWith("/") ? path.slice(1) : path;

    if (
      !organization ||
      organization.includes("/") ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(organization)
    ) {
      return {
        ok: false,
        message:
          "Organization URL must look like https://dev.azure.com/<organization>",
      };
    }

    return {
      ok: true,
      url: `https://dev.azure.com/${organization.toLowerCase()}`,
    };
  }

  if (hostname.endsWith(".visualstudio.com")) {
    const organization = hostname.slice(
      0,
      -".visualstudio.com".length
    );

    if (
      !organization ||
      path ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(organization)
    ) {
      return {
        ok: false,
        message:
          "Organization URL must look like https://<organization>.visualstudio.com",
      };
    }

    return {
      ok: true,
      url: `https://${organization}.visualstudio.com`,
    };
  }

  return {
    ok: false,
    message: "Only Azure DevOps organization URLs are supported",
  };
}

export const organizationUrlSchema = z
  .string()
  .trim()
  .min(1, "Organization URL is required")
  .max(200, "Organization URL must not exceed 200 characters")
  .transform((value, ctx) => {
    const result = normalizeOrganizationUrl(value);

    if (!result.ok) {
      ctx.addIssue({
        code: "custom",
        message: result.message,
      });

      return z.NEVER;
    }

    return result.url;
  });

export const patTokenSchema = z
  .string()
  .trim()
  .min(20, "PAT must be at least 20 characters")
  .max(200, "PAT must not exceed 200 characters")
  .regex(/^\S+$/, "PAT must not contain whitespace");

export const createCredentialSchema = z.object({
  platform: z.literal("AZURE"),
  organizationUrl: organizationUrlSchema,
  label: z
    .string()
    .trim()
    .min(1, "Label must not be empty")
    .max(100, "Label must not exceed 100 characters")
    .optional(),
  patToken: patTokenSchema,
});

export const updateCredentialSchema = z
  .object({
    organizationUrl: organizationUrlSchema.optional(),
    label: z
      .string()
      .trim()
      .min(1, "Label must not be empty")
      .max(100, "Label must not exceed 100 characters")
      .nullable()
      .optional(),
    patToken: patTokenSchema.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message:
      "At least one of organizationUrl, label, or patToken is required",
    path: ["body"],
  });

export const credentialIdSchema = z
  .string()
  .uuid("Invalid credential id");
