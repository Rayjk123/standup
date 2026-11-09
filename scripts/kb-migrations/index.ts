import type { KbMigration } from "./runner.ts";
import { migration as personalLayer } from "./001-personal-layer.ts";
import { migration as sourceKindRelabel } from "./002-source-kind-relabel.ts";
import { migration as demoteScratchGlobals } from "./003-demote-scratch-globals.ts";
import { migration as collapseIdenticalDuplicates } from "./004-collapse-identical-duplicates.ts";
import { migration as retireStandupSelf } from "./005-retire-standup-self.ts";
import { migration as unverifiedConfidence } from "./006-unverified-confidence.ts";
import { migration as rejudgeContradicted } from "./007-rejudge-contradicted.ts";
import { migration as stampPersonaMemories } from "./009-stamp-persona-memories.ts";
import { migration as classifyKnowledgeChanges } from "./010-classify-knowledge-changes.ts";

export * from "./runner.ts";

/** Every knowledge-data migration, in the order they run. */
export const MIGRATIONS: readonly KbMigration[] = [
  personalLayer,
  sourceKindRelabel,
  demoteScratchGlobals,
  collapseIdenticalDuplicates,
  retireStandupSelf,
  unverifiedConfidence,
  rejudgeContradicted,
  stampPersonaMemories,
  classifyKnowledgeChanges,
];

/** The migrations a run applies unless told otherwise: every one that is not opt-in. */
export const DEFAULT_MIGRATIONS: readonly KbMigration[] = MIGRATIONS.filter((m) => !m.optIn);
