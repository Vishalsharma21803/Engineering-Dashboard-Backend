import { prisma } from "../../lib/prisma.js";
import { blockSpans, parseRulebook } from "./rulebook.parser.js";
import { STARTER_RULEBOOK } from "./starter-rulebook.js";

export interface RuleLevelUpdate {
  /** AppSetting key recording that this update ran. */
  key: string;
  /** Rules shown as notices on the ticket instead of counting as SOP gaps. */
  notices: Set<string>;
  /** Rules taken out of the SOP. */
  removed: Set<string>;
  /** Cards replaced by the starter's (their checker changed). */
  replaced: Set<string>;
  /** New starter cards added at the end, unless the rulebook already has a rule with that id. */
  added?: string[];
  note: string;
}

/** Agreed changes to the rules, applied once each, in order. */
export const RULE_LEVEL_UPDATES: RuleLevelUpdate[] = [
  {
    key: "sop.ruleLevelsUpdated",
    notices: new Set(["STR-04", "STR-10", "STR-11", "STR-12", "STR-13", "ACT-03", "TST-01", "TST-02"]),
    removed: new Set(["DEV-01", "DONE-09", "ALW-01"]),
    // AI rules that became plain "is it filled in" code checks.
    replaced: new Set(["STR-06", "STR-07"]),
    note:
      "Rule levels updated: STR-04, STR-10, STR-11, STR-12, STR-13, ACT-03, TST-01 and TST-02 are notices (not gaps); " +
      "STR-06 and STR-07 only check that the description and acceptance criteria are filled in; " +
      "DEV-01, DONE-09 and ALW-01 removed; DONE-01 with no pull request is a notice.",
  },
  {
    key: "sop.ruleLevelsUpdated.2",
    notices: new Set(),
    removed: new Set(["STR-01", "PR-07"]),
    // New wording: pull requests without a reviewer are not counted.
    replaced: new Set(["MRG-01"]),
    note: "STR-01 (title length) and PR-07 (pull request target branch) removed; MRG-01 no longer counts pull requests without a reviewer.",
  },
  {
    key: "sop.ruleLevelsUpdated.3",
    notices: new Set(["PR-01", "STR-09"]),
    removed: new Set(["ALW-02"]),
    // New wording: STR-14 leaves the due date to STR-04; PR-05 and ACT-06 skip the PR and branch parts when none is linked.
    replaced: new Set(["STR-14", "PR-05", "ACT-06"]),
    note:
      "PR-01 (no pull request linked) and STR-09 (TL approval) are notices; ALW-02 removed; STR-14 no longer asks for the due date; " +
      "PR-05 and ACT-06 only ask for the PR or branch when one is linked.",
  },
  {
    key: "sop.ruleLevelsUpdated.4",
    notices: new Set(),
    removed: new Set(["STR-14"]),
    // Code now decides whether these exist (wording-tolerant); the AI review on the ticket page can clear or improve them.
    replaced: new Set(["STR-08", "STR-09", "STR-15", "ACT-06", "PR-05", "TST-02"]),
    added: ["STR-16", "TIME-01", "TRN-01", "REV-01", "DONE-10"],
    note:
      "STR-08, STR-09, STR-15, ACT-06, PR-05 and TST-02 are code checks (the AI review on the ticket page can clear or improve them); " +
      "STR-14 removed (estimate is STR-05, daily time is TIME-01); new notices: STR-16 target completion, TIME-01 daily time, " +
      "TRN-01 comment on every state change, REV-01 assigned to the reviewer, DONE-10 final comment.",
  },
];

const SEVERITY_LINE = /^\s*severity:\s*["']?([a-z]+)["']?\s*(#.*)?$/;

function starterBlocks(): Map<string, string[]> {
  const { lines, spans } = blockSpans(STARTER_RULEBOOK);
  return new Map(
    spans.flatMap((span) => (typeof span.header?.id === "string" ? [[span.header.id, lines.slice(span.start, span.end)] as const] : []))
  );
}

/**
 * Applies the agreed rule levels to a rulebook's text, block by block, leaving
 * everything else (other rules, wording, comments) exactly as it was. A rule
 * someone switched off stays off.
 */
export function applyRuleLevels(content: string, update: RuleLevelUpdate): { content: string; changed: boolean } {
  const { lines, spans } = blockSpans(content);
  const starter = starterBlocks();
  const output: string[] = lines.slice(0, spans[0]?.start ?? lines.length);

  for (const span of spans) {
    const block = lines.slice(span.start, span.end);
    const id = typeof span.header?.id === "string" ? span.header.id : null;
    // The header runs from the opening --- (index 0) to the next --- line.
    const headerEnd = block.findIndex((line, index) => index > 0 && line.trim() === "---");
    const severityAt = block.findIndex((line, index) => index > 0 && index < headerEnd && SEVERITY_LINE.test(line));
    const severity = severityAt === -1 ? "warn" : (SEVERITY_LINE.exec(block[severityAt] ?? "")?.[1] ?? "warn");

    if (id === null || headerEnd === -1) {
      output.push(...block);
    } else if (update.removed.has(id)) {
      continue;
    } else if (update.replaced.has(id) && starter.has(id)) {
      const replacement = [...(starter.get(id) ?? [])];
      const at = replacement.findIndex((line) => SEVERITY_LINE.test(line));

      // Keep the level the SOP owner chose for this rule (no severity line means they never chose one).
      if (at !== -1 && severityAt !== -1) {
        replacement[at] = `severity: ${severity}`;
      }

      // And which tickets and when it applies (the check itself changes, so its settings do not carry over).
      for (const key of ["applies_to", "when"]) {
        const owner = block.findIndex((line, index) => index > 0 && index < headerEnd && line.startsWith(`${key}:`));
        const starterAt = replacement.findIndex((line) => line.startsWith(`${key}:`));

        if (owner !== -1 && starterAt !== -1) {
          replacement[starterAt] = block[owner] as string;
        }
      }

      output.push(...replacement);
    } else if (update.notices.has(id) && severity !== "off" && severity !== "notice") {
      if (severityAt === -1) {
        block.splice(headerEnd, 0, "severity: notice");
      } else {
        block[severityAt] = "severity: notice";
      }

      output.push(...block);
    } else {
      output.push(...block);
    }
  }

  const present = new Set(spans.flatMap((span) => (typeof span.header?.id === "string" ? [span.header.id] : [])));

  for (const id of update.added ?? []) {
    const block = starter.get(id);

    if (block && !present.has(id)) {
      // Each block runs up to the next "---", so a trailing blank line keeps the file readable.
      output.push(...(output.at(-1)?.trim() === "" ? [] : [""]), ...block);
    }
  }

  const next = output.join("\n");
  return { content: next, changed: next !== lines.join("\n") };
}

/** Runs every agreed update that has not run yet, in order. */
export async function ensureRuleLevelsUpdated(): Promise<void> {
  for (const update of RULE_LEVEL_UPDATES) {
    await runUpdate(update);
  }
}

/**
 * Brings the saved default rulebook to one agreed update once, as a new
 * version with a note (older versions stay restorable). Fresh installs use the
 * built-in starter, which already has it. Never takes the SOP pages down.
 */
async function runUpdate(update: RuleLevelUpdate): Promise<void> {
  if (await prisma.appSetting.findUnique({ where: { key: update.key }, select: { key: true } })) {
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // The unique key doubles as a lock: a second server doing the same update fails here and rolls back.
      await tx.appSetting.create({ data: { key: update.key, value: { updatedAt: new Date().toISOString() }, updatedBy: null } });

      const latest = await tx.rulebook.findFirst({ orderBy: { version: "desc" } });

      if (!latest) {
        return;
      }

      const updated = applyRuleLevels(latest.content, update);

      if (!updated.changed) {
        return;
      }

      // Never save a version that reads worse than the one it replaces.
      if (parseRulebook(updated.content, "default").errors.length > parseRulebook(latest.content, "default").errors.length) {
        console.error(`Updating SOP rule levels would make rulebook v${latest.version} invalid; left unchanged.`);
        return;
      }

      await tx.rulebook.create({ data: { version: latest.version + 1, content: updated.content, note: update.note, createdBy: null } });
    });
  } catch (error) {
    // Another process did (or is doing) the update.
    if (await prisma.appSetting.findUnique({ where: { key: update.key }, select: { key: true } })) {
      return;
    }

    console.error("Updating SOP rule levels failed; will retry:", error);
  }
}
