/**
 * 4단계 — 검토 요청·피드백 저장소 (adapters/repo/reviews.ts) 와 0004_reviews.sql.
 *
 * T-3  예시를 요청하지 않은 단계의 피드백에 예시가 붙어 저장되지 않는다 (스키마 CHECK).
 * T-11 AI 응답이 저장소를 직접 바꾸는 경로가 없다.
 *      `validateModelOutput` 이 만든 응답만 저장된다. 복제·위조한 객체는 저장 전에 멈춘다.
 * T-27 실패한 검토는 이유만 남고 피드백이 달리지 않는다.
 *
 * 스키마의 트리거와 CHECK 는 저장소 코드를 거치지 않은 삽입도 막아야 한다.
 * 그래서 저장소를 통한 경로와 SQL 을 직접 넣는 경로를 모두 실행한다.
 */
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createReviewRequest,
  validateModelOutput,
  type ReviewRequest,
  type ReviewRequestInput,
  type ReviewResponse,
} from '../src/adapters/model/schema.js'
import { createAnchorRepository } from '../src/adapters/repo/anchors.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import {
  createReviewRepository,
  UnvalidatedResponseError,
  type ReviewRecord,
  type ReviewRepository,
} from '../src/adapters/repo/reviews.js'
import { createRubricRepository } from '../src/adapters/repo/rubric.js'
import { createRubricService, UNAVAILABLE_SUGGESTER } from '../src/app/rubric.js'
import type { Paragraph } from '../src/core/document/model.js'
import type { ConfirmedRubric } from '../src/core/rubric/model.js'

import { makeParagraphs } from './helpers/paragraphs.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')
const META = { modelId: 'test/model', promptVersion: 'quick-review.v1' }

interface Harness {
  db: Database.Database
  reviews: ReviewRepository
  rubric: ConfirmedRubric
  paragraphs: Paragraph[]
  /** 대상 문단 두 개와 문맥 문단 하나 */
  target1: Paragraph
  target2: Paragraph
  contextParagraph: Paragraph
}

const cleanups: (() => void)[] = []
let h: Harness

function createHarness(): Harness {
  const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })
  cleanups.push(() => db.close())

  const documents = createDocumentRepository(db)
  const paragraphs = makeParagraphs(['2. 결과', '온도가 올라가면 압력이 증가했다.', '따라서 보일 법칙이 성립한다.'])
  documents.createDocument({
    id: 'doc-1',
    path: '/tmp/doc-1.hwpx',
    displayName: 'doc-1.hwpx',
    subject: '화학',
    createdAt: '2026-09-11T00:00:00.000Z',
  })
  documents.appendVersion({
    id: 'ver-1',
    documentId: 'doc-1',
    detectedAt: '2026-09-11T00:00:00.000Z',
    sourcePath: '/tmp/doc-1.hwpx',
    byteSize: 1,
    contentHash: 'bytes',
    paragraphs: paragraphs.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
    lineage: [],
    diffEntries: [],
    previousVersionId: null,
  })

  let ids = 0
  const rubricService = createRubricService({
    documents,
    rubrics: createRubricRepository(db),
    suggester: UNAVAILABLE_SUGGESTER,
    now: () => '2026-09-11T00:00:01.000Z',
    newId: () => `rubric-item-${(ids += 1)}`,
  })
  const confirmed = rubricService.confirm('doc-1', [
    { itemId: null, title: '결과 해석', description: '그래프를 근거로 해석하는가', importance: 5 },
  ])
  if (!confirmed.ok) throw new Error(confirmed.message)

  const [contextParagraph, target1, target2] = paragraphs as [Paragraph, Paragraph, Paragraph]
  return {
    db,
    reviews: createReviewRepository(db),
    rubric: confirmed.rubric,
    paragraphs,
    target1,
    target2,
    contextParagraph,
  }
}

beforeEach(() => {
  h = createHarness()
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function makeRequest(overrides: Partial<ReviewRequestInput> = {}): ReviewRequest {
  const result = createReviewRequest({
    requestId: 'req-1',
    documentVersionId: 'ver-1',
    scope: 'paragraph',
    stage: 'question',
    perspectives: ['logic', 'expression'],
    targets: [h.target1, h.target2].map((p) => ({ paragraphId: p.uuid, text: p.text, order: p.index })),
    context: [{ paragraphId: h.contextParagraph.uuid, text: h.contextParagraph.text, order: 0 }],
    rubric: h.rubric,
    approvedGuidelines: [],
    ...overrides,
  })
  if (!result.ok) throw new Error(result.problems.join('\n'))
  return result.request
}

function recordOf(request: ReviewRequest, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    requestId: request.requestId,
    documentId: 'doc-1',
    versionId: request.documentVersionId,
    rubricVersion: request.rubric.rubricVersion,
    scope: request.scope,
    stage: request.stage,
    perspectives: [...request.perspectives],
    targetParagraphIds: request.targets.map((t) => t.paragraphId),
    contextParagraphIds: request.context.map((c) => c.paragraphId),
    modelId: META.modelId,
    promptVersion: META.promptVersion,
    requestedAt: '2026-09-11T01:00:00.000Z',
    completedAt: '2026-09-11T01:00:05.000Z',
    attempts: 1,
    ...overrides,
  }
}

/** 문장 범위 요청. 대상 문단의 첫 문장을 가리킨다 (5단계). */
function sentenceRequest(): ReviewRequest {
  return makeRequest({
    scope: 'sentence',
    targets: [
      {
        paragraphId: h.target1.uuid,
        text: h.target1.text,
        order: h.target1.index,
        sentenceRef: { index: 0, text: h.target1.text },
      },
    ],
  })
}

/** 문장 앵커 한 줄. 앵커를 만드는 일은 app/review-stage.ts 가 하고, 여기서는 저장만 본다. */
function addAnchor(anchorId: string, paragraphUuid: string): void {
  createAnchorRepository(h.db).addAnchor({
    anchorId,
    documentId: 'doc-1',
    versionId: 'ver-1',
    paragraphUuid,
    sentenceIndex: 0,
    text: h.target1.text,
    offset: 0,
    hash: 'sentence-hash',
    status: 'linked',
    createdAt: '2026-09-11T01:00:00.000Z',
    updatedAt: '2026-09-11T01:00:00.000Z',
  })
}

function modelItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paragraph: 'P1',
    perspective: 'logic',
    severity: 3,
    body: '온도와 압력의 관계를 어떤 자료로 확인했나요?',
    rationale: '결과 문단에 근거가 된 측정값이 드러나지 않습니다.',
    rubricItems: ['R1'],
    ...overrides,
  }
}

function validated(request: ReviewRequest, items: unknown[]): ReviewResponse {
  let n = 0
  const result = validateModelOutput(
    request,
    JSON.stringify({ summary: '결과와 결론의 연결을 다시 볼 곳이 있습니다.', items }),
    META,
    () => `${request.requestId}-item-${(n += 1)}`,
  )
  if (!result.ok) throw new Error(result.problems.join('\n'))
  return result.response
}

function countRows(table: 'review_request' | 'feedback_item'): number {
  return (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

// ---------------------------------------------------------------------------
// 저장소를 통한 저장과 복원
// ---------------------------------------------------------------------------

describe('성공한 검토 저장 (saveSucceeded)', () => {
  it('요청 조건과 검증된 항목을 저장하고 같은 모양으로 돌려준다', () => {
    const request = makeRequest()
    const response = validated(request, [
      modelItem(),
      modelItem({ paragraph: 'P2', perspective: 'expression', severity: 5, rubricItems: [] }),
    ])
    const record = recordOf(request, { attempts: 2 })

    h.reviews.saveSucceeded(record, response, 1)

    const stored = h.reviews.getReview('req-1')
    expect(stored).toEqual({
      ...record,
      sentTargetParagraphIds: null,
      sentContextParagraphIds: null,
      status: 'succeeded',
      summary: response.summary,
      droppedCount: 1,
      items: [
        {
          itemId: 'req-1-item-1',
          paragraphId: h.target1.uuid,
          perspective: 'logic',
          stage: 'question',
          severity: 3,
          body: '온도와 압력의 관계를 어떤 자료로 확인했나요?',
          rationale: '결과 문단에 근거가 된 측정값이 드러나지 않습니다.',
          appliedRubricItemIds: [h.rubric.items[0]?.itemId],
          // 문단 범위 피드백이라 문장 앵커가 없다 (5단계).
          sentenceAnchorId: null,
        },
        {
          itemId: 'req-1-item-2',
          paragraphId: h.target2.uuid,
          perspective: 'expression',
          stage: 'question',
          severity: 5,
          body: '온도와 압력의 관계를 어떤 자료로 확인했나요?',
          rationale: '결과 문단에 근거가 된 측정값이 드러나지 않습니다.',
          appliedRubricItemIds: [],
          sentenceAnchorId: null,
        },
      ],
    })
    // 예시를 요청하지 않았으니 example 필드 자체가 없다.
    if (stored?.status !== 'succeeded') throw new Error('성공 기록이어야 합니다')
    for (const item of stored.items) expect('example' in item).toBe(false)
  })

  it('예시 단계를 요청했을 때만 예시가 저장된다', () => {
    const request = makeRequest({ stage: 'example' })
    const response = validated(request, [modelItem({ example: '측정값 표를 근거로 들어 보세요.' })])

    h.reviews.saveSucceeded(recordOf(request), response, 0)

    const stored = h.reviews.getReview('req-1')
    expect(stored?.status === 'succeeded' && stored.items.map((i) => [i.stage, i.example])).toEqual([
      ['example', '측정값 표를 근거로 들어 보세요.'],
    ])
  })

  it('항목이 없는 응답도 요약과 함께 저장된다', () => {
    const request = makeRequest()
    h.reviews.saveSucceeded(recordOf(request), validated(request, []), 0)

    const stored = h.reviews.getReview('req-1')
    expect(stored).toMatchObject({ status: 'succeeded', items: [], droppedCount: 0 })
  })
})

describe('검증을 거치지 않은 응답은 저장되지 않는다 (T-11)', () => {
  it('검증된 응답을 복제한 객체는 거절하고 아무것도 남기지 않는다', () => {
    const request = makeRequest()
    const response = validated(request, [modelItem()])
    const copy = { ...response } as ReviewResponse

    expect(() => h.reviews.saveSucceeded(recordOf(request), copy, 0)).toThrow(UnvalidatedResponseError)
    expect(countRows('review_request')).toBe(0)
    expect(countRows('feedback_item')).toBe(0)
  })

  it('모양만 맞춘 위조 객체도 거절한다', () => {
    const request = makeRequest()
    const forged = {
      requestId: 'req-1',
      modelId: META.modelId,
      rubricVersion: request.rubric.rubricVersion,
      promptVersion: META.promptVersion,
      summary: '위조',
      items: [],
    } as unknown as ReviewResponse

    expect(() => h.reviews.saveSucceeded(recordOf(request), forged, 0)).toThrow(UnvalidatedResponseError)
    expect(countRows('review_request')).toBe(0)
  })

  it('다른 요청이나 다른 지침 판의 응답은 거절한다', () => {
    const request = makeRequest()
    const other = makeRequest({ requestId: 'req-2' })
    const response = validated(other, [modelItem()])

    expect(() => h.reviews.saveSucceeded(recordOf(request), response, 0)).toThrow(UnvalidatedResponseError)
    expect(() =>
      h.reviews.saveSucceeded(recordOf(other, { rubricVersion: 'other-version' }), response, 0),
    ).toThrow(UnvalidatedResponseError)
    expect(countRows('review_request')).toBe(0)
  })

  it('문장 위치가 붙은 항목은 앵커 없이는 저장을 거절한다 (조용히 떨어뜨리지 않는다)', () => {
    const request = sentenceRequest()
    const response = validated(request, [modelItem()])
    expect(response.items[0]?.sentenceRef).toBeDefined()

    expect(() => h.reviews.saveSucceeded(recordOf(request), response, 0)).toThrow('문장 앵커')
    expect(countRows('review_request')).toBe(0)
  })

  it('문장 앵커를 함께 주면 그 앵커에 연결해 저장한다 (5단계)', () => {
    const request = sentenceRequest()
    const response = validated(request, [modelItem()])
    addAnchor('anchor-1', h.target1.uuid)

    h.reviews.saveSucceeded(
      recordOf(request, { sentenceAnchors: { [h.target1.uuid]: 'anchor-1' } }),
      response,
      0,
    )

    const stored = h.reviews.getReview('req-1')
    if (stored?.status !== 'succeeded') throw new Error('성공 기록이어야 합니다')
    expect(stored.items[0]?.sentenceAnchorId).toBe('anchor-1')
    // 문장 위치는 앵커에서 읽어 온다. 피드백 쪽에 따로 복사해 두지 않는다.
    expect(stored.items[0]?.sentenceRef).toEqual({ index: 0, text: h.target1.text })
  })
})

describe('스키마 트리거가 저장소 경로에서도 막는다', () => {
  it('기록의 단계와 항목의 단계가 다르면 요청째 되돌린다', () => {
    const request = makeRequest()
    const response = validated(request, [modelItem()])

    expect(() =>
      h.reviews.saveSucceeded(recordOf(request, { stage: 'weak_hint' }), response, 0),
    ).toThrow('요청한 단계와 다른 피드백')
    // 한 트랜잭션이라 요청 행도 남지 않는다.
    expect(countRows('review_request')).toBe(0)
    expect(countRows('feedback_item')).toBe(0)
  })

  it('기록의 대상에 없는 문단을 가리키는 항목이 있으면 요청째 되돌린다', () => {
    const request = makeRequest()
    const response = validated(request, [modelItem(), modelItem({ paragraph: 'P2' })])

    expect(() =>
      h.reviews.saveSucceeded(recordOf(request, { targetParagraphIds: [h.target1.uuid] }), response, 0),
    ).toThrow('검토 대상이 아닌 문단')
    expect(countRows('review_request')).toBe(0)
    expect(countRows('feedback_item')).toBe(0)
  })
})

describe('실패한 검토 저장 (saveFailed)', () => {
  it('이유와 안내 문구만 남기고 피드백은 없다', () => {
    const request = makeRequest()
    const record = recordOf(request, { attempts: 3 })

    h.reviews.saveFailed(record, { reason: 'invalid-response', message: '형식에 맞지 않았습니다.' })

    expect(h.reviews.getReview('req-1')).toEqual({
      ...record,
      sentTargetParagraphIds: null,
      sentContextParagraphIds: null,
      status: 'failed',
      failureReason: 'invalid-response',
      failureMessage: '형식에 맞지 않았습니다.',
    })
    expect(countRows('feedback_item')).toBe(0)
  })

  it('없는 요청은 null 이다', () => {
    expect(h.reviews.getReview('none')).toBeNull()
  })

  it('문서의 검토 기록을 요청한 순서대로 돌려준다', () => {
    const second = makeRequest({ requestId: 'req-2' })
    const first = makeRequest({ requestId: 'req-1' })
    h.reviews.saveSucceeded(
      recordOf(second, { requestedAt: '2026-09-11T02:00:00.000Z' }),
      validated(second, [modelItem()]),
      0,
    )
    h.reviews.saveFailed(recordOf(first, { requestedAt: '2026-09-11T01:00:00.000Z' }), {
      reason: 'rate-limited',
      message: '잠시 뒤 다시 요청해 주세요.',
    })

    expect(h.reviews.listReviews('doc-1').map((r) => [r.requestId, r.status])).toEqual([
      ['req-1', 'failed'],
      ['req-2', 'succeeded'],
    ])
    expect(h.reviews.listReviews('other-doc')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 저장소를 거치지 않은 삽입 — 스키마(0004) 가 스스로 막는다
// ---------------------------------------------------------------------------

describe('0004_reviews.sql 의 CHECK 와 트리거', () => {
  function insertRequestRow(overrides: Record<string, unknown> = {}): void {
    h.db
      .prepare(
        `INSERT INTO review_request
           (id, document_id, version_id, rubric_version, scope, stage, perspectives,
            target_paragraph_ids, context_paragraph_ids, model_id, prompt_version,
            requested_at, completed_at, attempts, status, summary, dropped_count,
            failure_reason, failure_message)
         VALUES
           (@id, @document_id, @version_id, @rubric_version, @scope, @stage, @perspectives,
            @target_paragraph_ids, @context_paragraph_ids, @model_id, @prompt_version,
            @requested_at, @completed_at, @attempts, @status, @summary, @dropped_count,
            @failure_reason, @failure_message)`,
      )
      .run({
        id: 'raw-req',
        document_id: 'doc-1',
        version_id: 'ver-1',
        rubric_version: h.rubric.rubricVersion,
        scope: 'paragraph',
        stage: 'question',
        perspectives: JSON.stringify(['logic']),
        target_paragraph_ids: JSON.stringify([h.target1.uuid]),
        context_paragraph_ids: JSON.stringify([h.contextParagraph.uuid]),
        model_id: META.modelId,
        prompt_version: META.promptVersion,
        requested_at: '2026-09-11T01:00:00.000Z',
        completed_at: '2026-09-11T01:00:05.000Z',
        attempts: 1,
        status: 'succeeded',
        summary: '요약',
        dropped_count: 0,
        failure_reason: null,
        failure_message: null,
        ...overrides,
      })
  }

  function insertItemRow(overrides: Record<string, unknown> = {}): void {
    h.db
      .prepare(
        `INSERT INTO feedback_item
           (id, request_id, position, paragraph_uuid, perspective, stage, severity, body, rationale,
            applied_rubric_item_ids, example)
         VALUES
           (@id, @request_id, @position, @paragraph_uuid, @perspective, @stage, @severity, @body, @rationale,
            @applied_rubric_item_ids, @example)`,
      )
      .run({
        id: 'raw-item',
        request_id: 'raw-req',
        position: 0,
        paragraph_uuid: h.target1.uuid,
        perspective: 'logic',
        stage: 'question',
        severity: 3,
        body: '본문',
        rationale: '근거',
        applied_rubric_item_ids: '[]',
        example: null,
        ...overrides,
      })
  }

  it('조건을 모두 지키면 들어간다 (아래 거절이 우연이 아님을 확인)', () => {
    insertRequestRow()
    insertItemRow()
    expect(countRows('feedback_item')).toBe(1)
  })

  it('실패한 요청에는 피드백을 저장할 수 없다', () => {
    insertRequestRow({ status: 'failed', summary: null, failure_reason: 'network', failure_message: '연결 실패' })
    expect(() => insertItemRow()).toThrow('성공하지 않은 검토 요청')
    expect(countRows('feedback_item')).toBe(0)
  })

  it('없는 요청에는 피드백을 저장할 수 없다', () => {
    // 여러 트리거가 동시에 걸린다. 어느 것이 먼저 멈추는지는 SQLite 가 정하므로 거절됐다는 사실만 본다.
    expect(() => insertItemRow({ request_id: 'missing' })).toThrow(/피드백[을은] 저장할 수 없습니다/)
    expect(countRows('feedback_item')).toBe(0)
  })

  it('요청의 검토 대상이 아닌 문단에는 저장할 수 없다 (문맥 문단과 모르는 문단 모두)', () => {
    insertRequestRow()
    expect(() => insertItemRow({ paragraph_uuid: h.contextParagraph.uuid })).toThrow('검토 대상이 아닌 문단')
    expect(() => insertItemRow({ paragraph_uuid: 'invented-uuid' })).toThrow('검토 대상이 아닌 문단')
    expect(countRows('feedback_item')).toBe(0)
  })

  it('요청한 단계와 다른 단계의 피드백은 저장할 수 없다', () => {
    insertRequestRow()
    expect(() => insertItemRow({ stage: 'explanation' })).toThrow('요청한 단계와 다른 피드백')
    // 예시 단계로 올려 예시를 끼워 넣는 것도 막힌다.
    expect(() => insertItemRow({ stage: 'example', example: '대신 쓴 문장' })).toThrow('요청한 단계와 다른 피드백')
    expect(countRows('feedback_item')).toBe(0)
  })

  it('예시 단계가 아니면 예시를 저장할 수 없고, 예시 단계면 예시가 있어야 한다 (T-3)', () => {
    insertRequestRow()
    expect(() => insertItemRow({ example: '대신 쓴 문장' })).toThrow(/CHECK/)

    insertRequestRow({ id: 'raw-example', stage: 'example' })
    expect(() => insertItemRow({ request_id: 'raw-example', stage: 'example', example: null })).toThrow(/CHECK/)
    insertItemRow({ id: 'ok-example', request_id: 'raw-example', stage: 'example', example: '짧은 예시' })
    expect(countRows('feedback_item')).toBe(1)
  })

  it('심각도는 1~5, 본문과 근거는 비어 있을 수 없다', () => {
    insertRequestRow()
    for (const overrides of [{ severity: 0 }, { severity: 6 }, { body: '' }, { rationale: '' }]) {
      expect(() => insertItemRow(overrides)).toThrow(/CHECK/)
    }
    expect(countRows('feedback_item')).toBe(0)
  })

  it('요청의 상태와 결과 필드가 어긋나면 저장할 수 없다', () => {
    const invalid: Record<string, unknown>[] = [
      { summary: null },
      { failure_reason: 'network' },
      { status: 'failed' },
      { status: 'failed', summary: null, failure_reason: 'network', failure_message: null },
      { attempts: -1 },
      { dropped_count: -1 },
      { stage: 'final' },
    ]
    for (const overrides of invalid) expect(() => insertRequestRow(overrides)).toThrow(/CHECK/)
    expect(countRows('review_request')).toBe(0)
  })

  it('확정되지 않은 지침 판으로는 요청을 저장할 수 없다', () => {
    expect(() => insertRequestRow({ rubric_version: 'draft-never-confirmed' })).toThrow(/FOREIGN KEY/)
  })
})
