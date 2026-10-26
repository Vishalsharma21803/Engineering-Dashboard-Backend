-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActionKind" ADD VALUE 'WORK_ITEM_EDIT_TEXT';
ALTER TYPE "ActionKind" ADD VALUE 'WORK_ITEM_SET_CATEGORY';
ALTER TYPE "ActionKind" ADD VALUE 'WORK_ITEM_ADD_TAGS';

-- AlterEnum
ALTER TYPE "ActionSource" ADD VALUE 'AI_SUGGESTION';
