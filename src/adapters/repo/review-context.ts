/**
 * 검토 맥락 ([Q-48]) — 문서 종류와, 검토 기록을 잇는 식별자.
 *
 * 검토 기록(`review_request.rubric_version`)은 처음부터 평가 지침 버전을 가리키도록 만들어져 있고
 * (NOT NULL, 외래 키), SQLite 에서는 그 제약만 안전하게 걷어 낼 수 없다 — 표를 다시 만들면 딸린
 * 피드백이 연쇄 삭제된다. 그래서 보고서마다 **항목 없는 맥락 행 하나**를 `rubric_version` 에 두고
 * 검토 기록이 그것을 가리키게 한다. 이 행은 지침 목록·이력에 보이지 않는다 (`CONTEXT_ORDINAL`).
 */
import type Database from 'better-sqlite3'

/** 맥락 행의 순번. 사용자가 확정한 지침은 이보다 작다. 지침 조회는 이 순번 이상을 빼고 읽는다 */
export const CONTEXT_ORDINAL = 1_000_000_000

export function contextVersionOf(documentId: string): string {
  return `review-context:${documentId}`
}

export interface DocumentProfile {
  kind: string
  source: 'ai' | 'user'
  modelId: string | null
  updatedAt: string
}

export interface ReviewContextRepository {
  /** 맥락 행이 없으면 만든다. 식별자를 돌려준다 */
  ensureContext(documentId: string, now: string): string
  getProfile(documentId: string): DocumentProfile | null
  saveProfile(documentId: string, profile: DocumentProfile): void
}

export function createReviewContextRepository(db: Database.Database): ReviewContextRepository {
  const insertContext = db.prepare(`INSERT OR IGNORE INTO rubric_version
    (rubric_version, document_id, ordinal, content_hash, confirmed_at) VALUES (?, ?, ?, 'review-context', ?)`)
  const selectProfile = db.prepare('SELECT * FROM document_profile WHERE document_id = ?')
  const upsertProfile = db.prepare(`INSERT INTO document_profile (document_id, kind, source, model_id, updated_at)
    VALUES (@documentId, @kind, @source, @modelId, @updatedAt)
    ON CONFLICT(document_id) DO UPDATE SET kind = excluded.kind, source = excluded.source,
      model_id = excluded.model_id, updated_at = excluded.updated_at`)
  return {
    ensureContext(documentId, now): string {
      const id = contextVersionOf(documentId)
      insertContext.run(id, documentId, CONTEXT_ORDINAL, now)
      return id
    },
    getProfile(documentId): DocumentProfile | null {
      const row = selectProfile.get(documentId) as
        { kind: string; source: 'ai' | 'user'; model_id: string | null; updated_at: string } | undefined
      return row === undefined ? null
        : { kind: row.kind, source: row.source, modelId: row.model_id, updatedAt: row.updated_at }
    },
    saveProfile(documentId, profile): void {
      upsertProfile.run({ documentId, ...profile })
    },
  }
}
