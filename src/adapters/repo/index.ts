/**
 * 로컬 저장소 — SQLite 단일 파일.
 *
 * PRD 5절: "문서, 버전, 피드백과 개인화 기록은 모두 로컬에 저장한다."
 * 파일 위치는 메인 프로세스가 app.getPath('userData') 로 정해 넘겨준다.
 */
import Database from 'better-sqlite3'

import { loadMigrations, runMigrations } from './migrations.js'

export interface OpenOptions {
  /** SQLite 파일 경로. ':memory:' 도 받는다. */
  file: string
  /** 마이그레이션 .sql 이 들어 있는 디렉터리 */
  migrationsDir: string
}

export interface OpenResult {
  db: Database.Database
  /** 이번에 적용된 마이그레이션 버전 */
  appliedVersions: number[]
}

export function openDatabase({ file, migrationsDir }: OpenOptions): OpenResult {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const appliedVersions = runMigrations(db, loadMigrations(migrationsDir))
  return { db, appliedVersions }
}

export { loadMigrations, runMigrations } from './migrations.js'
export type { Migration, MigrationDb } from './migrations.js'
export { createDocumentRepository } from './documents.js'
export type {
  AppendVersionInput,
  CheckpointRow,
  DiffEntryRow,
  DocumentRepository,
  DocumentRow,
  DocumentVersionRow,
  ParagraphInput,
} from './documents.js'
export { createRubricRepository } from './rubric.js'
export type { RubricRepository } from './rubric.js'
export { createReviewRepository } from './reviews.js'
export type { ReviewRecord, ReviewRepository, StoredFeedbackItem, StoredReview } from './reviews.js'
export { createSettingsRepository, SETTING_KEYS } from './settings.js'
export type { SettingKey, SettingsRepository } from './settings.js'
export { createReviewCacheRepository } from './cache.js'
export type { CachedFeedbackItem, CachedReview, ReviewCacheRepository } from './cache.js'
export { createAnchorRepository } from './anchors.js'
export type {
  AnchorRepository,
  AnchorStatus,
  SectionBoundaryRow,
  SentenceAnchorRow,
  StageGrantRow,
} from './anchors.js'
