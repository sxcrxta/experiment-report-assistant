/**
 * 문장 앵커 · 보고서 항목 경계 · 단계 진행 저장소 (SQLite, 0005).
 *
 * 여기에는 판단이 없다. 문장을 자르고 다시 찾는 일은 `core/document/sentence-anchor.ts`,
 * 경계 추정은 `core/rubric/section-boundary.ts`, 단계 순서 강제는 `app/review-stage.ts` 가 한다
 * (`CLAUDE.md` §2).
 */
import type Database from 'better-sqlite3'

import type { AnchorStatus } from '../../shared/feedback.js'
import type { ReviewStage } from '../../shared/review.js'

export type { AnchorStatus }

export interface SentenceAnchorRow {
  anchorId: string
  documentId: string
  versionId: string
  paragraphUuid: string
  sentenceIndex: number
  text: string
  offset: number
  hash: string
  status: AnchorStatus
  createdAt: string
  updatedAt: string
}

export interface SectionBoundaryRow {
  documentId: string
  ordinal: number
  title: string
  startParagraphUuid: string
  endParagraphUuid: string
  updatedAt: string
}

export interface StageGrantRow {
  documentId: string
  targetKey: string
  stage: ReviewStage
  grantedAt: string
}

export interface AnchorRepository {
  addAnchor(row: SentenceAnchorRow): SentenceAnchorRow
  getAnchor(anchorId: string): SentenceAnchorRow | null
  listAnchors(documentId: string): SentenceAnchorRow[]
  /** 다시 찾은 결과를 반영한다. 프로그램이 판정한 값만 들어온다 */
  updateAnchor(
    anchorId: string,
    change: { sentenceIndex: number; offset: number; text: string; hash: string; status: AnchorStatus },
    updatedAt: string,
  ): void
  /** 피드백이 달리기 전에 실패한 요청의 앵커를 치운다. 피드백이 달린 앵커는 지우지 않는다 */
  deleteAnchorIfUnused(anchorId: string): boolean

  /** 사용자가 고친 경계를 통째로 바꾼다. 빈 목록이면 사용자 수정이 없는 상태로 돌아간다 */
  replaceSections(documentId: string, rows: readonly Omit<SectionBoundaryRow, 'documentId'>[]): void
  listSections(documentId: string): SectionBoundaryRow[]

  grantStage(row: StageGrantRow): void
  listGrants(documentId: string): StageGrantRow[]
}

interface AnchorRecord {
  id: string
  document_id: string
  version_id: string
  paragraph_uuid: string
  sentence_index: number
  text: string
  char_offset: number
  hash: string
  status: AnchorStatus
  created_at: string
  updated_at: string
}

interface SectionRecord {
  document_id: string
  ordinal: number
  title: string
  start_paragraph_uuid: string
  end_paragraph_uuid: string
  updated_at: string
}

interface GrantRecord {
  document_id: string
  target_key: string
  stage: ReviewStage
  granted_at: string
}

function toAnchor(row: AnchorRecord): SentenceAnchorRow {
  return {
    anchorId: row.id,
    documentId: row.document_id,
    versionId: row.version_id,
    paragraphUuid: row.paragraph_uuid,
    sentenceIndex: row.sentence_index,
    text: row.text,
    offset: row.char_offset,
    hash: row.hash,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createAnchorRepository(db: Database.Database): AnchorRepository {
  const insertAnchor = db.prepare(
    `INSERT INTO sentence_anchor
       (id, document_id, version_id, paragraph_uuid, sentence_index, text, char_offset, hash,
        status, created_at, updated_at)
     VALUES
       (@id, @document_id, @version_id, @paragraph_uuid, @sentence_index, @text, @char_offset, @hash,
        @status, @created_at, @updated_at)`,
  )
  const selectAnchor = db.prepare('SELECT * FROM sentence_anchor WHERE id = ?')
  const selectAnchors = db.prepare('SELECT * FROM sentence_anchor WHERE document_id = ? ORDER BY created_at, id')
  const updateAnchorRow = db.prepare(
    `UPDATE sentence_anchor
        SET sentence_index = @sentence_index, char_offset = @char_offset, text = @text,
            hash = @hash, status = @status, updated_at = @updated_at
      WHERE id = @id`,
  )
  const countItems = db.prepare('SELECT COUNT(*) AS n FROM feedback_item WHERE sentence_anchor_id = ?')
  const deleteAnchor = db.prepare('DELETE FROM sentence_anchor WHERE id = ?')

  const deleteSections = db.prepare('DELETE FROM section_boundary WHERE document_id = ?')
  const insertSection = db.prepare(
    `INSERT INTO section_boundary
       (document_id, ordinal, title, start_paragraph_uuid, end_paragraph_uuid, updated_at)
     VALUES (@document_id, @ordinal, @title, @start_paragraph_uuid, @end_paragraph_uuid, @updated_at)`,
  )
  const selectSections = db.prepare('SELECT * FROM section_boundary WHERE document_id = ? ORDER BY ordinal')

  const insertGrant = db.prepare(
    `INSERT INTO review_stage_grant (document_id, target_key, stage, granted_at)
     VALUES (@document_id, @target_key, @stage, @granted_at)
     ON CONFLICT (document_id, target_key, stage) DO NOTHING`,
  )
  const selectGrants = db.prepare(
    'SELECT * FROM review_stage_grant WHERE document_id = ? ORDER BY granted_at, target_key',
  )

  const replaceSectionsTx = db.transaction(
    (documentId: string, rows: readonly Omit<SectionBoundaryRow, 'documentId'>[]) => {
      deleteSections.run(documentId)
      for (const row of rows) {
        insertSection.run({
          document_id: documentId,
          ordinal: row.ordinal,
          title: row.title,
          start_paragraph_uuid: row.startParagraphUuid,
          end_paragraph_uuid: row.endParagraphUuid,
          updated_at: row.updatedAt,
        })
      }
    },
  )

  return {
    addAnchor(row): SentenceAnchorRow {
      insertAnchor.run({
        id: row.anchorId,
        document_id: row.documentId,
        version_id: row.versionId,
        paragraph_uuid: row.paragraphUuid,
        sentence_index: row.sentenceIndex,
        text: row.text,
        char_offset: row.offset,
        hash: row.hash,
        status: row.status,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })
      return { ...row }
    },

    getAnchor(anchorId): SentenceAnchorRow | null {
      const row = selectAnchor.get(anchorId) as AnchorRecord | undefined
      return row === undefined ? null : toAnchor(row)
    },

    listAnchors(documentId): SentenceAnchorRow[] {
      return (selectAnchors.all(documentId) as AnchorRecord[]).map(toAnchor)
    },

    updateAnchor(anchorId, change, updatedAt): void {
      updateAnchorRow.run({
        id: anchorId,
        sentence_index: change.sentenceIndex,
        char_offset: change.offset,
        text: change.text,
        hash: change.hash,
        status: change.status,
        updated_at: updatedAt,
      })
    },

    deleteAnchorIfUnused(anchorId): boolean {
      const used = countItems.get(anchorId) as { n: number } | undefined
      if (used !== undefined && used.n > 0) return false
      deleteAnchor.run(anchorId)
      return true
    },

    replaceSections(documentId, rows): void {
      replaceSectionsTx(documentId, rows)
    },

    listSections(documentId): SectionBoundaryRow[] {
      return (selectSections.all(documentId) as SectionRecord[]).map((row) => ({
        documentId: row.document_id,
        ordinal: row.ordinal,
        title: row.title,
        startParagraphUuid: row.start_paragraph_uuid,
        endParagraphUuid: row.end_paragraph_uuid,
        updatedAt: row.updated_at,
      }))
    },

    grantStage(row): void {
      insertGrant.run({
        document_id: row.documentId,
        target_key: row.targetKey,
        stage: row.stage,
        granted_at: row.grantedAt,
      })
    },

    listGrants(documentId): StageGrantRow[] {
      return (selectGrants.all(documentId) as GrantRecord[]).map((row) => ({
        documentId: row.document_id,
        targetKey: row.target_key,
        stage: row.stage,
        grantedAt: row.granted_at,
      }))
    },
  }
}
