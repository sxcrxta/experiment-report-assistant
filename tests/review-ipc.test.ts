/**
 * 5단계 — 선택적 피드백의 메인 프로세스 경계 (`src/main/review-ipc.ts`).
 *
 * 렌더러가 보낸 값은 믿지 않는다. 여기서 확인하는 것은 두 가지다.
 * - 형태가 틀린 값은 유스케이스까지 가지 않는다 (모델도 불리지 않는다).
 * - **예시 게이트가 경계에서도 새지 않는다.** `exampleRequested` 가 정확히 `true` 가 아니면
 *   무슨 값을 보내도 false 로 읽히고, 예시 단계는 열리지 않는다 (PRD 4.2, `CLAUDE.md` §1).
 *
 * 가짜 유스케이스를 끼우지 않고 실제 서비스(메모리 SQLite + 가짜 모델)를 얹는다.
 * 경계만 통과하고 정작 안에서 막히지 않는 경우를 잡기 위해서다.
 *
 * T-1  글이 없는 대상에는 요청이 만들어지지 않는다
 * T-4  단계 순서와 예시 게이트를 프로그램이 강제한다
 * T-23 문장을 찾지 못하면 사용자 확인 상태로 둔다
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EXAMPLE_NOT_REQUESTED_MESSAGE } from '../src/app/review-stage.js'
import {
  createReviewHandlers,
  parseAnchorDecisionInput,
  parseSectionOverridesInput,
  parseStagedReviewInput,
  type ReviewHandlers,
} from '../src/main/review-ipc.js'
import { INITIAL_VISIBLE_CARDS } from '../src/shared/feedback.js'
import { REVIEW_STAGES } from '../src/shared/review.js'

import {
  DOCUMENT_ID,
  REVIEW_TEXTS,
  createReviewHarness,
  feedbackItem,
  modelReply,
  type ReviewHarness,
} from './helpers/review-harness.js'

// ---------------------------------------------------------------------------
// 형태 확인 (순수 함수)
// ---------------------------------------------------------------------------

/** 형태가 맞는 최소 요청 */
function rawInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentId: 'doc-1',
    scope: 'paragraph',
    perspectives: ['logic'],
    stage: 'question',
    ...overrides,
  }
}

describe('parseStagedReviewInput', () => {
  it('형태가 맞는 요청을 읽고, 예시 요청은 기본이 false 다', () => {
    expect(parseStagedReviewInput(rawInput())).toEqual({
      documentId: 'doc-1',
      scope: 'paragraph',
      perspectives: ['logic'],
      stage: 'question',
      exampleRequested: false,
    })
  })

  it('깊이는 아는 값일 때만 읽고, 모르면 빠른 검토로 둔다 ([Q-30])', () => {
    expect(parseStagedReviewInput(rawInput({ depth: 'deep' }))?.depth).toBe('deep')
    expect(parseStagedReviewInput(rawInput({ depth: 'quick' }))?.depth).toBe('quick')
    // 렌더러가 모르는 값을 보내면 깊이를 싣지 않는다. 기본은 빠른 검토다.
    for (const value of ['DEEP', 'claude', 1, {}, null, true]) {
      expect(parseStagedReviewInput(rawInput({ depth: value }))?.depth).toBeUndefined()
    }
  })

  it('exampleRequested 는 정확히 true 일 때만 true 다', () => {
    expect(parseStagedReviewInput(rawInput({ exampleRequested: true }))?.exampleRequested).toBe(true)
    // 렌더러가 무엇을 보내든 true 가 아니면 false 다. 여기서 예시가 새면 안 된다.
    for (const value of ['true', 1, {}, [], 'yes', null]) {
      expect(parseStagedReviewInput(rawInput({ exampleRequested: value }))?.exampleRequested).toBe(false)
    }
  })

  it('스키마에 없는 값은 옮기지 않는다', () => {
    const parsed = parseStagedReviewInput(rawInput({ example: '렌더러가 끼워 넣은 예시', stage: 'question' }))
    expect(parsed).not.toBeNull()
    expect(JSON.stringify(parsed)).not.toContain('렌더러가 끼워 넣은 예시')
  })

  it('레코드가 아니면 읽지 않는다', () => {
    for (const value of [null, undefined, 'doc-1', 3, [rawInput()]]) {
      expect(parseStagedReviewInput(value)).toBeNull()
    }
  })

  it('관점이 없는 요청도 읽는다. 관점은 메인 프로세스가 지침으로 정한다 ([Q-41])', () => {
    const { perspectives: _dropped, ...rest } = rawInput({})
    void _dropped
    const parsed = parseStagedReviewInput(rest)
    expect(parsed).not.toBeNull()
    expect(parsed !== null && 'perspectives' in parsed).toBe(false)
  })

  it('문서·범위·단계·관점이 아는 값이 아니면 읽지 않는다', () => {
    expect(parseStagedReviewInput(rawInput({ documentId: '' }))).toBeNull()
    expect(parseStagedReviewInput(rawInput({ documentId: 3 }))).toBeNull()
    expect(parseStagedReviewInput(rawInput({ scope: 'chapter' }))).toBeNull()
    expect(parseStagedReviewInput(rawInput({ stage: 'final' }))).toBeNull()
    expect(parseStagedReviewInput(rawInput({ perspectives: 'logic' }))).toBeNull()
    expect(parseStagedReviewInput(rawInput({ perspectives: ['logic', 'vibes'] }))).toBeNull()
  })

  it('아는 범위와 단계는 모두 통과한다', () => {
    for (const stage of REVIEW_STAGES) {
      expect(parseStagedReviewInput(rawInput({ stage }))?.stage).toBe(stage)
    }
  })

  it('문단 목록은 문자열 목록일 때만 읽는다', () => {
    expect(parseStagedReviewInput(rawInput({ paragraphIds: ['p1', 'p2'] }))?.paragraphIds).toEqual(['p1', 'p2'])
    expect(parseStagedReviewInput(rawInput({ paragraphIds: [] }))?.paragraphIds).toEqual([])
    expect(parseStagedReviewInput(rawInput({ paragraphIds: 'p1' }))).toBeNull()
    expect(parseStagedReviewInput(rawInput({ paragraphIds: ['p1', ''] }))).toBeNull()
    expect(parseStagedReviewInput(rawInput({ paragraphIds: ['p1', 7] }))).toBeNull()
  })

  it('항목 순번은 정수일 때만 읽는다', () => {
    expect(parseStagedReviewInput(rawInput({ sectionOrdinal: 2 }))?.sectionOrdinal).toBe(2)
    expect(parseStagedReviewInput(rawInput({ sectionOrdinal: 1.5 }))).toBeNull()
    expect(parseStagedReviewInput(rawInput({ sectionOrdinal: '2' }))).toBeNull()
  })

  it('문장은 문단 id 와 0 이상의 정수 번호가 함께 올 때만 읽는다', () => {
    expect(parseStagedReviewInput(rawInput({ sentence: { paragraphId: 'p1', sentenceIndex: 0 } }))?.sentence).toEqual(
      { paragraphId: 'p1', sentenceIndex: 0 },
    )
    for (const sentence of [
      { paragraphId: '', sentenceIndex: 0 },
      { paragraphId: 'p1', sentenceIndex: -1 },
      { paragraphId: 'p1', sentenceIndex: 1.5 },
      { paragraphId: 'p1' },
      'p1',
      [],
    ]) {
      expect(parseStagedReviewInput(rawInput({ sentence }))).toBeNull()
    }
  })
})

describe('parseSectionOverridesInput', () => {
  const override = { ordinal: 1, title: '결과', startParagraphUuid: 'p1', endParagraphUuid: 'p2' }

  it('형태가 맞는 목록을 읽는다. 빈 목록은 "추정으로 되돌리기" 다', () => {
    expect(parseSectionOverridesInput([override])).toEqual([override])
    expect(parseSectionOverridesInput([])).toEqual([])
  })

  it('목록이 아니거나 항목의 형태가 틀리면 읽지 않는다', () => {
    expect(parseSectionOverridesInput(override)).toBeNull()
    expect(parseSectionOverridesInput(null)).toBeNull()
    for (const broken of [
      { ...override, ordinal: '1' },
      { ...override, ordinal: 1.5 },
      { ...override, title: 3 },
      { ...override, startParagraphUuid: '' },
      { ...override, endParagraphUuid: null },
      'p1',
    ]) {
      expect(parseSectionOverridesInput([broken])).toBeNull()
    }
  })
})

describe('parseAnchorDecisionInput', () => {
  it('두 가지 결정만 읽는다', () => {
    expect(parseAnchorDecisionInput({ choice: 'keep-lost' })).toEqual({ choice: 'keep-lost' })
    expect(parseAnchorDecisionInput({ choice: 'relink', sentenceIndex: 2 })).toEqual({
      choice: 'relink',
      sentenceIndex: 2,
    })
  })

  it('문장을 고르지 않은 다시 잇기는 읽지 않는다 (프로그램이 대신 고르지 않는다)', () => {
    expect(parseAnchorDecisionInput({ choice: 'relink' })).toBeNull()
    expect(parseAnchorDecisionInput({ choice: 'relink', sentenceIndex: -1 })).toBeNull()
    expect(parseAnchorDecisionInput({ choice: 'relink', sentenceIndex: '2' })).toBeNull()
  })

  it('모르는 결정과 레코드가 아닌 값은 읽지 않는다', () => {
    expect(parseAnchorDecisionInput({ choice: 'guess' })).toBeNull()
    expect(parseAnchorDecisionInput({})).toBeNull()
    expect(parseAnchorDecisionInput(null)).toBeNull()
    expect(parseAnchorDecisionInput('keep-lost')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 핸들러 — 실제 유스케이스를 얹고 본다
// ---------------------------------------------------------------------------

let h: ReviewHarness
let handlers: ReviewHandlers

beforeEach(() => {
  h = createReviewHarness()
  handlers = createReviewHandlers({ staged: h.staged })
})

afterEach(() => {
  h.close()
})

function paragraphRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentId: DOCUMENT_ID,
    scope: 'paragraph',
    perspectives: ['logic'],
    stage: 'question',
    paragraphIds: [h.uuidAt(4)],
    ...overrides,
  }
}

/** 모델이 한 번 답하게 두고 핸들러로 요청한다 */
async function review(
  request: Record<string, unknown>,
  items: readonly Record<string, unknown>[] = [feedbackItem()],
): Promise<void> {
  h.model.replies.push(modelReply(items))
  const result = await handlers.requestStagedReview(request)
  if (result.status !== 'reviewed') throw new Error(`성공해야 합니다: ${result.message}`)
}

/** 질문부터 차례로 열어 설명까지 올린다 (예시 바로 앞) */
async function openThroughExplanation(): Promise<void> {
  for (const stage of REVIEW_STAGES.slice(0, REVIEW_STAGES.indexOf('example'))) {
    await review(paragraphRequest({ stage }))
  }
}

describe('심층 재검토 경계 (PRD 4.3·4.4)', () => {
  it('문서나 피드백을 알 수 없으면 유스케이스까지 가지 않는다', async () => {
    for (const bad of [3, '', null, undefined]) {
      expect(await handlers.requestReReview(bad, 'item-1')).toMatchObject({ status: 'failed' })
      expect(await handlers.requestReReview(DOCUMENT_ID, bad)).toMatchObject({ status: 'failed' })
    }
    expect(h.deepModel.calls).toHaveLength(0)
  })

  it('성공하면 저장된 기록으로 다시 그린 화면을 돌려준다', async () => {
    await review(paragraphRequest())
    const panel = await handlers.getReviewPanel(DOCUMENT_ID, false)
    if (panel.status !== 'ok') throw new Error(panel.message)
    const feedbackId = panel.panel.cards[0]!.itemId

    h.deepModel.replies.push(modelReply())
    const result = await handlers.requestReReview(DOCUMENT_ID, feedbackId)

    if (result.status !== 'reviewed') throw new Error(result.message)
    // 화면은 모델 응답을 직접 받지 않는다. 저장된 기록에서 다시 그린 것이다.
    expect(result.panel.documentId).toBe(DOCUMENT_ID)
    expect(result.itemCount).toBeGreaterThan(0)
  })
})

describe('검토 화면 가져오기', () => {
  it('문서를 알 수 없으면 화면을 만들지 않는다', async () => {
    expect(await handlers.getReviewPanel(3, false)).toEqual({
      status: 'failed',
      message: '검토할 문서를 알 수 없습니다.',
    })
    expect(await handlers.getReviewPanel('없는-문서', false)).toMatchObject({ status: 'failed' })
  })

  it('includeAll 은 정확히 true 일 때만 전부 준다', async () => {
    await review(paragraphRequest(), Array.from({ length: 7 }, () => feedbackItem()))

    const some = await handlers.getReviewPanel(DOCUMENT_ID, 'true')
    const all = await handlers.getReviewPanel(DOCUMENT_ID, true)

    // 'true' 문자열은 참으로 읽지 않는다. 기본은 상위 5개다 (PRD 4.5).
    expect(some.status === 'ok' && some.panel.cards).toHaveLength(INITIAL_VISIBLE_CARDS)
    expect(some.status === 'ok' && some.panel.hiddenCount).toBe(2)
    expect(all.status === 'ok' && all.panel.cards).toHaveLength(7)
    expect(all.status === 'ok' && all.panel.hiddenCount).toBe(0)
  })
})

describe('검토 요청 (requestStagedReview)', () => {
  it('형태가 틀린 요청은 유스케이스까지 가지 않는다', async () => {
    for (const broken of [null, 'doc-1', paragraphRequest({ stage: 'final' }), paragraphRequest({ scope: 1 })]) {
      expect(await handlers.requestStagedReview(broken)).toEqual({
        status: 'failed',
        message: '검토 요청을 읽지 못했습니다.',
      })
    }
    expect(h.model.calls).toEqual([])
    expect(h.reviews.listReviews(DOCUMENT_ID)).toEqual([])
  })

  it('성공하면 저장된 기록에서 다시 그린 화면을 함께 돌려준다', async () => {
    h.model.replies.push(modelReply([feedbackItem(), feedbackItem({ paragraph: 'P9' })]))

    const result = await handlers.requestStagedReview(paragraphRequest())

    expect(result).toMatchObject({ status: 'reviewed', itemCount: 1, droppedCount: 1 })
    if (result.status !== 'reviewed') throw new Error('성공해야 합니다')
    expect(result.panel.cards).toHaveLength(1)
    expect(result.panel.cards[0]?.grantedStages).toEqual(['question'])
  })

  it('글이 없는 문단은 요청되지 않고 안내만 돌아온다 (T-1)', async () => {
    const result = await handlers.requestStagedReview(paragraphRequest({ paragraphIds: [h.uuidAt(2)] }))

    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.message).toContain('한글에서 먼저 작성')
    expect(h.model.calls).toEqual([])
  })

  it('단계를 건너뛰면 안내만 돌아온다 (T-4)', async () => {
    const result = await handlers.requestStagedReview(paragraphRequest({ stage: 'strong_hint' }))

    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.message).toContain('질문 단계부터')
    expect(h.model.calls).toEqual([])
  })

  it('예시는 exampleRequested 가 true 일 때만 열린다 (T-4)', async () => {
    await openThroughExplanation()
    const called = h.model.calls.length

    // 값을 아예 보내지 않아도, 문자열 'true' 를 보내도 예시는 열리지 않는다.
    expect(await handlers.requestStagedReview(paragraphRequest({ stage: 'example' }))).toEqual({
      status: 'failed',
      message: EXAMPLE_NOT_REQUESTED_MESSAGE,
    })
    for (const value of ['true', 1, {}, 'example']) {
      const blocked = await handlers.requestStagedReview(
        paragraphRequest({ stage: 'example', exampleRequested: value }),
      )
      expect(blocked).toEqual({ status: 'failed', message: EXAMPLE_NOT_REQUESTED_MESSAGE })
    }
    expect(h.model.calls).toHaveLength(called)

    await review(paragraphRequest({ stage: 'example', exampleRequested: true }), [
      feedbackItem({ example: '측정값 표를 근거로 들어 보세요.' }),
    ])
    expect(h.model.calls).toHaveLength(called + 1)
  })

  it('예시를 요청하지 않은 단계의 카드에는 예시가 들어 있지 않다', async () => {
    await review(paragraphRequest(), [feedbackItem(), feedbackItem({ example: '모델이 덧붙인 예시' })])

    const panel = await handlers.getReviewPanel(DOCUMENT_ID, true)
    expect(panel.status === 'ok' && panel.panel.cards.every((card) => card.example === null)).toBe(true)
    expect(JSON.stringify(panel)).not.toContain('모델이 덧붙인 예시')
  })
})

describe('항목 경계 저장 (saveSectionBoundaries)', () => {
  it('문서를 알 수 없거나 목록의 형태가 틀리면 저장하지 않는다', async () => {
    expect(await handlers.saveSectionBoundaries(3, [])).toEqual({
      status: 'failed',
      message: '검토할 문서를 알 수 없습니다.',
    })
    expect(await handlers.saveSectionBoundaries(DOCUMENT_ID, 'sections')).toEqual({
      status: 'failed',
      message: '항목 경계를 읽지 못했습니다.',
    })
    expect(h.anchors.listSections(DOCUMENT_ID)).toEqual([])
  })

  it('사용자가 고친 경계를 저장하고 그 결과를 돌려준다', async () => {
    const result = await handlers.saveSectionBoundaries(DOCUMENT_ID, [
      { ordinal: 1, title: '방법', startParagraphUuid: h.uuidAt(0), endParagraphUuid: h.uuidAt(2) },
      { ordinal: 2, title: '결과', startParagraphUuid: h.uuidAt(3), endParagraphUuid: h.uuidAt(5) },
    ])

    expect(result.status).toBe('saved')
    expect(result.status === 'saved' && result.sections.map((section) => [section.title, section.source])).toEqual([
      ['방법', 'user'],
      ['결과', 'user'],
    ])
  })

  it('내용이 말이 되지 않으면 이유를 그대로 알린다', async () => {
    const result = await handlers.saveSectionBoundaries(DOCUMENT_ID, [
      { ordinal: 1, title: '', startParagraphUuid: h.uuidAt(0), endParagraphUuid: h.uuidAt(2) },
    ])

    expect(result.status).toBe('failed')
    expect(result.status === 'failed' && result.message).toContain('이름을 적어 주세요')
    expect(h.anchors.listSections(DOCUMENT_ID)).toEqual([])
  })
})

describe('문장 확인 (decideSentenceAnchor)', () => {
  /** 문장 범위로 검토를 받은 뒤 그 문장을 지운다. 앵커는 "찾지 못함" 이 된다 */
  async function lostAnchorId(): Promise<string> {
    await review({
      documentId: DOCUMENT_ID,
      scope: 'sentence',
      perspectives: ['logic'],
      stage: 'question',
      sentence: { paragraphId: h.uuidAt(1), sentenceIndex: 0 },
    })
    h.saveVersion(REVIEW_TEXTS.map((text, i) => (i === 1 ? '문장을 통째로 새로 썼다.' : text)))
    await handlers.getReviewPanel(DOCUMENT_ID, true)

    const anchorId = h.anchors.listAnchors(DOCUMENT_ID)[0]?.anchorId
    if (anchorId === undefined) throw new Error('앵커가 있어야 합니다')
    return anchorId
  }

  it('앵커나 결정의 형태가 틀리면 아무것도 바꾸지 않는다', async () => {
    const anchorId = await lostAnchorId()

    expect(await handlers.decideSentenceAnchor(3, { choice: 'keep-lost' })).toEqual({
      status: 'failed',
      message: '확인할 문장 기록을 알 수 없습니다.',
    })
    expect(await handlers.decideSentenceAnchor(anchorId, { choice: 'relink' })).toEqual({
      status: 'failed',
      message: '문장 확인 결과를 읽지 못했습니다.',
    })
    expect(h.anchors.getAnchor(anchorId)?.status).toBe('unresolved')
  })

  it('사용자 확인을 그대로 적용한다 (T-23)', async () => {
    const anchorId = await lostAnchorId()

    const kept = await handlers.decideSentenceAnchor(anchorId, { choice: 'keep-lost' })
    expect(kept).toMatchObject({ status: 'decided', anchor: { status: 'confirmed-lost', needsConfirmation: false } })

    const relinked = await handlers.decideSentenceAnchor(anchorId, { choice: 'relink', sentenceIndex: 0 })
    expect(relinked).toMatchObject({
      status: 'decided',
      anchor: { status: 'linked', text: '문장을 통째로 새로 썼다.' },
    })
  })

  it('없는 앵커에는 적용하지 않는다', async () => {
    expect(await handlers.decideSentenceAnchor('없는-앵커', { choice: 'keep-lost' })).toMatchObject({
      status: 'failed',
    })
  })
})

describe('피드백 삭제 IPC', () => {
  async function oneCard(): Promise<string> {
    h.model.replies.push(modelReply([feedbackItem()]))
    const result = await h.staged.requestStagedReview({ documentId: DOCUMENT_ID, scope: 'paragraph',
      perspectives: ['logic'], stage: 'question', paragraphIds: [h.uuidAt(4)] })
    if (!result.ok) throw new Error(result.message)
    const panel = await h.staged.getPanel(DOCUMENT_ID)
    if ('ok' in panel) throw new Error(panel.message)
    return panel.cards[0]!.itemId
  }

  it('확인 창이 없으면 지우지 않는다', async () => {
    const id = await oneCard()
    expect(await handlers.deleteFeedback(DOCUMENT_ID, id)).toEqual({ status: 'canceled' })
  })

  it('확인하면 지우고, 취소하면 그대로 둔다', async () => {
    const id = await oneCard()
    let answer = false
    const confirming = createReviewHandlers({ staged: h.staged, confirm: () => Promise.resolve(answer) })
    expect(await confirming.deleteFeedback(DOCUMENT_ID, id)).toEqual({ status: 'canceled' })
    answer = true
    expect(await confirming.deleteFeedback(DOCUMENT_ID, id)).toEqual({ status: 'deleted' })
    expect(await confirming.deleteFeedback(DOCUMENT_ID, id)).toMatchObject({ status: 'failed' })
  })

  it('형태가 틀린 값은 받지 않는다', async () => {
    expect((await handlers.deleteFeedback(1, 'x')).status).toBe('failed')
    expect((await handlers.deleteFeedback(DOCUMENT_ID, null)).status).toBe('failed')
  })
})
