import { prisma } from "./prisma.js";
import { isProduction } from "./server-config.js";
import { isSopAdmin } from "./sop-admin.js";

/**
 * Who may create an account: SIGNUP_ALLOWED_EMAILS=a@x.com,*@company.com
 * (exact addresses, or `*@domain` for everyone at that domain). SOP owners
 * (SOP_ADMIN_EMAILS) may always sign up. Unset: open outside production,
 * closed in production. Existing accounts keep signing in either way.
 */
export interface SignupAllowList {
  exact: Set<string>;
  domains: Set<string>;
}

const EXACT = /^[^\s@,*]+@[^\s@,*]+\.[^\s@,*]+$/;
const DOMAIN = /^\*@([^\s@,*]+\.[^\s@,*]+)$/;

/** The allowlist (null when unset or blank) and any entries that are neither an address nor `*@domain`. */
export function parseSignupAllowList(value: string | undefined): { list: SignupAllowList | null; invalid: string[] } {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (entries.length === 0) {
    return { list: null, invalid: [] };
  }

  const list: SignupAllowList = { exact: new Set(), domains: new Set() };
  const invalid: string[] = [];

  for (const entry of entries) {
    const domain = DOMAIN.exec(entry)?.[1];

    if (domain) {
      list.domains.add(domain);
    } else if (EXACT.test(entry)) {
      list.exact.add(entry);
    } else {
      invalid.push(entry);
    }
  }

  return { list, invalid };
}

export function signupAllowList(): SignupAllowList | null {
  return parseSignupAllowList(process.env.SIGNUP_ALLOWED_EMAILS).list;
}

export function isSignupAllowed(email: string): boolean {
  const normalized = email.trim().toLowerCase();

  if (isSopAdmin(normalized)) {
    return true;
  }

  const list = signupAllowList();

  if (!list) {
    return !isProduction();
  }

  return list.exact.has(normalized) || list.domains.has(normalized.slice(normalized.lastIndexOf("@") + 1));
}

/**
 * Nothing verifies email addresses, so whoever signs up first with an SOP
 * owner's address becomes an SOP owner. Logged at startup so the owner claims it.
 */
export async function warnAboutUnclaimedSopAdminEmails(): Promise<void> {
  const emails = (process.env.SOP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (emails.length === 0) {
    return;
  }

  const claimed = new Set((await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } })).map((user) => user.email));
  const unclaimed = emails.filter((email) => !claimed.has(email));

  if (unclaimed.length > 0) {
    console.warn(
      `Warning: SOP_ADMIN_EMAILS lists ${unclaimed.join(", ")} without an account yet. Whoever signs up first with that address becomes an SOP owner: register it now.`
    );
  }
}
