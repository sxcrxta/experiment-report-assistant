/**
 * 검토 요청·피드백 저장소 (SQLite).
 *
 * CLAUDE.md §2: AI 출력이 저장소를 직접 바꾸지 않는다. 프로그램이 스키마를 검증하고,
 * 대상 문단·버전에 연결한 뒤 저장한다.
 * 그래서 성공한 검토는 `validateModelOutput` 이 만든 응답(`ReviewResponse`)만 받는다.
 * 타입을 속였거나 복제한 객체는 저장하기 전에 걸린다. 스키마(0004)의 CHECK 와 트리거가 한 번 더 막는다.
 *
 * 실패한 검토는 이유만 남긴다. 모델이 보낸 원문은 저장하지 않는다.
 */
import type Database from 'better-sqlite3'

import {
  isValidatedReviewResponse,
  type FeedbackItem,
  type ReviewResponse,
} from '../model/schema.js'
import type {
  FeedbackSeverity,
  ReviewPerspective,
  ReviewScope,
  ReviewStage,
} from '../../shared/review.js'

/** 요청 한 건의 조건과 결과 메타. 성공·실패 모두 같다. */
export interface ReviewRecord {
  requestId: string
  documentId: string
  versionId: string
  rubricVersion: string
  scope: ReviewScope
  stage: ReviewStage
  perspectives: ReviewPerspective[]
  /** 검토를 요청한 전체 대상 문단 (캐시 적중도 포함) */
  targetParagraphIds: string[]
  /** 전체 요청에 대응하는 문맥 문단 */
  contextParagraphIds: string[]
  modelId: string
  promptVersion: string
  requestedAt: string
  completedAt: string
  attempts: number
  /** 실제 전송 범위. []는 전송 없음, null은 과거 기록이라 알 수 없음. */
  sentTargetParagraphIds?: string[] | null
  sentContextParagraphIds?: string[] | null
  /**
   * 문장 범위 피드백이 가리키는 문장 앵커 (5단계). 문단 uuid → 앵커 id.
   * 문장 위치가 붙은 항목은 여기에 앵커가 있어야만 저장된다. 없으면 조용히 떨어뜨리지 않고 거절한다.
   */
  sentenceAnchors?: Readonly<Record<string, string>>
}

/** 저장된 피드백. 문장 범위면 어느 앵커에 달렸는지 함께 돌려준다. */
export type StoredFeedbackItem = FeedbackItem & { sentenceAnchorId: string | null }

export type StoredReview =
  | (ReviewRecord & {
      status: 'succeeded'
      summary: string
      droppedCount: number
      items: StoredFeedbackItem[]
    })
  | (ReviewRecord & { status: 'failed'; failureReason: string; failureMessage: string })

export interface ReviewRepository {
  /** 검증을 통과한 응답과 그 항목을 한 트랜잭션으로 넣는다 */
  saveSucceeded(record: ReviewRecord, response: ReviewResponse, droppedCount: number): void
  /** 모델을 불렀지만 쓸 수 있는 결과를 얻지 못한 요청 */
  saveFailed(record: ReviewRecord, failure: { reason: string; message: string }): void
  getReview(requestId: string): StoredReview | null
  /** 요청한 순서대로 */
  listReviews(documentId: string): StoredReview[]
  /** 사용자가 지우기로 한 피드백 항목. 달린 판단·관찰 메모는 ON DELETE CASCADE 로 함께 지워진다 */
  deleteFeedbackItems(itemIds: readonly string[]): void
}

export class UnvalidatedResponseError extends Error {
  override name = 'UnvalidatedResponseError'
}

interface RequestRow {
  sent_target_paragraph_ids: string | null
  sent_context_paragraph_ids: string | null
  id: string
  document_id: string
  version_id: string
  rubric_version: string
  scope: ReviewScope
  stage: ReviewStage
  perspectives: string
  target_paragraph_ids: string
  context_paragraph_ids: string
  model_id: string
  prompt_version: string
  requested_at: string
  completed_at: string
  attempts: number
  status: 'succeeded' | 'failed'
  summary: string | null
  dropped_count: number
  failure_reason: string | null
  failure_message: string | null
}

interface ItemRow {
  id: string
  paragraph_uuid: string
  perspective: ReviewPerspective
  stage: ReviewStage
  severity: number
  body: string
  rationale: string
  applied_rubric_item_ids: string
  example: string | null
  sentence_anchor_id: string | null
  /** 앵커에 남은 문장. 앵커가 없으면 null */
  sentence_index: number | null
  sentence_text: string | null
}

function toRecord(row: RequestRow): ReviewRecord {
  return {
    requestId: row.id,
    documentId: row.document_id,
    versionId: row.version_id,
    rubricVersion: row.rubric_version,
    scope: row.scope,
    stage: row.stage,
    perspectives: JSON.parse(row.perspectives) as ReviewPerspective[],
    targetParagraphIds: JSON.parse(row.target_paragraph_ids) as string[],
    contextParagraphIds: JSON.parse(row.context_paragraph_ids) as string[],
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
    attempts: row.attempts,
    sentTargetParagraphIds: row.sent_target_paragraph_ids === null ? null : JSON.parse(row.sent_target_paragraph_ids) as string[],
    sentContextParagraphIds: row.sent_context_paragraph_ids === null ? null : JSON.parse(row.sent_context_paragraph_ids) as string[],
  }
}

function toItem(row: ItemRow): StoredFeedbackItem {
  const item: StoredFeedbackItem = {
    itemId: row.id,
    paragraphId: row.paragraph_uuid,
    perspective: row.perspective,
    stage: row.stage,
    // 스키마의 CHECK 가 1~5 만 받는다.
    severity: row.severity as FeedbackSeverity,
    body: row.body,
    rationale: row.rationale,
    appliedRubricItemIds: JSON.parse(row.applied_rubric_item_ids) as string[],
    sentenceAnchorId: row.sentence_anchor_id,
  }
  if (row.example !== null) item.example = row.example
  // 문장 위치는 앵커에 남는다. 피드백 쪽에 따로 복사해 두지 않는다.
  if (row.sentence_index !== null && row.sentence_text !== null) {
    item.sentenceRef = { index: row.sentence_index, text: row.sentence_text }
  }
  return item
}

export function createReviewRepository(db: Database.Database): ReviewRepository {
  const insertRequest = db.prepare(
    `INSERT INTO review_request
       (id, document_id, version_id, rubric_version, scope, stage, perspectives,
        target_paragraph_ids, context_paragraph_ids, model_id, prompt_version,
        requested_at, completed_at, attempts, status, summary, dropped_count,
        failure_reason, failure_message, sent_target_paragraph_ids, sent_context_paragraph_ids)
     VALUES
       (@id, @document_id, @version_id, @rubric_version, @scope, @stage, @perspectives,
        @target_paragraph_ids, @context_paragraph_ids, @model_id, @prompt_version,
        @requested_at, @completed_at, @attempts, @status, @summary, @dropped_count,
        @failure_reason, @failure_message, @sent_target_paragraph_ids, @sent_context_paragraph_ids)`,
  )
  const insertItem = db.prepare(
    `INSERT INTO feedback_item
       (id, request_id, position, paragraph_uuid, perspective, stage, severity, body, rationale,
        applied_rubric_item_ids, example, sentence_anchor_id)
     VALUES
       (@id, @request_id, @position, @paragraph_uuid, @perspective, @stage, @severity, @body, @rationale,
        @applied_rubric_item_ids, @example, @sentence_anchor_id)`,
  )
  const selectRequest = db.prepare('SELECT * FROM review_request WHERE id = ?')
  const deleteItem = db.prepare('DELETE FROM feedback_item WHERE id = ?')
  const deleteItems = db.transaction((ids: readonly string[]) => { for (const id of ids) deleteItem.run(id) })
  const selectRequests = db.prepare(
    'SELECT * FROM review_request WHERE document_id = ? ORDER BY requested_at, rowid',
  )
  const selectItems = db.prepare(
    `SELECT i.id, i.paragraph_uuid, i.perspective, i.stage, i.severity, i.body, i.rationale,
            i.applied_rubric_item_ids, i.example, i.sentence_anchor_id,
            a.sentence_index AS sentence_index, a.text AS sentence_text
     FROM feedback_item i
     LEFT JOIN sentence_anchor a ON a.id = i.sentence_anchor_id
     WHERE i.request_id = ? ORDER BY i.position`,
  )

  function requestParams(record: ReviewRecord): Record<string, unknown> {
    return {
      id: record.requestId,
      document_id: record.documentId,
      version_id: record.versionId,
      rubric_version: record.rubricVersion,
      scope: record.scope,
      stage: record.stage,
      perspectives: JSON.stringify(record.perspectives),
      target_paragraph_ids: JSON.stringify(record.targetParagraphIds),
      context_paragraph_ids: JSON.stringify(record.contextParagraphIds),
      model_id: record.modelId,
      prompt_version: record.promptVersion,
      requested_at: record.requestedAt,
      completed_at: record.completedAt,
      attempts: record.attempts,
      sent_target_paragraph_ids: record.sentTargetParagraphIds == null ? null : JSON.stringify(record.sentTargetParagraphIds),
      sent_context_paragraph_ids: record.sentContextParagraphIds == null ? null : JSON.stringify(record.sentContextParagraphIds),
    }
  }

  const saveSucceededTx = db.transaction(
    (record: ReviewRecord, response: ReviewResponse, droppedCount: number) => {
      insertRequest.run({
        ...requestParams(record),
        status: 'succeeded',
        summary: response.summary,
        dropped_count: droppedCount,
        failure_reason: null,
        failure_message: null,
      })
      response.items.forEach((item, position) => {
        insertItem.run({
          id: item.itemId,
          request_id: record.requestId,
          position,
          paragraph_uuid: item.paragraphId,
          perspective: item.perspective,
          stage: item.stage,
          severity: item.severity,
          body: item.body,
          rationale: item.rationale,
          applied_rubric_item_ids: JSON.stringify(item.appliedRubricItemIds),
          example: item.example ?? null,
          sentence_anchor_id:
            item.sentenceRef === undefined
              ? null
              : (record.sentenceAnchors?.[item.paragraphId] ?? null),
        })
      })
    },
  )

  function restore(row: RequestRow): StoredReview {
    const record = toRecord(row)
    if (row.status === 'succeeded') {
      return {
        ...record,
        status: 'succeeded',
        summary: row.summary ?? '',
        droppedCount: row.dropped_count,
        items: (selectItems.all(row.id) as ItemRow[]).map(toItem),
      }
    }
    return {
      ...record,
      status: 'failed',
      failureReason: row.failure_reason ?? '',
      failureMessage: row.failure_message ?? '',
    }
  }

  return {
    saveSucceeded(record, response, droppedCount): void {
      // 검증을 거치지 않은 응답은 저장하지 않는다. 타입을 속였어도 여기서 멈춘다 (T-11).
      if (!isValidatedReviewResponse(response)) {
        throw new UnvalidatedResponseError('스키마 검증을 통과하지 않은 응답은 저장할 수 없습니다.')
      }
      if (response.requestId !== record.requestId || response.rubricVersion !== record.rubricVersion) {
        throw new UnvalidatedResponseError('다른 요청의 응답은 저장할 수 없습니다.')
      }
      // 문장 위치가 붙은 항목은 문장 앵커에 연결한다 (5단계).
      // 앵커 없이 들어오면 문장 정보를 조용히 떨어뜨리지 않고 저장을 거절한다.
      const missingAnchor = response.items.some(
        (item) => item.sentenceRef !== undefined && record.sentenceAnchors?.[item.paragraphId] === undefined,
      )
      if (missingAnchor) {
        throw new UnvalidatedResponseError('문장 단위 피드백은 문장 앵커 없이 저장할 수 없습니다.')
      }
      saveSucceededTx(record, response, droppedCount)
    },

    saveFailed(record, failure): void {
      insertRequest.run({
        ...requestParams(record),
        status: 'failed',
        summary: null,
        dropped_count: 0,
        failure_reason: failure.reason,
        failure_message: failure.message,
      })
    },

    getReview(requestId): StoredReview | null {
      const row = selectRequest.get(requestId) as RequestRow | undefined
      return row === undefined ? null : restore(row)
    },

    listReviews(documentId): StoredReview[] {
      return (selectRequests.all(documentId) as RequestRow[]).map(restore)
    },

    deleteFeedbackItems(itemIds): void {
      deleteItems(itemIds)
    },
  }
}
