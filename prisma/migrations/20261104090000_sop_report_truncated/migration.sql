-- SOP report runs: whether the run was cut at the ticket cap (only the most recently changed tickets were checked).
-- AlterTable
ALTER TABLE "SopReportRun" ADD COLUMN     "truncated" BOOLEAN NOT NULL DEFAULT false;
