/**
 * 4단계 — 빠른 검토 요청 유스케이스 (app/review-request.ts).
 *
 * 가짜 모델·가짜 온라인 상태를 넣고, 저장소는 실제 SQLite(메모리)를 쓴다.
 *
 * T-1  글이 없는 문단에는 검토 요청이 만들어지지 않는다.
 * T-3  예시를 요청하지 않았는데 예시가 온 항목은 버려지고 저장되지 않는다.
 * T-5  확정하지 않은 지침으로는 모델이 불리지 않는다. 초안이 있어도 마지막 확정 판만 실린다.
 * T-17 모델에 가는 문단이 (대상 + 지정된 문맥) 이내다.
 * T-27 스키마 검증 실패는 정해진 횟수만 다시 묻고 실패로 보고되며, 미검증 원문이 결과·기록에 남지 않는다.
 * T-29 요청에 실린 문단이 대상·문맥으로 한정되고, 무엇이 나갔는지 기록된다.
 * T-32 오프라인이어도 저장된 검토 기록은 읽힌다.
 * T-33 오프라인·키 미등록이면 검토 요청만 막히고, 그 사실을 안내한다.
 */
import { createReviewContextRepository } from '../src/adapters/repo/review-context.js'
import { createReviewContextService, type ReviewContextService } from '../src/app/review-context.js'
import { join } from 'node:path'

import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  ModelAvailability,
  ModelCallResult,
  ReviewModel,
} from '../src/adapters/model/index.js'
import type { ReviewRequest } from '../src/adapters/model/schema.js'
import { createReviewCacheRepository } from '../src/adapters/repo/cache.js'
import { createDocumentRepository, type DocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createReviewRepository, type ReviewRepository } from '../src/adapters/repo/reviews.js'
import { createRubricRepository } from '../src/adapters/repo/rubric.js'
import {
  checkReviewAvailability,
  createReviewService,
  MAX_MODEL_ATTEMPTS,
  OFFLINE_MESSAGE,
  type QuickReviewInput,
  type ReviewService,
} from '../src/app/review-request.js'
import { createRubricService, UNAVAILABLE_SUGGESTER, type RubricService } from '../src/app/rubric.js'
import { CONTEXT_RADIUS } from '../src/core/diff/context.js'
import type { Paragraph } from '../src/core/document/model.js'
import type { ConfirmedRubric } from '../src/core/rubric/model.js'

import { makeParagraphs } from './helpers/paragraphs.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')

/** 모델이 보낸 값에 섞어 넣는 표식. 결과·기록·안내 문구에 보이면 미검증 원문이 샌 것이다 */
const RAW = 'RAW-모델원문-표식'

/**
 * 문서 문단. 인덱스로 가리킨다.
 * 0 제목 · 1 방법 · 2 빈 문단 · 3 결과 제목 · 4 결과 · 5 해석 · 6 결론 제목 · 7 결론
 */
const TEXTS = [
  '1. 실험 방법',
  '주사기에 공기를 넣고 온도를 바꾸었다.',
  '',
  '2. 결과',
  '온도가 올라가면 압력이 증가했다.',
  '그래프의 기울기는 일정했다.',
  '3. 결론',
  '따라서 보일 법칙이 성립한다.',
]

// ---------------------------------------------------------------------------
// 가짜 어댑터
// ---------------------------------------------------------------------------

type Reply = ModelCallResult | Error

interface FakeModel extends ReviewModel {
  /** review 가 받은 요청. 부른 횟수이기도 하다 */
  calls: ReviewRequest[]
  availabilityChecks: number
  /** 다음 review 호출이 돌려줄 결과. 순서대로 쓰고, 다 쓰면 테스트가 실패한다 */
  replies: Reply[]
  availability: ModelAvailability
}

function createFakeModel(): FakeModel {
  const fake: FakeModel = {
    modelId: 'test/fake-model',
    promptVersion: 'quick-review.test',
    calls: [],
    availabilityChecks: 0,
    replies: [],
    availability: { available: true },
    checkAvailability() {
      fake.availabilityChecks += 1
      return Promise.resolve(fake.availability)
    },
    review(request) {
      fake.calls.push(request)
      const reply = fake.replies.shift()
      if (reply === undefined) throw new Error('테스트가 준비한 응답보다 많이 불렸습니다.')
      if (reply instanceof Error) return Promise.reject(reply)
      return Promise.resolve(reply)
    },
  }
  return fake
}

interface Harness {
  db: Database.Database
  documents: DocumentRepository
  rubric: RubricService
  reviews: ReviewRepository
  model: FakeModel
  setOnline: (online: boolean) => void
  service: ReviewService
  paragraphs: Paragraph[]
  confirmed: ConfirmedRubric
  /** 검토 맥락 ([Q-48]). 문서 종류를 고치는 데 쓴다 */
  context: ReviewContextService
}

const cleanups: (() => void)[] = []
let h: Harness

function addDocument(documents: DocumentRepository, id: string, paragraphs: readonly Paragraph[] | null): void {
  documents.createDocument({
    id,
    path: `/tmp/${id}.hwpx`,
    displayName: `${id}.hwpx`,
    subject: '화학',
    createdAt: '2026-09-11T00:00:00.000Z',
  })
  if (paragraphs === null) return
  documents.appendVersion({
    id: `${id}-v1`,
    documentId: id,
    detectedAt: '2026-09-11T00:00:00.000Z',
    sourcePath: `/tmp/${id}.hwpx`,
    byteSize: 1,
    contentHash: `${id}-bytes`,
    paragraphs: paragraphs.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
    lineage: [],
    diffEntries: [],
    previousVersionId: null,
  })
}

function createHarness(): Harness {
  const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })
  cleanups.push(() => db.close())

  const documents = createDocumentRepository(db)
  const paragraphs = makeParagraphs(TEXTS)
  addDocument(documents, 'doc-1', paragraphs)

  let clock = 0
  const now = (): string => new Date(1_800_000_000_000 + (clock += 1) * 1000).toISOString()

  let rubricIds = 0
  const rubric = createRubricService({
    documents,
    rubrics: createRubricRepository(db),
    suggester: UNAVAILABLE_SUGGESTER,
    now,
    newId: () => `rubric-item-${(rubricIds += 1)}`,
  })
  const confirmedResult = rubric.confirm('doc-1', [
    { itemId: null, title: '실험 목적', description: '', importance: 4 },
    { itemId: null, title: '결과 해석', description: '그래프를 근거로 해석하는가', importance: 5 },
  ])
  if (!confirmedResult.ok) throw new Error(confirmedResult.message)

  const reviews = createReviewRepository(db)
  const cache = createReviewCacheRepository(db)
  const model = createFakeModel()
  let online = true

  let ids = 0
  const context = createReviewContextService({ repo: createReviewContextRepository(db), now })
  const service = createReviewService({
    documents,
    context,
    reviews,
    cache,
    // 깊이별 어댑터. 이 테스트는 빠른 검토 경로를 본다 (심층은 claude-code.test.ts).
    models: { quick: model, deep: model },
    online: { isOnline: () => online },
    now,
    newId: () => `id-${(ids += 1)}`,
  })

  return {
    db,
    documents,
    rubric,
    reviews,
    model,
    setOnline: (value) => {
      online = value
    },
    service,
    paragraphs,
    confirmed: confirmedResult.rubric,
    context,
  }
}

beforeEach(() => {
  h = createHarness()
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function uuidAt(index: number): string {
  const paragraph = h.paragraphs[index]
  if (paragraph === undefined) throw new Error(`문단 ${index} 이 없습니다`)
  return paragraph.uuid
}

function reviewInput(overrides: Partial<QuickReviewInput> = {}): QuickReviewInput {
  return {
    documentId: 'doc-1',
    depth: 'quick',
    paragraphIds: [uuidAt(4)],
    scope: 'paragraph',
    perspectives: ['logic', 'expression'],
    stage: 'question',
    ...overrides,
  }
}

function modelItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paragraph: 'P1',
    perspective: 'logic',
    severity: 3,
    body: '온도와 압력의 관계를 어떤 자료로 확인했나요?',
    rationale: '결과 문단에 근거가 된 측정값이 드러나지 않습니다.',
    rubricItems: ['R2'],
    ...overrides,
  }
}

function text(items: unknown[], summary: unknown = '결과 문단의 근거를 다시 볼 곳이 있습니다.'): ModelCallResult {
  return { ok: true, text: JSON.stringify({ summary, items }) }
}

/** 스키마를 어긴 응답. 모두 모델이 보낸 원문 표식을 담는다 */
const SCHEMA_VIOLATIONS: ModelCallResult[] = [
  { ok: true, text: `여기 결과입니다: ${RAW}` },
  { ok: true, text: JSON.stringify({ items: [modelItem({ body: RAW })] }) },
  { ok: true, text: JSON.stringify({ summary: RAW, items: [modelItem({ paragraph: 'P9', body: RAW })] }) },
]

const MALFORMED: ModelCallResult = { ok: false, reason: 'malformed', message: '응답 형식을 읽지 못했습니다.' }

function countItems(): number {
  return (h.db.prepare('SELECT COUNT(*) AS n FROM feedback_item').get() as { n: number }).n
}

// ---------------------------------------------------------------------------
// 재시도와 실패 보고 (T-27)
// ---------------------------------------------------------------------------

describe('모델 호출과 재시도 (T-27)', () => {
  it('최대 호출 횟수는 3이다', () => {
    expect(MAX_MODEL_ATTEMPTS).toBe(3)
  })

  it('첫 응답이 통과하면 한 번만 부르고 대상 문단에 연결해 저장한다', async () => {
    h.model.replies = [text([modelItem()])]

    const result = await h.service.requestReview(reviewInput())

    expect(result).toMatchObject({ ok: true, attempts: 1, droppedCount: 0 })
    if (!result.ok) throw new Error(result.message)
    expect(h.model.calls).toHaveLength(1)
    expect(result.response.items.map((i) => [i.paragraphId, i.stage])).toEqual([[uuidAt(4), 'question']])

    const stored = h.reviews.getReview(result.requestId)
    expect(stored).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      documentId: 'doc-1',
      versionId: 'doc-1-v1',
      // 검토는 평가 지침 대신 보고서의 검토 맥락에 잇는다 ([Q-48]).
      rubricVersion: 'review-context:doc-1',
      modelId: 'test/fake-model',
      promptVersion: 'quick-review.test',
    })
    // 저장된 항목은 응답 그대로이고, 문단 범위라 문장 앵커가 붙지 않는다 (5단계).
    expect(stored?.status === 'succeeded' && stored.items).toEqual(
      result.response.items.map((item) => ({ ...item, sentenceAnchorId: null })),
    )
  })

  it('스키마를 어긴 응답은 다시 묻고, 통과한 응답만 저장한다', async () => {
    h.model.replies = [SCHEMA_VIOLATIONS[0]!, SCHEMA_VIOLATIONS[1]!, text([modelItem()])]

    const result = await h.service.requestReview(reviewInput())

    expect(result).toMatchObject({ ok: true, attempts: 3 })
    expect(h.model.calls).toHaveLength(3)
    // 다시 물을 때도 같은 요청을 보낸다.
    expect(new Set(h.model.calls.map((c) => c.requestId)).size).toBe(1)

    const all = h.reviews.listReviews('doc-1')
    expect(all.map((r) => [r.status, r.attempts])).toEqual([['succeeded', 3]])
    expect(JSON.stringify(all)).not.toContain(RAW)
  })

  it('봉투를 읽지 못한 응답(malformed)도 스키마 위반처럼 다시 묻는다', async () => {
    h.model.replies = [MALFORMED, text([modelItem()])]

    const result = await h.service.requestReview(reviewInput())

    expect(result).toMatchObject({ ok: true, attempts: 2 })
    expect(h.model.calls).toHaveLength(2)
  })

  it('끝내 형식을 어기면 정해진 횟수에서 멈추고, 실패와 이유만 저장한다', async () => {
    h.model.replies = [...SCHEMA_VIOLATIONS, text([modelItem()])]

    const result = await h.service.requestReview(reviewInput())

    expect(h.model.calls).toHaveLength(MAX_MODEL_ATTEMPTS)
    expect(h.model.replies).toHaveLength(1) // 네 번째 응답은 쓰이지 않았다
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('실패해야 합니다')
    expect(result.reason).toBe('invalid-response')
    expect(result.message).toContain(`${MAX_MODEL_ATTEMPTS}번`)
    expect(result.message).not.toContain(RAW)
    expect(result.requestId).toBe(h.model.calls[0]?.requestId)

    const stored = h.reviews.getReview(result.requestId!)
    expect(stored).toMatchObject({
      status: 'failed',
      attempts: MAX_MODEL_ATTEMPTS,
      failureReason: 'invalid-response',
      failureMessage: result.message,
    })
    expect(JSON.stringify(stored)).not.toContain(RAW)
    expect(countItems()).toBe(0)
  })

  it('malformed 와 스키마 위반이 섞여도 횟수를 함께 센다', async () => {
    h.model.replies = [MALFORMED, SCHEMA_VIOLATIONS[0]!, MALFORMED]

    const result = await h.service.requestReview(reviewInput())

    expect(h.model.calls).toHaveLength(MAX_MODEL_ATTEMPTS)
    expect(result).toMatchObject({ ok: false, reason: 'invalid-response' })
  })

  it.each([
    ['unauthorized', 'OpenRouter 가 API 키를 거절했습니다.'],
    ['payment-required', '크레딧이 부족합니다.'],
    ['rate-limited', '요청 한도를 넘었습니다.'],
    ['server-error', 'OpenRouter 서비스 오류입니다.'],
    ['network', '연결하지 못했습니다.'],
    ['timeout', '시간이 초과되었습니다.'],
  ] as const)('API 오류(%s)는 다시 묻지 않고 그 안내를 저장·보고한다', async (reason, message) => {
    h.model.replies = [{ ok: false, reason, message }]

    const result = await h.service.requestReview(reviewInput())

    expect(h.model.calls).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, reason: 'model-failed', message })
    if (result.ok) throw new Error('실패해야 합니다')
    expect(h.reviews.getReview(result.requestId!)).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureReason: reason,
      failureMessage: message,
    })
  })

  it('스키마 위반 뒤 API 오류가 나면 그때까지 부른 횟수를 기록하고 멈춘다', async () => {
    h.model.replies = [SCHEMA_VIOLATIONS[0]!, { ok: false, reason: 'rate-limited', message: '한도 초과' }]

    const result = await h.service.requestReview(reviewInput())

    expect(h.model.calls).toHaveLength(2)
    expect(result).toMatchObject({ ok: false, reason: 'model-failed' })
    expect(h.reviews.listReviews('doc-1').map((r) => [r.status, r.attempts])).toEqual([['failed', 2]])
  })

  it('어댑터가 약속을 어기고 예외를 던져도 연결 실패로 기록하고 알린다', async () => {
    h.model.replies = [new Error('소켓이 닫혔습니다')]

    const result = await h.service.requestReview(reviewInput())

    expect(h.model.calls).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, reason: 'model-failed' })
    if (result.ok) throw new Error('실패해야 합니다')
    expect(result.message).toContain('소켓이 닫혔습니다')
    expect(h.reviews.getReview(result.requestId!)).toMatchObject({ status: 'failed', failureReason: 'network' })
  })
})

// ---------------------------------------------------------------------------
// 규칙을 어긴 항목 (T-3)
// ---------------------------------------------------------------------------

describe('규칙을 어긴 항목은 버리고 몇 개 버렸는지 남긴다', () => {
  it('예시를 요청하지 않았는데 예시가 온 항목, 대상이 아닌 문단을 가리키는 항목을 버린다 (T-3)', async () => {
    h.model.replies = [
      text([
        modelItem({ example: `대신 쓴 문장 ${RAW}` }),
        modelItem({ paragraph: 'C1', body: `문맥 문단에 단 피드백 ${RAW}` }),
        modelItem({ paragraph: 'P9' }),
        modelItem({ perspective: 'expression', severity: 2 }),
      ]),
    ]

    const result = await h.service.requestReview(reviewInput())

    expect(result).toMatchObject({ ok: true, attempts: 1, droppedCount: 3 })
    if (!result.ok) throw new Error(result.message)
    expect(result.response.items).toHaveLength(1)
    expect(result.response.items[0]).toMatchObject({ paragraphId: uuidAt(4), perspective: 'expression' })
    expect(result.response.items.some((i) => 'example' in i)).toBe(false)

    const stored = h.reviews.getReview(result.requestId)
    expect(stored).toMatchObject({ status: 'succeeded', droppedCount: 3 })
    expect(JSON.stringify(stored)).not.toContain(RAW)
    expect(countItems()).toBe(1)
  })

  it('예시 단계를 요청했을 때만 예시가 저장된다', async () => {
    h.model.replies = [text([modelItem({ example: '측정값 표를 근거로 들어 보세요.' })])]

    const result = await h.service.requestReview(reviewInput({ stage: 'example' }))

    if (!result.ok) throw new Error(result.message)
    const stored = h.reviews.getReview(result.requestId)
    expect(stored?.status === 'succeeded' && stored.items.map((i) => i.example)).toEqual([
      '측정값 표를 근거로 들어 보세요.',
    ])
  })

  it('보낸 항목이 모두 규칙을 어기면 응답 전체를 형식 위반으로 보고 다시 묻는다', async () => {
    h.model.replies = [text([modelItem({ example: RAW })]), text([modelItem()])]

    const result = await h.service.requestReview(reviewInput())

    expect(result).toMatchObject({ ok: true, attempts: 2, droppedCount: 0 })
    expect(h.model.calls).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 대상 문단 확인 — 모델을 부르기 전에 막는다 (T-1)
// ---------------------------------------------------------------------------

describe('대상 문단 확인', () => {
  async function expectBlocked(input: QuickReviewInput, reason: string): Promise<void> {
    const result = await h.service.requestReview(input)
    expect(result).toMatchObject({ ok: false, reason, requestId: null })
    if (result.ok) throw new Error('막혀야 합니다')
    expect(result.message).not.toBe('')
    expect(h.model.calls).toHaveLength(0)
    expect(h.reviews.listReviews(input.documentId)).toEqual([])
  }

  it('문단을 고르지 않으면 요청하지 않는다', async () => {
    await expectBlocked(reviewInput({ paragraphIds: [] }), 'invalid-request')
  })

  it('같은 문단을 두 번 고르면 요청하지 않는다', async () => {
    await expectBlocked(reviewInput({ paragraphIds: [uuidAt(4), uuidAt(4)] }), 'invalid-request')
  })

  it('최신 버전에 없는 문단이 섞여 있으면 요청하지 않는다', async () => {
    await expectBlocked(reviewInput({ paragraphIds: [uuidAt(4), 'uuid-not-in-version'] }), 'invalid-request')
  })

  it('글이 없는 문단이 대상에 있으면 요청하지 않는다 (T-1)', async () => {
    await expectBlocked(reviewInput({ paragraphIds: [uuidAt(4), uuidAt(2)] }), 'no-content')
  })

  it('등록되지 않은 문서, 버전이 없는 문서는 요청하지 않는다', async () => {
    await expectBlocked(reviewInput({ documentId: 'unknown' }), 'unknown-document')
    addDocument(h.documents, 'doc-empty', null)
    await expectBlocked(reviewInput({ documentId: 'doc-empty' }), 'no-version')
  })

  it('요청을 만들 수 없는 조건(관점 없음)이면 모델을 부르지 않는다', async () => {
    await expectBlocked(reviewInput({ perspectives: [] }), 'invalid-request')
  })

  it('다른 버전이 새로 기록되면 최신 버전의 문단만 대상으로 받는다', async () => {
    const edited = makeParagraphs([...TEXTS.slice(0, 4), '온도가 올라가면 압력이 비례해 증가했다.', ...TEXTS.slice(5)])
    h.documents.appendVersion({
      id: 'doc-1-v2',
      documentId: 'doc-1',
      detectedAt: '2026-09-11T00:10:00.000Z',
      sourcePath: '/tmp/doc-1.hwpx',
      byteSize: 2,
      contentHash: 'doc-1-bytes-2',
      paragraphs: edited.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
      lineage: [],
      diffEntries: [],
      previousVersionId: 'doc-1-v1',
    })
    expect(edited[4]?.uuid).not.toBe(uuidAt(4))

    await expectBlocked(reviewInput(), 'invalid-request')

    h.model.replies = [text([modelItem()])]
    const result = await h.service.requestReview(reviewInput({ paragraphIds: [edited[4]!.uuid] }))
    expect(result.ok).toBe(true)
    expect(h.model.calls[0]?.documentVersionId).toBe('doc-1-v2')
  })
})

// ---------------------------------------------------------------------------
// 보내는 문단 — 대상과 지정된 문맥만 (T-17, T-29)
// ---------------------------------------------------------------------------

describe('모델에 보내는 문단', () => {
  it('문맥 범위는 대상 한쪽마다 1문단이다', () => {
    expect(CONTEXT_RADIUS).toBe(1)
  })

  it('대상과 그 앞뒤의 가장 가까운 글 있는 문단만 싣고, 실은 것을 기록한다', async () => {
    h.model.replies = [text([modelItem()])]

    // 결과 문단(4) 의 앞은 제목(3), 뒤는 해석(5).
    const result = await h.service.requestReview(reviewInput({ paragraphIds: [uuidAt(4)] }))
    if (!result.ok) throw new Error(result.message)

    const request = h.model.calls[0]!
    expect(request.targets.map((t) => t.paragraphId)).toEqual([uuidAt(4)])
    expect(request.targets.map((t) => t.text)).toEqual([TEXTS[4]])
    expect(request.context.map((c) => c.paragraphId)).toEqual([uuidAt(3), uuidAt(5)])

    expect(h.reviews.getReview(result.requestId)).toMatchObject({
      targetParagraphIds: [uuidAt(4)],
      contextParagraphIds: [uuidAt(3), uuidAt(5)],
    })
  })

  it('빈 문단은 문맥으로 세지 않고 건너뛴다', async () => {
    h.model.replies = [text([modelItem()])]

    // 제목(3) 앞은 빈 문단(2) 이므로 방법(1) 이 문맥이 된다.
    await h.service.requestReview(reviewInput({ paragraphIds: [uuidAt(3)] }))

    expect(h.model.calls[0]?.context.map((c) => c.paragraphId)).toEqual([uuidAt(1), uuidAt(4)])
  })

  it('이어진 대상 묶음은 묶음 전체의 앞뒤만 문맥으로 받는다', async () => {
    h.model.replies = [text([modelItem(), modelItem({ paragraph: 'P2' })])]

    const result = await h.service.requestReview(reviewInput({ paragraphIds: [uuidAt(5), uuidAt(4)] }))
    if (!result.ok) throw new Error(result.message)

    const request = h.model.calls[0]!
    expect(request.targets.map((t) => t.paragraphId)).toEqual([uuidAt(4), uuidAt(5)])
    expect(request.context.map((c) => c.paragraphId)).toEqual([uuidAt(3), uuidAt(6)])
    const sent = [...request.targets, ...request.context].map((p) => p.paragraphId)
    expect(sent.length).toBeLessThanOrEqual(2 + 2 * CONTEXT_RADIUS)
    expect(result.response.items.map((i) => i.paragraphId)).toEqual([uuidAt(4), uuidAt(5)])
  })
})

// ---------------------------------------------------------------------------
// 확정 지침 관문 (T-5)
// ---------------------------------------------------------------------------

describe('검토는 평가 지침을 쓰지 않는다 ([Q-48])', () => {
  it('확정한 지침이 없어도 검토한다', async () => {
    addDocument(h.documents, 'doc-2', makeParagraphs(['온도가 올라가면 압력이 증가했다.']))
    h.rubric.saveDraft('doc-2', [{ itemId: null, title: '초안 항목', description: '', importance: 3 }])
    const target = h.documents.listParagraphs('doc-2-v1')[0]!.uuid
    h.model.replies = [text([modelItem()])]

    const result = await h.service.requestReview(reviewInput({ documentId: 'doc-2', paragraphIds: [target] }))

    expect(result).toMatchObject({ ok: true })
    expect(h.reviews.listReviews('doc-2')).toHaveLength(1)
  })

  it('확정한 지침이 있어도 요청에 싣지 않고, 모델이 적은 지침 id 는 무시한다', async () => {
    h.rubric.saveDraft('doc-1', [{ itemId: null, title: '초안에만 있는 항목', description: '', importance: 1 }])
    h.model.replies = [text([modelItem({ rubricItems: ['R2'] })])]

    const result = await h.service.requestReview(reviewInput())
    if (!result.ok) throw new Error(result.message)

    const request = h.model.calls[0]!
    expect(request.rubric.items).toEqual([])
    expect(JSON.stringify(request)).not.toContain('실험 목적')
    expect(JSON.stringify(request)).not.toContain('초안에만 있는 항목')
    expect(result.response.items[0]?.appliedRubricItemIds).toEqual([])
  })

  it('문서 종류를 알면 싣고, 모르면 싣지 않는다', async () => {
    h.model.replies = [text([modelItem()]), text([modelItem()])]
    await h.service.requestReview(reviewInput())
    expect(h.model.calls[0]!.documentKind).toBe('')
    h.context.setKind('doc-1', '실험 보고서 — 기체 몰질량')
    await h.service.requestReview(reviewInput())
    expect(h.model.calls[1]!.documentKind).toBe('실험 보고서 — 기체 몰질량')
  })

  it('승인한 개인화 지침 제공자가 없으면 아무 지침도 싣지 않는다', async () => {
    h.model.replies = [text([modelItem()])]
    await h.service.requestReview(reviewInput())
    expect(h.model.calls[0]?.personalization.approvedGuidelines).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 오프라인·키 미등록 (T-32, T-33)
// ---------------------------------------------------------------------------

describe('오프라인과 키 미등록', () => {
  it('오프라인이면 모델에 묻지도 않고 검토 요청만 막는다 (T-33)', async () => {
    h.setOnline(false)

    const result = await h.service.requestReview(reviewInput())

    expect(result).toEqual({ ok: false, reason: 'offline', message: OFFLINE_MESSAGE, requestId: null })
    expect(h.model.availabilityChecks).toBe(0)
    expect(h.model.calls).toHaveLength(0)
    expect(h.reviews.listReviews('doc-1')).toEqual([])
    expect(await h.service.availability('quick')).toEqual({ available: false, reason: 'offline', message: OFFLINE_MESSAGE })
  })

  it('오프라인이어도 저장된 검토 기록은 읽히고, 지침 편집·버전 기록은 그대로 된다 (T-32)', async () => {
    h.model.replies = [text([modelItem()])]
    const earlier = await h.service.requestReview(reviewInput())
    if (!earlier.ok) throw new Error(earlier.message)

    h.setOnline(false)

    expect(h.service.listReviews('doc-1').map((r) => r.requestId)).toEqual([earlier.requestId])
    expect(h.rubric.saveDraft('doc-1', [{ itemId: null, title: '새 항목', description: '', importance: 2 }]).ok).toBe(true)
    h.documents.appendVersion({
      id: 'doc-1-v2',
      documentId: 'doc-1',
      detectedAt: '2026-09-11T00:10:00.000Z',
      sourcePath: '/tmp/doc-1.hwpx',
      byteSize: 2,
      contentHash: 'doc-1-bytes-2',
      paragraphs: h.paragraphs.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
      lineage: [],
      diffEntries: [],
      previousVersionId: 'doc-1-v1',
    })
    expect(h.documents.latestVersion('doc-1')?.id).toBe('doc-1-v2')
    expect(h.model.calls).toHaveLength(1)
  })

  it('키가 없으면 어댑터의 안내로 검토 요청만 막는다', async () => {
    const message = 'OpenRouter API 키를 먼저 등록해 주세요.'
    h.model.availability = { available: false, reason: 'no-key', message }

    const result = await h.service.requestReview(reviewInput())

    expect(result).toEqual({ ok: false, reason: 'no-key', message, requestId: null })
    expect(h.model.calls).toHaveLength(0)
    expect(await h.service.availability('quick')).toEqual({ available: false, reason: 'no-key', message })
  })

  it('다시 온라인이 되면 같은 요청이 통과한다', async () => {
    h.setOnline(false)
    expect((await h.service.requestReview(reviewInput())).ok).toBe(false)

    h.setOnline(true)
    h.model.replies = [text([modelItem()])]
    expect((await h.service.requestReview(reviewInput())).ok).toBe(true)
  })

  it('설정 화면과 검토 요청이 같은 판정을 쓴다', async () => {
    expect(await checkReviewAvailability({ online: { isOnline: () => true }, model: h.model })).toEqual({
      available: true,
    })
    expect(await checkReviewAvailability({ online: { isOnline: () => false }, model: h.model })).toMatchObject({
      available: false,
      reason: 'offline',
    })
  })
})

// ---------------------------------------------------------------------------
// 캐시 (T-12, T-17, T-18)
// ---------------------------------------------------------------------------

describe('검토 캐시', () => {
  it('같은 문단·지침·프롬프트·모델·관점·단계 요청은 두 번째에 모델을 부르지 않는다', async () => {
    h.model.replies = [text([modelItem()])]
    const first = await h.service.requestReview(reviewInput())
    if (!first.ok) throw new Error(first.message)

    const second = await h.service.requestReview(reviewInput())
    if (!second.ok) throw new Error(second.message)

    expect(h.model.calls).toHaveLength(1)
    expect(first.attempts).toBe(1)
    expect(second.attempts).toBe(0)
    expect(h.reviews.getReview(second.requestId)).toMatchObject({
      attempts: 0, sentTargetParagraphIds: [], sentContextParagraphIds: [],
    })
    expect(second.response.items[0]?.body).toBe(first.response.items[0]?.body)
  })

  it('문단 하나만 바뀌면 바뀐 문단만 다시 모델 대상으로 보낸다', async () => {
    h.model.replies = [
      text([
        modelItem(),
        modelItem({ paragraph: 'P2', perspective: 'expression', body: '그래프의 기울기 근거를 덧붙여 볼까요?' }),
      ]),
      text([modelItem()]),
    ]
    const first = await h.service.requestReview(
      reviewInput({ paragraphIds: [uuidAt(4), uuidAt(5)], perspectives: ['logic', 'expression'] }),
    )
    if (!first.ok) throw new Error(first.message)

    const edited = makeParagraphs(
      TEXTS.map((value, index) => (index === 4 ? '온도가 올라가면 압력이 비례해 증가했다.' : value)),
    )
    // 실제 저장의 문단 추적처럼, 같은 자리에서 고친 문단은 UUID만 이어받는다.
    h.documents.appendVersion({
      id: 'doc-1-v2-cache',
      documentId: 'doc-1',
      detectedAt: '2026-09-12T00:00:00.000Z',
      sourcePath: '/tmp/doc-1.hwpx',
      byteSize: 2,
      contentHash: 'doc-1-bytes-cache',
      paragraphs: edited.map((paragraph, index) => ({ uuid: h.paragraphs[index]!.uuid, paragraph })),
      lineage: [],
      diffEntries: [],
      previousVersionId: 'doc-1-v1',
    })

    const second = await h.service.requestReview(
      reviewInput({ paragraphIds: [uuidAt(4), uuidAt(5)], perspectives: ['logic', 'expression'] }),
    )
    if (!second.ok) throw new Error(second.message)

    expect(h.model.calls).toHaveLength(2)
    expect(h.model.calls[1]?.targets.map((target) => target.paragraphId)).toEqual([uuidAt(4)])
    expect(second.attempts).toBe(1)
    expect(h.reviews.getReview(second.requestId)).toMatchObject({
      targetParagraphIds: [uuidAt(4), uuidAt(5)],
      sentTargetParagraphIds: [uuidAt(4)],
      sentContextParagraphIds: h.model.calls[1]!.context.map((context) => context.paragraphId),
    })
  })

  it('같은 요청을 동시에 보내도 한 번만 모델을 부른다', async () => {
    h.model.replies = [text([modelItem()])]
    const results = await Promise.all([
      h.service.requestReview(reviewInput()), h.service.requestReview(reviewInput()),
    ])
    expect(results.map((result) => result.ok && result.attempts)).toEqual([1, 0])
    expect(h.model.calls).toHaveLength(1)
  })

  it('관점을 추가하면 이미 검토한 관점은 다시 보내지 않는다', async () => {
    h.model.replies = [text([modelItem()]), text([modelItem({ perspective: 'expression' })])]
    await h.service.requestReview(reviewInput({ perspectives: ['logic'] }))
    const result = await h.service.requestReview(reviewInput())
    expect(result.ok && result.response.items.map((item) => item.perspective)).toEqual(['logic', 'expression'])
    expect(h.model.calls[1]?.perspectives).toEqual(['expression'])
  })

  it('피드백이 없다는 결과도 캐시하고, 같은 요청에 모델을 다시 부르지 않는다', async () => {
    h.model.replies = [text([])]
    await h.service.requestReview(reviewInput())
    const result = await h.service.requestReview(reviewInput())
    expect(result).toMatchObject({ ok: true, attempts: 0 })
    expect(result.ok && result.response.items).toEqual([])
    expect(h.model.calls).toHaveLength(1)
  })

  it('구조가 손상된 캐시는 예외 없이 다시 검토하고 정상 캐시로 교체한다', async () => {
    h.model.replies = [text([modelItem()]), text([modelItem()])]
    await h.service.requestReview(reviewInput())
    h.db.prepare('UPDATE review_cache SET items_json = ?').run('[null]')
    expect(await h.service.requestReview(reviewInput())).toMatchObject({ ok: true, attempts: 1 })
    expect(await h.service.requestReview(reviewInput())).toMatchObject({ ok: true, attempts: 0 })
    expect(h.model.calls).toHaveLength(2)
  })

  it('동일한 글이 다른 문단에 있어도 피드백을 잘못 연결하지 않는다', async () => {
    const repeated = makeParagraphs(['같은 문장입니다.', '같은 문장입니다.'])
    h.documents.appendVersion({
      id: 'repeated-v2', documentId: 'doc-1', detectedAt: '2026-09-12', sourcePath: '/tmp/doc-1.hwpx',
      byteSize: 2, contentHash: 'repeated', previousVersionId: 'doc-1-v1', lineage: [], diffEntries: [],
      paragraphs: repeated.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
    })
    h.model.replies = [text([modelItem()]), text([modelItem()])]
    for (const paragraph of repeated) {
      const result = await h.service.requestReview(reviewInput({ paragraphIds: [paragraph.uuid] }))
      expect(result.ok && result.response.items[0]?.paragraphId).toBe(paragraph.uuid)
    }
    expect(h.model.calls).toHaveLength(2)
  })

  it('여러 캐시 결과를 합치면 30개가 넘어도 일부를 잃거나 재호출하지 않는다', async () => {
    h.model.replies = [text(Array.from({ length: 20 }, () => modelItem())),
      text(Array.from({ length: 20 }, () => modelItem()))]
    await h.service.requestReview(reviewInput({ paragraphIds: [uuidAt(4)] }))
    await h.service.requestReview(reviewInput({ paragraphIds: [uuidAt(5)] }))
    const result = await h.service.requestReview(reviewInput({ paragraphIds: [uuidAt(4), uuidAt(5)] }))
    expect(result).toMatchObject({ ok: true, attempts: 0 })
    expect(result.ok && result.response.items).toHaveLength(40)
    expect(h.model.calls).toHaveLength(2)
  })

  it.each(['modelId', 'promptVersion', 'stage', 'documentKind'] as const)(
    '%s가 바뀌면 같은 문단이어도 새 검토를 한다', async (component) => {
      h.model.replies = [text([modelItem()]), text([modelItem()])]
      await h.service.requestReview(reviewInput())
      let input = reviewInput()
      if (component === 'stage') input = reviewInput({ stage: 'weak_hint' })
      // 사용자가 문서 종류를 고치면 다시 묻는다 ([Q-48]).
      else if (component === 'documentKind') expect(h.context.setKind('doc-1', '대회 신청서').ok).toBe(true)
      else Object.defineProperty(h.model, component, { value: 'changed-version' })
      expect(await h.service.requestReview(input)).toMatchObject({ ok: true, attempts: 1 })
      expect(h.model.calls).toHaveLength(2)
    },
  )
})

// ---------------------------------------------------------------------------
// 수식만 있는 문단 (2026-09-28 고침)
// "이론적 배경" 처럼 수식만 있는 문단이 섞인 항목이 통째로 "쓴 내용 없음" 으로 막혔다.
// 화면·단계 계층은 수식도 쓴 것으로 보는데, 이 관문만 글만 봤기 때문이다.
// ---------------------------------------------------------------------------

describe('수식만 있는 문단이 섞인 요청', () => {
  function addEquationDocument(): string[] {
    const paragraphs = makeParagraphs(['이상기체 상태방정식으로 몰질량을 구한다.', '', ''])
    paragraphs[1] = { ...paragraphs[1]!, equations: ['PV = nRT'] }
    addDocument(h.documents, 'doc-eq', paragraphs)
    const confirmed = h.rubric.confirm('doc-eq', [{ itemId: null, title: '이론', description: '', importance: 3 }])
    if (!confirmed.ok) throw new Error(confirmed.message)
    return h.documents.listParagraphs('doc-eq-v1').map((entry) => entry.uuid)
  }

  it('수식만 있는 문단은 빼고 글이 있는 문단으로 요청한다 (막지 않는다)', async () => {
    const [written, equation] = addEquationDocument()
    h.model.replies = [text([modelItem({ paragraph: 'P1', rubricItems: ['R1'] })])]
    const result = await h.service.requestReview(reviewInput({ documentId: 'doc-eq', paragraphIds: [written!, equation!] }))
    expect(result).toMatchObject({ ok: true })
    expect(h.model.calls[0]!.targets.map((t) => t.paragraphId)).toEqual([written])
  })

  it('수식만 고르면 보낼 글이 없다고 알리고, 글도 수식도 없는 문단이 섞이면 여전히 막는다', async () => {
    const [written, equation, blank] = addEquationDocument()
    const onlyEquation = await h.service.requestReview(reviewInput({ documentId: 'doc-eq', paragraphIds: [equation!] }))
    expect(onlyEquation).toMatchObject({ ok: false, reason: 'no-content' })
    if (!onlyEquation.ok) expect(onlyEquation.message).toContain('수식만')
    expect(await h.service.requestReview(reviewInput({ documentId: 'doc-eq', paragraphIds: [written!, blank!] })))
      .toMatchObject({ ok: false, reason: 'no-content' })
    expect(h.model.calls).toHaveLength(0)
  })
})
