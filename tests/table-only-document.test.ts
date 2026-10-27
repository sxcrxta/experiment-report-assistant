/**
 * 9단계 — 예외 경로: **표만 있는 보고서** (`IMPLEMENTATION_PLAN.md` §4.4).
 *
 * 결과를 표로만 적어 두고 본문 문단이 없는 보고서가 실제로 있다.
 * 이것은 오류가 아니라 **정상 경로**여야 한다. 화면이 비거나 예외가 나면 안 된다.
 *
 * 여기서 확인하는 것
 * - 표 안 문단도 검토 대상으로 고를 수 있다 (표 안의 글도 사용자가 직접 쓴 글이다)
 * - 제목 문단이 없어도 항목 경계 추정이 무너지지 않는다
 * - 빈 표(글자 없는 칸)만 있으면 선행 작성 보장에 걸려 요청이 막힌다 (T-1)
 *
 * 나머지 예외 경로가 어디에서 검증되는지는 `docs/사용법.md` "예외 상황" 에 적어 두었다.
 */
import { createReviewContextRepository } from '../src/adapters/repo/review-context.js'
import { createReviewContextService } from '../src/app/review-context.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createAnchorRepository } from '../src/adapters/repo/anchors.js'
import { createReviewCacheRepository } from '../src/adapters/repo/cache.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createReviewRepository } from '../src/adapters/repo/reviews.js'
import { createRubricRepository } from '../src/adapters/repo/rubric.js'
import { createReviewService } from '../src/app/review-request.js'
import { createStagedReviewService } from '../src/app/review-stage.js'
import { createRubricService, UNAVAILABLE_SUGGESTER } from '../src/app/rubric.js'
import { paragraphHash, paragraphUuid } from '../src/core/document/hash.js'
import type { Paragraph } from '../src/core/document/model.js'
import { normalizeText } from '../src/core/document/normalize.js'

import { modelReply } from './helpers/review-harness.js'
import type { ModelCallResult, ReviewModel } from '../src/adapters/model/index.js'

const MIGRATIONS = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')
const DOCUMENT = 'table-only'

/** 표 안 문단 하나. 본문 문단은 하나도 만들지 않는다. */
function cell(rawText: string, index: number, row: number, column: number): Paragraph {
  const text = normalizeText(rawText)
  const equations: string[] = []
  return {
    uuid: paragraphUuid({ sectionIndex: 0, index, text, equations }),
    index,
    sectionIndex: 0,
    role: 'body',
    headingLevel: null,
    styleName: '표',
    table: { tableIndex: 0, row, col: column },
    rawText,
    text,
    equations,
    hash: paragraphHash({ text, equations }),
  }
}

function setup(texts: readonly string[]) {
  const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS })
  const documents = createDocumentRepository(db)
  const now = (): string => new Date().toISOString()

  documents.createDocument({ id: DOCUMENT, path: `/tmp/${DOCUMENT}.hwpx`,
    displayName: `${DOCUMENT}.hwpx`, subject: '일반화학실험', createdAt: now() })
  const paragraphs = texts.map((text, index) => cell(text, index, Math.floor(index / 2), index % 2))
  documents.appendVersion({
    id: `${DOCUMENT}-v1`, documentId: DOCUMENT, detectedAt: now(),
    sourcePath: `/tmp/${DOCUMENT}.hwpx`, byteSize: 1, contentHash: `${DOCUMENT}-bytes-1`,
    paragraphs: paragraphs.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
    lineage: [], diffEntries: [], previousVersionId: null,
  })

  const rubric = createRubricService({ documents, rubrics: createRubricRepository(db),
    suggester: UNAVAILABLE_SUGGESTER, now, newId: randomUUID })
  const confirmed = rubric.confirm(DOCUMENT,
    [{ itemId: null, title: '결과', description: '측정값을 밝힌다', importance: 4 }])
  if (!confirmed.ok) throw new Error(confirmed.message)

  const calls: unknown[] = []
  const replies: ModelCallResult[] = []
  const model: ReviewModel = {
    modelId: 'test/fake-model', promptVersion: 'quick-review.test',
    checkAvailability: () => Promise.resolve({ available: true }),
    review: (request) => {
      calls.push(request)
      const reply = replies.shift()
      if (reply === undefined) throw new Error('준비한 응답보다 많이 불렸습니다.')
      return Promise.resolve(reply)
    },
  }
  const reviews = createReviewRepository(db)
  const review = createReviewService({ documents, context: createReviewContextService({ repo: createReviewContextRepository(db), now }), reviews,
    cache: createReviewCacheRepository(db), models: { quick: model, deep: model },
    online: { isOnline: () => true }, now, newId: randomUUID })
  const staged = createStagedReviewService({ documents, reviews, anchors: createAnchorRepository(db),
    rubric, review, now, newId: randomUUID })

  return { db, documents, staged, paragraphs, calls, replies, close: () => db.close() }
}

describe('표만 있는 보고서', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()?.()
  })

  it('표 안 문단을 검토 대상으로 고를 수 있고 화면이 비지 않는다', async () => {
    const h = setup(['온도(℃)', '압력(kPa)', '20', '101.3', '40', '108.2'])
    cleanup.push(h.close)

    const panel = await h.staged.getPanel(DOCUMENT, {})
    if ('ok' in panel) throw new Error(panel.message)
    expect(panel.paragraphs).toHaveLength(6)
    expect(panel.paragraphs.every((paragraph) => paragraph.hasContent)).toBe(true)
    // 제목 문단이 없어도 항목 경계는 나온다. 근거가 없으면 통째로 묶는다.
    expect(panel.sections).toHaveLength(1)
    expect(panel.sections[0]!.source).toBe('fallback')

    h.replies.push(modelReply([{ paragraph: 'P1', perspective: 'logic', severity: 3,
      body: '측정 단위를 표 머리에만 적었는데 본문에서도 밝혔나요?',
      rationale: '표 밖에서는 단위를 확인할 수 없습니다.', rubricItems: [] }]))
    const requested = await h.staged.requestStagedReview({ documentId: DOCUMENT, scope: 'paragraph',
      paragraphIds: [h.paragraphs[2]!.uuid], perspectives: ['logic'], stage: 'question' })
    if (!requested.ok) throw new Error(requested.message)
    expect(h.calls).toHaveLength(1)

    const after = await h.staged.getPanel(DOCUMENT, {})
    if ('ok' in after) throw new Error(after.message)
    expect(after.cards).toHaveLength(1)
  })

  it('글자 없는 빈 표만 있으면 선행 작성 보장에 걸려 요청하지 않는다 (T-1)', async () => {
    const h = setup(['', '', '', ''])
    cleanup.push(h.close)

    const panel = await h.staged.getPanel(DOCUMENT, {})
    if ('ok' in panel) throw new Error(panel.message)
    expect(panel.paragraphs.every((paragraph) => !paragraph.hasContent)).toBe(true)

    const blocked = await h.staged.requestStagedReview({ documentId: DOCUMENT, scope: 'paragraph',
      paragraphIds: [h.paragraphs[0]!.uuid], perspectives: ['logic'], stage: 'question' })
    expect(blocked.ok).toBe(false)
    expect(h.calls).toHaveLength(0)
    // 전체 범위로 요청해도 마찬가지다. 쓴 글이 없으면 피드백을 만들지 않는다.
    const whole = await h.staged.requestStagedReview({ documentId: DOCUMENT, scope: 'document',
      perspectives: ['logic'], stage: 'question' })
    expect(whole.ok).toBe(false)
    expect(h.calls).toHaveLength(0)
  })
})
