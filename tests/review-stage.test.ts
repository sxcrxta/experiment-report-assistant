/**
 * 단계 진행 제어 (`src/app/review-stage.ts`).
 *
 * 여기서 지키는 불변식
 * - T-1  글이 없는 대상에는 검토 요청 자체가 만들어지지 않는다 (PRD 4.2, `CLAUDE.md` §1)
 * - T-4  단계는 질문 -> 약한 힌트 -> 강한 힌트 -> 설명 -> 예시 순서로만 열리고,
 *        예시는 사용자가 직접 요청해야만 열린다 (PRD 4.2, `CLAUDE.md` §1)
 * - T-23 가리키던 문장을 찾지 못하면 **임의로 다른 문장에 잇지 않고** 사용자 확인을 기다린다
 *
 * 앞부분은 순수 함수만 본다. 뒷부분(`createStagedReviewService`)은 실제 SQLite(메모리)와 가짜 모델을
 * 얹은 하네스로 돌린다 (`tests/helpers/review-harness.ts`). 저장소 스키마 자체는 `tests/reviews.test.ts` 가 맡는다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { OFFLINE_MESSAGE, type ReviewSuccess } from '../src/app/review-request.js'
import {
  EXAMPLE_NOT_REQUESTED_MESSAGE,
  NO_CONTENT_MESSAGE,
  deepestStage,
  nextStage,
  planStage,
  stageIndex,
  targetKeysOf,
  type StagedReviewResult,
} from '../src/app/review-stage.js'
import {
  INITIAL_VISIBLE_CARDS,
  type ReviewPanel,
  type SectionOverride,
  type StagedReviewInput,
} from '../src/shared/feedback.js'
import { REVIEW_PERSPECTIVES, REVIEW_STAGES, type ReviewStage } from '../src/shared/review.js'

import {
  DOCUMENT_ID,
  REVIEW_TEXTS,
  createReviewHarness,
  feedbackItem,
  modelReply,
  type ReviewHarness,
} from './helpers/review-harness.js'

/** 예시를 직접 요청하지 않은 보통의 요청 */
function plan(granted: readonly ReviewStage[], requested: ReviewStage, exampleRequested = false) {
  return planStage({ granted, requested, exampleRequested })
}

describe('단계 순서', () => {
  it('PRD 4.2 의 다섯 단계를 그 순서로 가진다', () => {
    expect([...REVIEW_STAGES]).toEqual([
      'question',
      'weak_hint',
      'strong_hint',
      'explanation',
      'example',
    ])
  })

  it('다음 단계를 알려 주고, 마지막 다음은 없다', () => {
    expect(nextStage(null)).toBe('question')
    expect(nextStage('question')).toBe('weak_hint')
    expect(nextStage('explanation')).toBe('example')
    expect(nextStage('example')).toBeNull()
  })

  it('연 단계 중 가장 깊은 것을 고른다 (요청 순서와 무관하다)', () => {
    expect(deepestStage([])).toBeNull()
    expect(deepestStage(['question'])).toBe('question')
    expect(deepestStage(['strong_hint', 'question', 'weak_hint'])).toBe('strong_hint')
  })

  it('단계 번호가 배열 순서와 같다', () => {
    REVIEW_STAGES.forEach((stage, i) => expect(stageIndex(stage)).toBe(i))
  })
})

describe('단계 잠금 (T-4)', () => {
  it('처음에는 질문만 열린다', () => {
    expect(plan([], 'question')).toEqual({ ok: true })

    for (const stage of ['weak_hint', 'strong_hint', 'explanation'] as const) {
      const result = plan([], stage)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toBe('stage-locked')
      expect(result.ok === false && result.message).toContain('질문 단계부터')
    }
  })

  it('한 단계씩만 열린다. 건너뛸 수 없다', () => {
    // 질문만 연 상태에서 약한 힌트는 되고, 강한 힌트부터는 막힌다
    expect(plan(['question'], 'weak_hint')).toEqual({ ok: true })
    expect(plan(['question'], 'strong_hint').ok).toBe(false)
    expect(plan(['question'], 'explanation').ok).toBe(false)

    // 강한 힌트까지 연 상태에서 설명은 되고, 그 앞 단계도 다시 볼 수 있다
    const granted = ['question', 'weak_hint', 'strong_hint'] as const
    expect(plan(granted, 'explanation')).toEqual({ ok: true })
    expect(plan(granted, 'question')).toEqual({ ok: true })
    expect(plan(granted, 'weak_hint')).toEqual({ ok: true })
  })

  it('막을 때 지금 열 수 있는 단계를 알려 준다', () => {
    const result = plan(['question'], 'explanation')
    expect(result.ok === false && result.message).toContain('약한 힌트')
  })
})

describe('예시는 직접 요청해야만 열린다 (T-4)', () => {
  /** 설명까지 연 상태 = 순서상 예시를 열 수 있는 상태 */
  const upToExplanation = ['question', 'weak_hint', 'strong_hint', 'explanation'] as const

  it('순서가 맞아도 요청하지 않으면 열리지 않는다', () => {
    const result = plan(upToExplanation, 'example')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('example-not-requested')
    expect(result.ok === false && result.message).toBe(EXAMPLE_NOT_REQUESTED_MESSAGE)
  })

  it('직접 요청하면 열린다', () => {
    expect(plan(upToExplanation, 'example', true)).toEqual({ ok: true })
  })

  it('직접 요청해도 순서를 건너뛸 수는 없다', () => {
    // 요청 여부와 상관없이 설명을 열지 않았으면 예시도 열리지 않는다
    const result = plan(['question'], 'example', true)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('stage-locked')
  })

  it('예시를 요청해도 다른 단계에는 영향이 없다', () => {
    // exampleRequested 가 켜졌다고 앞 단계가 건너뛰어지면 안 된다
    expect(plan([], 'strong_hint', true).ok).toBe(false)
    expect(plan([], 'question', true)).toEqual({ ok: true })
  })

  it('예시가 아닌 단계는 요청 여부를 따지지 않는다', () => {
    for (const stage of ['question', 'weak_hint', 'strong_hint', 'explanation'] as const) {
      const granted = REVIEW_STAGES.slice(0, stageIndex(stage))
      expect(plan(granted, stage, false)).toEqual({ ok: true })
      expect(plan(granted, stage, true)).toEqual({ ok: true })
    }
  })
})

describe('대상 키', () => {
  const p1 = 'aaaaaaaa-0000-4000-8000-000000000000'
  const p2 = 'bbbbbbbb-0000-4000-8000-000000000000'

  it('문단 범위는 문단마다 키를 만든다', () => {
    expect(targetKeysOf('paragraph', [p1, p2], null)).toEqual([`paragraph:${p1}`, `paragraph:${p2}`])
  })

  it('문장 범위는 문단과 문장 해시로 잇는다 (문단 안에서 밀려도 같은 대상)', () => {
    expect(targetKeysOf('sentence', [p1], 'hash1')).toEqual([`sentence:${p1}:hash1`])
  })

  it('문장 해시가 없으면 문장 키를 만들지 않는다', () => {
    expect(targetKeysOf('sentence', [p1], null)).toEqual([])
  })

  it('항목 범위는 첫 문단 하나로, 전체 범위는 하나로 잡는다', () => {
    expect(targetKeysOf('section', [p1, p2], null)).toEqual([`section:${p1}`])
    expect(targetKeysOf('document', [p1, p2], null)).toEqual(['document'])
  })

  it('범위마다 키가 겹치지 않는다 (같은 문단이라도 범위가 다르면 다른 대상이다)', () => {
    const keys = [
      targetKeysOf('paragraph', [p1], null),
      targetKeysOf('sentence', [p1], 'hash1'),
      targetKeysOf('section', [p1], null),
      targetKeysOf('document', [p1], null),
    ].flat()
    expect(new Set(keys).size).toBe(keys.length)
  })
})

// ---------------------------------------------------------------------------
// 서비스 — 저장소와 모델을 얹고 돌린다 (createStagedReviewService)
// ---------------------------------------------------------------------------

let h: ReviewHarness

beforeEach(() => {
  h = createReviewHarness()
})

afterEach(() => {
  h.close()
})

/** 결과 문단(4)을 문단 범위로 검토하는 기본 요청 */
function input(overrides: Partial<StagedReviewInput> = {}): StagedReviewInput {
  return {
    documentId: DOCUMENT_ID,
    scope: 'paragraph',
    perspectives: ['logic'],
    stage: 'question',
    paragraphIds: [h.uuidAt(4)],
    ...overrides,
  }
}

/** 방법 문단(1)의 문장 하나를 검토하는 요청 */
function sentenceInput(sentenceIndex: number, stage: ReviewStage = 'question'): StagedReviewInput {
  return {
    documentId: DOCUMENT_ID,
    scope: 'sentence',
    perspectives: ['logic'],
    stage,
    sentence: { paragraphId: h.uuidAt(1), sentenceIndex },
  }
}

/** 모델이 한 번 답하게 두고 요청한다. 성공해야 하는 자리에 쓴다 */
async function succeed(
  request: StagedReviewInput,
  items: readonly Record<string, unknown>[] = [feedbackItem()],
): Promise<ReviewSuccess> {
  h.model.replies.push(modelReply(items))
  const result = await h.staged.requestStagedReview(request)
  if (!result.ok) throw new Error(`성공해야 합니다: ${result.message}`)
  return result
}

/** 모델을 부르기 전에 막혀야 하는 요청 */
async function expectBlocked(request: StagedReviewInput, reason: string): Promise<StagedReviewResult> {
  const before = h.model.calls.length
  const result = await h.staged.requestStagedReview(request)

  expect(result).toMatchObject({ ok: false, reason, requestId: null })
  if (result.ok) throw new Error('막혀야 합니다')
  expect(result.message).not.toBe('')
  // 막힌 요청은 모델을 부르지도, 앵커나 단계 기록을 남기지도 않는다.
  expect(h.model.calls).toHaveLength(before)
  return result
}

async function panel(options?: { includeAll?: boolean }): Promise<ReviewPanel> {
  const result = await h.staged.getPanel(DOCUMENT_ID, options)
  if ('ok' in result) throw new Error(result.message)
  return result
}

/** 질문부터 차례로 열어 마지막 단계까지 올린다 */
async function openThrough(stage: ReviewStage, request: StagedReviewInput): Promise<void> {
  for (const opened of REVIEW_STAGES.slice(0, stageIndex(stage) + 1)) {
    await succeed({ ...request, stage: opened }, [
      opened === 'example'
        ? feedbackItem({ example: '측정값 표를 근거로 들어 보세요.' })
        : feedbackItem(),
    ])
  }
}

// ---------------------------------------------------------------------------
// 선행 작성 확인 (T-1)
// ---------------------------------------------------------------------------

describe('선행 작성 확인 (T-1)', () => {
  it('글이 없는 문단에는 검토 요청을 만들지 않는다', async () => {
    const result = await expectBlocked(input({ paragraphIds: [h.uuidAt(2)] }), 'no-content')

    // 범위를 푸는 이 단계에서 막혔다는 확인. 4단계의 같은 관문까지 가지 않는다.
    expect(result.ok === false && result.message).toBe(NO_CONTENT_MESSAGE)
    expect(h.reviews.listReviews(DOCUMENT_ID)).toEqual([])
    expect(h.anchors.listGrants(DOCUMENT_ID)).toEqual([])
  })

  it('글이 있는 문단과 섞여 있어도 조용히 빼지 않고 이유를 알린다', async () => {
    const result = await expectBlocked(input({ paragraphIds: [h.uuidAt(4), h.uuidAt(2)] }), 'no-content')
    expect(result.ok === false && result.message).toBe(NO_CONTENT_MESSAGE)
  })

  it('빈 문단의 문장은 고를 수 없다', async () => {
    const result = await expectBlocked(
      {
        documentId: DOCUMENT_ID,
        scope: 'sentence',
        perspectives: ['logic'],
        stage: 'question',
        sentence: { paragraphId: h.uuidAt(2), sentenceIndex: 0 },
      },
      'no-content',
    )
    expect(result.ok === false && result.message).toBe(NO_CONTENT_MESSAGE)
    expect(h.anchors.listAnchors(DOCUMENT_ID)).toEqual([])
  })

  it('보고서 항목 범위는 항목 안의 빈 문단만 빼고 요청한다', async () => {
    // 1번 항목을 문단 0~2 로 둔다. 그중 2 는 빈 문단이다.
    h.staged.saveSections(DOCUMENT_ID, [
      { ordinal: 1, title: '방법', startParagraphUuid: h.uuidAt(0), endParagraphUuid: h.uuidAt(2) },
      { ordinal: 2, title: '결과', startParagraphUuid: h.uuidAt(3), endParagraphUuid: h.uuidAt(5) },
    ])
    await succeed(input({ scope: 'section', sectionOrdinal: 1 }))

    expect(h.model.calls[0]?.targets.map((target) => target.paragraphId)).toEqual([
      h.uuidAt(0),
      h.uuidAt(1),
    ])
  })

  it('전체 범위라도 글이 하나도 없으면 요청하지 않는다', async () => {
    h.saveVersion(REVIEW_TEXTS.map(() => ''))

    const result = await expectBlocked(input({ scope: 'document' }), 'no-content')
    expect(result.ok === false && result.message).toBe(NO_CONTENT_MESSAGE)
  })

  it('없는 문단·문장·항목을 고르면 요청하지 않는다', async () => {
    await expectBlocked(input({ paragraphIds: ['없는-문단'] }), 'unknown-target')
    await expectBlocked(
      {
        documentId: DOCUMENT_ID,
        scope: 'sentence',
        perspectives: ['logic'],
        stage: 'question',
        sentence: { paragraphId: h.uuidAt(4), sentenceIndex: 9 },
      },
      'unknown-target',
    )
    await expectBlocked(input({ scope: 'section', sectionOrdinal: 99 }), 'unknown-target')
    await expectBlocked(input({ paragraphIds: [] }), 'invalid-request')
  })

  it('등록되지 않은 문서에는 요청도 화면도 만들지 않는다', async () => {
    await expectBlocked(input({ documentId: '없는-문서' }), 'unknown-document')
    expect(await h.staged.getPanel('없는-문서')).toMatchObject({ ok: false, reason: 'unknown-document' })
  })
})

// ---------------------------------------------------------------------------
// 단계 순서 강제 — 서비스 경로 (T-4)
// ---------------------------------------------------------------------------

describe('단계 순서 강제 (T-4)', () => {
  it('질문을 열기 전에는 다음 단계를 요청할 수 없다', async () => {
    await expectBlocked(input({ stage: 'weak_hint' }), 'stage-locked')
    expect(h.reviews.listReviews(DOCUMENT_ID)).toEqual([])
  })

  it('한 단계를 열면 다음 단계가 열리고, 연 단계가 기록된다', async () => {
    await succeed(input())
    await expectBlocked(input({ stage: 'strong_hint' }), 'stage-locked')
    await succeed(input({ stage: 'weak_hint' }))

    expect(h.anchors.listGrants(DOCUMENT_ID).map((grant) => [grant.targetKey, grant.stage])).toEqual([
      [`paragraph:${h.uuidAt(4)}`, 'question'],
      [`paragraph:${h.uuidAt(4)}`, 'weak_hint'],
    ])
  })

  it('대상이 다르면 단계도 따로 센다', async () => {
    await succeed(input())
    // 문단 4 의 질문을 열었다고 문단 5 의 약한 힌트가 열리지는 않는다.
    await expectBlocked(input({ paragraphIds: [h.uuidAt(5)], stage: 'weak_hint' }), 'stage-locked')
  })

  it('여러 문단을 함께 고르면 가장 덜 열린 문단에 맞춘다', async () => {
    await succeed(input())

    await expectBlocked(input({ paragraphIds: [h.uuidAt(4), h.uuidAt(5)], stage: 'weak_hint' }), 'stage-locked')
  })

  it('예시는 순서가 맞아도 직접 요청해야만 열린다', async () => {
    await openThrough('explanation', input())

    const result = await expectBlocked(input({ stage: 'example' }), 'example-not-requested')
    expect(result.ok === false && result.message).toBe(EXAMPLE_NOT_REQUESTED_MESSAGE)
    expect(h.anchors.listGrants(DOCUMENT_ID).some((grant) => grant.stage === 'example')).toBe(false)
  })

  it('직접 요청하면 예시가 열리고, 그때만 카드에 예시가 담긴다', async () => {
    await openThrough('explanation', input())

    await succeed(input({ stage: 'example', exampleRequested: true }), [
      feedbackItem({ example: '측정값 표를 근거로 들어 보세요.' }),
    ])

    const cards = (await panel({ includeAll: true })).cards
    expect(cards.filter((card) => card.example !== null).map((card) => [card.stage, card.example])).toEqual([
      ['example', '측정값 표를 근거로 들어 보세요.'],
    ])
    expect(cards.filter((card) => card.stage !== 'example').every((card) => card.example === null)).toBe(true)
  })

  it('예시를 요청하지 않은 경로에서는 카드에 예시가 없다', async () => {
    // 모델이 예시를 끼워 보내도 질문 단계의 카드에는 남지 않는다 (그 항목만 버려진다).
    await succeed(input(), [feedbackItem(), feedbackItem({ example: '모델이 덧붙인 예시' })])

    const cards = (await panel({ includeAll: true })).cards
    expect(cards.every((card) => card.example === null)).toBe(true)
    expect(JSON.stringify(cards)).not.toContain('모델이 덧붙인 예시')
  })
})

// ---------------------------------------------------------------------------
// 문장 앵커 (T-23)
// ---------------------------------------------------------------------------

describe('문장 앵커', () => {
  const FIRST = '주사기에 공기를 넣고 온도를 바꾸었다.'
  const SECOND = '압력계를 함께 읽었다.'

  it('문장 범위 요청은 앵커를 만들고 피드백을 그 앵커에 잇는다', async () => {
    const result = await succeed(sentenceInput(0))

    const [anchor] = h.anchors.listAnchors(DOCUMENT_ID)
    expect(anchor).toMatchObject({
      paragraphUuid: h.uuidAt(1),
      sentenceIndex: 0,
      text: FIRST,
      status: 'linked',
    })
    const stored = h.reviews.getReview(result.requestId)
    expect(stored?.status === 'succeeded' && stored.items.map((item) => item.sentenceAnchorId)).toEqual([
      anchor?.anchorId,
    ])
    // 단계 기록은 문단이 아니라 문장 대상에 남는다.
    expect(h.anchors.listGrants(DOCUMENT_ID).map((grant) => grant.targetKey)).toEqual([
      `sentence:${h.uuidAt(1)}:${anchor?.hash}`,
    ])
  })

  it('요청이 실패하면 앵커를 남기지 않는다', async () => {
    h.model.replies.push({ ok: false, reason: 'rate-limited', message: '요청 한도를 넘었습니다.' })

    const result = await h.staged.requestStagedReview(sentenceInput(0))

    expect(result).toMatchObject({ ok: false, reason: 'model-failed' })
    expect(h.anchors.listAnchors(DOCUMENT_ID)).toEqual([])
    expect(h.anchors.listGrants(DOCUMENT_ID)).toEqual([])
    expect(h.reviews.listReviews(DOCUMENT_ID).map((review) => review.status)).toEqual(['failed'])
  })

  it('단계가 잠겨 있으면 앵커를 만들지도 않는다', async () => {
    await expectBlocked(sentenceInput(0, 'weak_hint'), 'stage-locked')
    expect(h.anchors.listAnchors(DOCUMENT_ID)).toEqual([])
  })

  it('문단 안에서 문장이 밀려도 같은 문장에 이어진다', async () => {
    await succeed(sentenceInput(0))
    h.saveVersion(REVIEW_TEXTS.map((text, i) => (i === 1 ? `${SECOND} ${FIRST}` : text)))

    const card = (await panel()).cards[0]
    expect(card?.anchor).toMatchObject({ status: 'linked', sentenceIndex: 1, text: FIRST, needsConfirmation: false })
    expect(card?.anchor?.message).toContain('위치가 바뀐')
    // 다시 찾은 자리를 저장해 둔다.
    expect(h.anchors.listAnchors(DOCUMENT_ID)[0]).toMatchObject({ sentenceIndex: 1, status: 'linked' })
  })

  it('문장을 찾지 못하면 비슷한 문장에 잇지 않고 확인을 요청한다 (T-23)', async () => {
    await succeed(sentenceInput(0))
    // 가리키던 문장만 고쳤다. 아주 비슷한 문장이 같은 자리에 있어도 같은 문장이 아니다.
    h.saveVersion(
      REVIEW_TEXTS.map((text, i) => (i === 1 ? `주사기에 물을 넣고 온도를 바꾸었다. ${SECOND}` : text)),
    )

    const card = (await panel()).cards[0]
    expect(card?.anchor).toMatchObject({
      status: 'unresolved',
      sentenceIndex: null,
      text: FIRST,
      needsConfirmation: true,
    })
    expect(card?.anchor?.message).toContain('찾지 못했습니다')
    // 고를 수 있는 문장은 보여 주되, 프로그램이 고르지는 않는다.
    expect(card?.anchor?.candidates.map((sentence) => sentence.text)).toEqual([
      '주사기에 물을 넣고 온도를 바꾸었다.',
      SECOND,
    ])
    expect(h.anchors.listAnchors(DOCUMENT_ID)[0]?.status).toBe('unresolved')
  })

  it('문단이 통째로 사라져도 다른 문단에 잇지 않는다', async () => {
    await succeed(sentenceInput(0))
    h.saveVersion(['남은 문단은 하나뿐이다.'])

    const anchorId = h.anchors.listAnchors(DOCUMENT_ID)[0]?.anchorId ?? ''
    const card = (await panel()).cards[0]
    expect(card?.anchor).toMatchObject({ status: 'unresolved', needsConfirmation: true, candidates: [] })

    // 문단이 없으니 다시 잇는 길도 없다. 임의로 다른 문단에 붙이지 않는다.
    expect(h.staged.decideAnchor(anchorId, { choice: 'relink', sentenceIndex: 0 })).toMatchObject({
      ok: false,
      reason: 'unknown-target',
    })
  })

  it('사용자가 고른 문장에만 다시 잇는다', async () => {
    await succeed(sentenceInput(0))
    h.saveVersion(
      REVIEW_TEXTS.map((text, i) => (i === 1 ? `주사기에 물을 넣고 온도를 바꾸었다. ${SECOND}` : text)),
    )
    await panel()

    const anchorId = h.anchors.listAnchors(DOCUMENT_ID)[0]?.anchorId ?? ''
    const decided = h.staged.decideAnchor(anchorId, { choice: 'relink', sentenceIndex: 1 })

    expect(decided).toMatchObject({
      ok: true,
      anchor: { status: 'linked', sentenceIndex: 1, text: SECOND, needsConfirmation: false },
    })
    expect((await panel()).cards[0]?.anchor).toMatchObject({ status: 'linked', text: SECOND })
  })

  it('없는 문장 번호로는 다시 잇지 않는다', async () => {
    await succeed(sentenceInput(0))
    const anchorId = h.anchors.listAnchors(DOCUMENT_ID)[0]?.anchorId ?? ''

    expect(h.staged.decideAnchor(anchorId, { choice: 'relink', sentenceIndex: 9 })).toMatchObject({
      ok: false,
      reason: 'unknown-target',
    })
    expect(h.anchors.listAnchors(DOCUMENT_ID)[0]?.status).toBe('linked')
  })

  it('찾지 못한 채로 두겠다는 확인을 기억한다', async () => {
    await succeed(sentenceInput(0))
    h.saveVersion(REVIEW_TEXTS.map((text, i) => (i === 1 ? '문장을 통째로 새로 썼다.' : text)))
    await panel()

    const anchorId = h.anchors.listAnchors(DOCUMENT_ID)[0]?.anchorId ?? ''
    const decided = h.staged.decideAnchor(anchorId, { choice: 'keep-lost' })

    expect(decided).toMatchObject({
      ok: true,
      anchor: { status: 'confirmed-lost', needsConfirmation: false },
    })
    // 화면을 다시 그려도 확인 요청으로 되돌아가지 않는다.
    expect((await panel()).cards[0]?.anchor).toMatchObject({
      status: 'confirmed-lost',
      needsConfirmation: false,
    })
  })

  it('없는 앵커에는 확인을 적용하지 않는다', () => {
    expect(h.staged.decideAnchor('없는-앵커', { choice: 'keep-lost' })).toMatchObject({
      ok: false,
      reason: 'unknown-target',
    })
  })
})

// ---------------------------------------------------------------------------
// 보고서 항목 경계
// ---------------------------------------------------------------------------

describe('보고서 항목 경계', () => {
  function userSections(): SectionOverride[] {
    return [
      { ordinal: 1, title: '방법', startParagraphUuid: h.uuidAt(0), endParagraphUuid: h.uuidAt(1) },
      { ordinal: 2, title: '결과와 해석', startParagraphUuid: h.uuidAt(2), endParagraphUuid: h.uuidAt(5) },
    ]
  }

  it('제목 스타일이 없으면 평가 지침에 기대지 않고 문서 전체를 한 항목으로 둔다 ([Q-48])', async () => {
    const sections = (await panel()).sections
    expect(sections.map((section) => [section.title, section.source])).toEqual([['전체 문서', 'fallback']])
  })

  it('사용자가 고친 경계가 추정을 이긴다', async () => {
    const saved = h.staged.saveSections(DOCUMENT_ID, userSections())

    expect(saved).toMatchObject({ ok: true })
    const after = await panel()
    expect(after.sections.map((section) => [section.title, section.startIndex, section.endIndex, section.source])).toEqual(
      [
        ['방법', 0, 1, 'user'],
        ['결과와 해석', 2, 5, 'user'],
      ],
    )
    expect(after.sectionNotice).toBe('')
  })

  it('문서가 바뀌어 고친 경계를 쓸 수 없으면 추정으로 되돌리고 알린다', async () => {
    h.staged.saveSections(DOCUMENT_ID, userSections())
    h.saveVersion(['남은 문단은 하나뿐이다.'])

    const after = await panel()
    expect(after.sections.map((section) => [section.title, section.source])).toEqual([['전체 문서', 'fallback']])
    expect(after.sectionNotice).toContain('다시 추정한 경계')
    // 사용자가 고친 기록 자체를 지우지는 않는다. 다시 고칠 때까지 그대로 둔다.
    expect(h.anchors.listSections(DOCUMENT_ID)).toHaveLength(2)
  })

  it('말이 되지 않는 경계는 저장하지 않고 이유를 알린다', async () => {
    h.staged.saveSections(DOCUMENT_ID, userSections())

    const overlapping: SectionOverride[] = [
      { ordinal: 1, title: '방법', startParagraphUuid: h.uuidAt(0), endParagraphUuid: h.uuidAt(3) },
      { ordinal: 2, title: '결과', startParagraphUuid: h.uuidAt(2), endParagraphUuid: h.uuidAt(5) },
    ]
    const result = h.staged.saveSections(DOCUMENT_ID, overlapping)

    expect(result).toMatchObject({ ok: false, reason: 'invalid-request' })
    expect(result.ok === false && result.message).toContain('겹칩니다')
    // 앞서 저장한 경계가 그대로 남는다.
    expect((await panel()).sections.map((section) => section.title)).toEqual(['방법', '결과와 해석'])
  })

  it('빈 목록은 사용자 수정을 지우고 추정으로 되돌린다', async () => {
    h.staged.saveSections(DOCUMENT_ID, userSections())

    const result = h.staged.saveSections(DOCUMENT_ID, [])

    expect(result.ok && result.sections.map((section) => section.title)).toEqual(['전체 문서'])
    expect(h.anchors.listSections(DOCUMENT_ID)).toEqual([])
    expect((await panel()).sectionNotice).toBe('')
  })

  it('등록되지 않은 문서에는 경계를 저장하지 않는다', () => {
    expect(h.staged.saveSections('없는-문서', [])).toMatchObject({ ok: false, reason: 'unknown-document' })
  })
})

// ---------------------------------------------------------------------------
// 검토 화면 (getPanel)
// ---------------------------------------------------------------------------

describe('검토 화면', () => {
  it('사용 가능 여부를 기다리는 동안 저장한 버전도 최신 문단으로 보여 준다', async () => {
    let resume!: () => void
    const pending = new Promise<void>((resolve) => { resume = resolve })
    h.model.checkAvailability = async () => {
      await pending
      return { available: true }
    }
    const result = panel()
    h.saveVersion(['방금 저장한 문단'])
    resume()
    expect(await result).toMatchObject({ versionOrdinal: 2,
      paragraphs: [{ text: '방금 저장한 문단' }] })
  })
  it('캐시를 반복 조회해도 같은 카드가 목록에 중복되지 않는다', async () => {
    const first = await succeed(input())
    const second = await h.staged.requestStagedReview(input())
    expect(second).toMatchObject({ ok: true, attempts: 0 })
    const cards = (await panel({ includeAll: true })).cards
    expect(cards).toHaveLength(1)
    expect(cards[0]?.body).toBe(first.response.items[0]?.body)
  })

  it('같은 요청의 카드 순서가 반복 취약점 점수로 둔갑하지 않는다', async () => {
    await succeed(input(), [feedbackItem({ severity: 5 }),
      ...Array.from({ length: 8 }, (_, index) => feedbackItem({ severity: 1, body: `낮은 심각도 ${index}` }))])
    expect((await panel()).cards[0]?.severity).toBe(5)
  })

  it('평가 지침 연결은 순위에 쓰지 않는다 — 심각도가 높은 쪽이 앞선다 ([Q-48])', async () => {
    await succeed(input(), [feedbackItem({ severity: 4, rubricItems: ['R1'], body: '지침을 가리킨 피드백' }),
      feedbackItem({ severity: 5, rubricItems: [], body: '더 심각한 피드백' })])
    const cards = (await panel()).cards
    expect(cards[0]?.body).toBe('더 심각한 피드백')
    expect(cards.every((card) => card.appliedRubric.length === 0)).toBe(true)
  })
  it('상위 5개만 먼저 보여 주고 나머지는 요청할 때 준다', async () => {
    const many = Array.from({ length: INITIAL_VISIBLE_CARDS + 2 }, (_, i) =>
      feedbackItem({ severity: (i % 5) + 1 }),
    )
    await succeed(input(), many)

    const first = await panel()
    expect(first.cards).toHaveLength(INITIAL_VISIBLE_CARDS)
    expect(first.hiddenCount).toBe(2)
    // 순위는 프로그램이 정한다. 심각도는 지침 중요도·반복 관찰·관점 일치와 함께 쓰는 입력값일 뿐이다.
    expect(new Set(first.cards.map((card) => card.itemId)).size).toBe(INITIAL_VISIBLE_CARDS)

    const all = await panel({ includeAll: true })
    expect(all.cards).toHaveLength(INITIAL_VISIBLE_CARDS + 2)
    expect(all.hiddenCount).toBe(0)
  })

  it('피드백을 받은 뒤 문단을 고치면 수정 전후가 함께 보인다', async () => {
    await succeed(input())
    h.saveVersion(REVIEW_TEXTS.map((text, i) => (i === 4 ? '온도가 올라가면 압력도 비례해 증가했다.' : text)))

    expect((await panel()).cards[0]?.revision).toEqual({
      before: REVIEW_TEXTS[4],
      after: '온도가 올라가면 압력도 비례해 증가했다.',
    })
  })

  it('다음에 열 수 있는 단계를 카드가 알려 주고, 예시는 요청이 필요하다고 표시한다', async () => {
    await openThrough('explanation', input())

    const card = (await panel()).cards[0]
    expect(card?.nextStage).toBe('example')
    expect(card?.nextStageNeedsRequest).toBe(true)
    expect(card?.grantedStages).toEqual(['question', 'weak_hint', 'strong_hint', 'explanation'])
  })

  it('관점을 싣지 않은 요청은 평가 지침과 상관없이 모든 관점으로 본다 ([Q-48])', async () => {
    const { perspectives: _omitted, ...withoutPerspectives } = input()
    void _omitted
    await succeed(withoutPerspectives, [feedbackItem({ perspective: 'structure' })])
    expect(h.model.calls.at(-1)?.perspectives).toEqual([...REVIEW_PERSPECTIVES])
    expect((await panel()).recommended.perspectives).toEqual([...REVIEW_PERSPECTIVES])
  })

  it('오프라인이면 요청 바만 잠그고 저장된 기록과 경계 편집은 그대로 둔다', async () => {
    await succeed(input())
    h.setOnline(false)

    const offline = await panel()
    expect(offline.requestAvailable).toBe(false)
    expect(offline.unavailableMessage).toBe(OFFLINE_MESSAGE)
    // 오프라인은 지침 확정으로 풀리지 않는다.
    expect(offline.readyExceptRubric).toBe(false)
    expect(offline.cards).toHaveLength(1)
    expect(offline.sections).toHaveLength(1)
    expect(h.staged.saveSections(DOCUMENT_ID, [])).toMatchObject({ ok: true })
  })

  it('평가 지침을 확정하지 않아도 검토를 요청할 수 있다 ([Q-48])', async () => {
    h.addDocument('doc-2', ['온도가 올라가면 압력이 증가했다.'])

    const result = await h.staged.getPanel('doc-2')
    if ('ok' in result) throw new Error(result.message)

    expect(result.requestAvailable).toBe(true)
    expect(result.unavailableMessage).toBe('')
    expect(result.readyExceptRubric).toBe(false)
    // 문단 고르기는 그대로 쓸 수 있다.
    expect(result.paragraphs.map((paragraph) => paragraph.hasContent)).toEqual([true])
  })

  it('글이 없는 문단은 화면에서도 표시가 된다', async () => {
    const shown = await panel()

    expect(shown.paragraphs.map((paragraph) => paragraph.hasContent)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
    ])
    expect(shown.paragraphs[1]?.sentences.map((sentence) => sentence.index)).toEqual([0, 1])
    expect(shown.versionOrdinal).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 피드백 삭제 (사용자 결정 2026-09-27)
// ---------------------------------------------------------------------------

describe('피드백 삭제', () => {
  function count(table: string): number {
    return (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  }

  it('지운 피드백은 목록에서 사라지고 다른 피드백은 남는다', async () => {
    await succeed(input(), [feedbackItem({ body: '남길 피드백' }), feedbackItem({ body: '지울 피드백' })])
    const target = (await panel()).cards.find((card) => card.body === '지울 피드백')!
    expect(h.staged.deleteFeedback(DOCUMENT_ID, target.itemId)).toEqual({ ok: true, deletedCount: 1 })
    expect((await panel()).cards.map((card) => card.body)).toEqual(['남길 피드백'])
  })

  it('캐시 재사용으로 가려진 같은 내용의 복제본도 함께 지워 다시 나타나지 않는다', async () => {
    await succeed(input())
    await h.staged.requestStagedReview(input())
    expect(count('feedback_item')).toBe(2)
    const [card] = (await panel({ includeAll: true })).cards
    expect(h.staged.deleteFeedback(DOCUMENT_ID, card!.itemId)).toEqual({ ok: true, deletedCount: 2 })
    expect((await panel({ includeAll: true })).cards).toEqual([])
  })

  it('지워도 이미 연 단계는 그대로다 (단계 순서 기록은 지우지 않는다)', async () => {
    await succeed(input())
    const [card] = (await panel()).cards
    h.staged.deleteFeedback(DOCUMENT_ID, card!.itemId)
    await succeed(input({ stage: 'weak_hint' }))
  })

  it('없는 피드백은 지우지 않고 알린다', () => {
    expect(h.staged.deleteFeedback(DOCUMENT_ID, '없는-피드백')).toMatchObject({ ok: false, reason: 'unknown-target' })
  })
})

describe('검토 기록이 있는 보고서 삭제', () => {
  it('피드백·문장 앵커·지침 버전이 있어도 한 번에 모두 지워진다', async () => {
    await succeed(input())
    await succeed(sentenceInput(0), [feedbackItem({ paragraphId: h.uuidAt(1), sentenceRef: 0 })])
    const { createDocumentRepository } = await import('../src/adapters/repo/documents.js')
    createDocumentRepository(h.db).deleteDocument(DOCUMENT_ID)
    for (const table of ['document', 'document_version', 'review_request', 'feedback_item',
      'sentence_anchor', 'rubric_version', 'review_stage_grant']) {
      expect(count(table), table).toBe(0)
    }
  })

  function count(table: string): number {
    return (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  }
})
