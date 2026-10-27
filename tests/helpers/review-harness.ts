/**
 * 5단계 — 선택적 피드백 흐름을 통째로 돌려 보는 하네스.
 *
 * 저장소는 실제 SQLite(메모리)를 쓰고, 가짜로 두는 것은 **모델과 온라인 여부**뿐이다.
 * 단계 진행 제어(`app/review-stage.ts`)와 그 위의 IPC 경계(`main/review-ipc.ts`)가 이 하네스를 함께 쓴다.
 *
 * 문서는 제목 스타일 없이 만든다. 그래야 항목 경계가 **지침 항목 이름**으로 추정되는 길을 지난다.
 */
import { createReviewContextRepository } from '../../src/adapters/repo/review-context.js'
import { createReviewContextService } from '../../src/app/review-context.js'
import { join } from 'node:path'

import type Database from 'better-sqlite3'

import type { ModelAvailability, ModelCallResult, ReviewModel } from '../../src/adapters/model/index.js'
import type { ReviewRequest } from '../../src/adapters/model/schema.js'
import { createAnchorRepository, type AnchorRepository } from '../../src/adapters/repo/anchors.js'
import { createReviewCacheRepository } from '../../src/adapters/repo/cache.js'
import { createDocumentRepository, type DocumentRepository } from '../../src/adapters/repo/documents.js'
import { openDatabase } from '../../src/adapters/repo/index.js'
import { createReviewRepository, type ReviewRepository } from '../../src/adapters/repo/reviews.js'
import { createRubricRepository } from '../../src/adapters/repo/rubric.js'
import { createReviewService, type ReviewServiceDeps } from '../../src/app/review-request.js'
import { createStagedReviewService, type StagedReviewDeps, type StagedReviewService } from '../../src/app/review-stage.js'
import { createRubricService, UNAVAILABLE_SUGGESTER, type RubricService } from '../../src/app/rubric.js'

import { makeParagraphs } from './paragraphs.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'src', 'adapters', 'repo', 'migrations')

export const DOCUMENT_ID = 'doc-1'

/**
 * 하네스 문서의 문단. 인덱스로 가리킨다.
 * 0 방법 제목 · 1 방법(두 문장) · 2 빈 문단 · 3 결과 제목 · 4 결과 · 5 해석
 */
export const REVIEW_TEXTS = [
  '1. 실험 방법',
  '주사기에 공기를 넣고 온도를 바꾸었다. 압력계를 함께 읽었다.',
  '',
  '2. 결과',
  '온도가 올라가면 압력이 증가했다.',
  '그래프의 기울기는 일정했다.',
]

/** 확정 지침 항목의 이름. 항목 경계 추정이 이 이름을 쓴다 */
export const RUBRIC_TITLES = ['실험 방법', '결과']

export interface FakeReviewModel extends ReviewModel {
  /** review 가 받은 요청. 부른 횟수이기도 하다 */
  calls: ReviewRequest[]
  /** 다음 review 호출이 돌려줄 결과. 순서대로 쓰고, 다 쓰면 테스트가 실패한다 */
  replies: ModelCallResult[]
  availability: ModelAvailability
}

function createFakeModel(modelId = 'test/fake-model', promptVersion = 'quick-review.test'): FakeReviewModel {
  const fake: FakeReviewModel = {
    modelId,
    promptVersion,
    calls: [],
    replies: [],
    availability: { available: true },
    checkAvailability: () => Promise.resolve(fake.availability),
    review(request) {
      fake.calls.push(request)
      const reply = fake.replies.shift()
      if (reply === undefined) throw new Error('테스트가 준비한 응답보다 많이 불렸습니다.')
      return Promise.resolve(reply)
    },
  }
  return fake
}

export interface ReviewHarness {
  db: Database.Database
  documents: DocumentRepository
  anchors: AnchorRepository
  reviews: ReviewRepository
  rubric: RubricService
  model: FakeReviewModel
  /** 심층 검토 깊이에 붙은 가짜 어댑터 */
  deepModel: FakeReviewModel
  staged: StagedReviewService
  setOnline(online: boolean): void
  /** 최신 버전에서 index 번째 문단의 uuid */
  uuidAt(index: number): string
  /**
   * 다음 저장을 기록한다. 같은 자리의 문단은 **같은 uuid 를 이어받는다**(문단 추적을 흉내 낸다).
   * 목록이 짧아지면 뒤쪽 문단은 사라진 것이 된다.
   */
  saveVersion(texts: readonly string[]): void
  /** 지침을 확정하지 않은 다른 문서. 화면 상태를 볼 때 쓴다 */
  addDocument(documentId: string, texts: readonly string[]): void
  close(): void
}

/** 8단계에서 주입되는 선택 의존성. 넣지 않으면 그 기능 없이 도는 길을 지난다. */
export type HarnessOptions = Pick<StagedReviewDeps, 'repeatedObservation' | 'preserveFeedback' | 'userReaction'> &
  Pick<ReviewServiceDeps, 'approvedGuidelines'>

export function createReviewHarness(options: HarnessOptions = {}): ReviewHarness {
  const { db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR })

  const documents = createDocumentRepository(db)
  const anchors = createAnchorRepository(db)
  const reviews = createReviewRepository(db)
  const cache = createReviewCacheRepository(db)

  let clock = 0
  const now = (): string => new Date(1_800_000_000_000 + (clock += 1) * 1000).toISOString()

  function addDocument(documentId: string, texts: readonly string[]): void {
    documents.createDocument({
      id: documentId,
      path: `/tmp/${documentId}.hwpx`,
      displayName: `${documentId}.hwpx`,
      subject: '화학',
      createdAt: now(),
    })
    const paragraphs = makeParagraphs(texts)
    documents.appendVersion({
      id: `${documentId}-v1`,
      documentId,
      detectedAt: now(),
      sourcePath: `/tmp/${documentId}.hwpx`,
      byteSize: 1,
      contentHash: `${documentId}-bytes-1`,
      paragraphs: paragraphs.map((paragraph) => ({ uuid: paragraph.uuid, paragraph })),
      lineage: [],
      diffEntries: [],
      previousVersionId: null,
    })
  }

  addDocument(DOCUMENT_ID, REVIEW_TEXTS)

  let rubricIds = 0
  const rubric = createRubricService({
    documents,
    rubrics: createRubricRepository(db),
    suggester: UNAVAILABLE_SUGGESTER,
    now,
    newId: () => `rubric-item-${(rubricIds += 1)}`,
  })
  const confirmed = rubric.confirm(
    DOCUMENT_ID,
    RUBRIC_TITLES.map((title) => ({ itemId: null, title, description: '', importance: 4 })),
  )
  if (!confirmed.ok) throw new Error(confirmed.message)

  const model = createFakeModel()
  // 심층 검토 어댑터도 가짜로 둔다. 깊이를 고르는 길이 실제로 갈라지는지 본다 ([Q-30]).
  const deepModel = createFakeModel('test/fake-deep-model', 'deep-review.test')
  let online = true

  let requestIds = 0
  const review = createReviewService({
    ...(options.approvedGuidelines === undefined ? {} : { approvedGuidelines: options.approvedGuidelines }),
    documents,
    context: createReviewContextService({ repo: createReviewContextRepository(db), now }),
    reviews,
    cache,
    models: { quick: model, deep: deepModel },
    online: { isOnline: () => online },
    now,
    newId: () => `id-${(requestIds += 1)}`,
  })

  let anchorIds = 0
  const staged = createStagedReviewService({
    ...(options.repeatedObservation === undefined ? {} : { repeatedObservation: options.repeatedObservation }),
    ...(options.preserveFeedback === undefined ? {} : { preserveFeedback: options.preserveFeedback }),
    ...(options.userReaction === undefined ? {} : { userReaction: options.userReaction }),
    documents,
    reviews,
    anchors,
    rubric,
    review,
    now,
    newId: () => `anchor-${(anchorIds += 1)}`,
  })

  function latestParagraphs(): { versionId: string; uuids: string[] } {
    const version = documents.latestVersion(DOCUMENT_ID)
    if (version === null) throw new Error('버전이 없습니다')
    return {
      versionId: version.id,
      uuids: documents.listParagraphs(version.id).map((entry) => entry.uuid),
    }
  }

  let versionCount = 1

  return {
    db,
    documents,
    anchors,
    reviews,
    rubric,
    model,
    deepModel,
    staged,
    setOnline: (value) => {
      online = value
    },
    uuidAt(index): string {
      const uuid = latestParagraphs().uuids[index]
      if (uuid === undefined) throw new Error(`문단 ${index} 이 없습니다`)
      return uuid
    },
    saveVersion(texts): void {
      const previous = latestParagraphs()
      versionCount += 1
      documents.appendVersion({
        id: `${DOCUMENT_ID}-v${versionCount}`,
        documentId: DOCUMENT_ID,
        detectedAt: now(),
        sourcePath: `/tmp/${DOCUMENT_ID}.hwpx`,
        byteSize: versionCount,
        contentHash: `${DOCUMENT_ID}-bytes-${versionCount}`,
        paragraphs: makeParagraphs(texts).map((paragraph, position) => ({
          uuid: previous.uuids[position] ?? paragraph.uuid,
          paragraph,
        })),
        lineage: [],
        diffEntries: [],
        previousVersionId: previous.versionId,
      })
    },
    addDocument,
    close: () => db.close(),
  }
}

/** 모델이 보낼 피드백 항목 하나. 기본은 결과 문단(P1)에 다는 논리 관점 질문이다 */
export function feedbackItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paragraph: 'P1',
    perspective: 'logic',
    severity: 3,
    body: '온도와 압력의 관계를 어떤 자료로 확인했나요?',
    rationale: '결과 문단에 근거가 된 측정값이 드러나지 않습니다.',
    rubricItems: [],
    ...overrides,
  }
}

/** 스키마를 지키는 모델 응답 */
export function modelReply(
  items: readonly Record<string, unknown>[] = [feedbackItem()],
  summary = '결과 문단의 근거를 다시 볼 곳이 있습니다.',
): ModelCallResult {
  return { ok: true, text: JSON.stringify({ summary, items }) }
}
