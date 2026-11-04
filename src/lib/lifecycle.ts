import type { NextFunction, Request, Response } from "express";

/**
 * Graceful shutdown: requests already running (an approved change being
 * applied, above all) may finish; requests arriving after shutdown began get a
 * readable 503 instead of a dropped connection.
 */

let inFlight = 0;
/** Approvals apply changes to Azure DevOps or Solidtime and can take minutes: shutdown waits longer for them. */
let approvalsInFlight = 0;
let shuttingDown = false;
const onRequestDone = new Set<() => void>();

// Case-insensitive, like Express routing: /api/Actions/x/Approve reaches the same handler.
const isApproval = (req: Request) => req.method === "POST" && /^\/api\/actions\/[^/]+\/approve\/?$/i.test(req.path);

/** Counts running requests. Each one counts exactly once, whether it finished or its connection closed. */
export function trackRequests(req: Request, res: Response, next: NextFunction): void {
  const approval = isApproval(req);
  let done = false;

  inFlight += 1;
  if (approval) approvalsInFlight += 1;

  const finish = () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    if (approval) approvalsInFlight -= 1;
    for (const listener of [...onRequestDone]) listener();
  };

  res.once("finish", finish);
  res.once("close", finish);
  next();
}

/** Mounted after cors(), so the browser can read the 503 and show it. */
export function refuseWhileShuttingDown(_req: Request, res: Response, next: NextFunction): void {
  if (!shuttingDown) {
    next();
    return;
  }

  res.setHeader("Connection", "close");
  res.status(503).json({ message: "Cockpit is restarting. Try again in a moment.", reason: "SERVER_RESTARTING" });
}

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function requestsInFlight(): { total: number; approvals: number } {
  return { total: inFlight, approvals: approvalsInFlight };
}

/**
 * Resolves true once no request is running, or false when time is up: after
 * `graceMs`, or up to `approvalGraceMs` while an approval is still running.
 */
export function waitForRequests(graceMs: number, approvalGraceMs = graceMs): Promise<boolean> {
  return new Promise((resolve) => {
    let graceOver = false;
    const timers: NodeJS.Timeout[] = [];
    const settle = (finished: boolean) => {
      onRequestDone.delete(check);
      timers.forEach(clearTimeout);
      resolve(finished);
    };

    function check(): void {
      if (inFlight === 0) {
        settle(true);
      } else if (graceOver && approvalsInFlight === 0) {
        settle(false);
      }
    }

    onRequestDone.add(check);
    timers.push(
      setTimeout(() => {
        graceOver = true;
        check();
      }, graceMs),
      setTimeout(() => settle(inFlight === 0), Math.max(graceMs, approvalGraceMs))
    );
    check();
  });
}

/** Exposed for tests: module state is shared by every app in the process. */
export function resetLifecycleForTests(): void {
  shuttingDown = false;
  inFlight = 0;
  approvalsInFlight = 0;
  onRequestDone.clear();
}
