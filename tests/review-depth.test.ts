/**
 * 7단계 — 검토 깊이 선택과 심층 재검토 ([Q-30], PRD 3절 5번·4.3·4.4).
 *
 * 여기서 지키는 것
 * - **깊이는 사용자 선택이다.** 고른 깊이에 붙은 어댑터만 불린다. 기본은 빠른 검토다.
 * - **심층이 없어도 전체 흐름이 돈다** (PRD 4.3). 빠른 검토는 그대로 열려 있다.
 * - **심층 재검토는 원 피드백과 사용자 판단을 함께 보낸다.** 그 둘은 저장소에 그대로 남는다
 *   (`CLAUDE.md` §1 사용자 판단 보존).
 * - **재검토가 단계를 새로 열지 않는다.** 예시 단계였던 피드백은 설명 단계로 낮춰 다시 본다 (T-3, T-4).
 * - 깊이가 다르면 캐시를 나눠 쓴다. 재심의 캐시도 원 피드백까지 키에 넣는다.
 *
 * 하네스는 깊이마다 가짜 어댑터를 하나씩 둔다. 실제 프로세스도 네트워크도 없다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCacheKey } from '../src/core/cache/key.js'
import type { StagedReviewInput } from '../src/shared/feedback.js'
import { DEFAULT_REVIEW_DEPTH, REVIEW_DEPTHS } from '../src/shared/review.js'

import {
  DOCUMENT_ID,
  createReviewHarness,
  feedbackItem,
  modelReply,
  type ReviewHarness,
} from './helpers/review-harness.js'

let h: ReviewHarness

beforeEach(() => {
  h = createReviewHarness()
})

afterEach(() => {
  h.close()
})

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

/** 고른 깊이의 어댑터가 한 번 답하게 두고 요청한다. */
async function succeed(
  request: StagedReviewInput,
  items: readonly Record<string, unknown>[] = [feedbackItem()],
): Promise<string> {
  const model = request.depth === 'deep' ? h.deepModel : h.model
  model.replies.push(modelReply(items))
  const result = await h.staged.requestStagedReview(request)
  if (!result.ok) throw new Error(`성공해야 합니다: ${result.message}`)
  return result.requestId
}

describe('깊이 선택', () => {
  it('기본은 빠른 검토다. 고르지 않으면 심층 어댑터를 부르지 않는다', async () => {
    expect(DEFAULT_REVIEW_DEPTH).toBe('quick')
    await succeed(input())

    expect(h.model.calls).toHaveLength(1)
    expect(h.deepModel.calls).toHaveLength(0)
  })

  it('심층을 고르면 그 어댑터만 불린다', async () => {
    await succeed(input({ depth: 'deep' }))

    expect(h.deepModel.calls).toHaveLength(1)
    expect(h.model.calls).toHaveLength(0)
  })

  it('저장된 기록에 실제로 응답한 어댑터의 이름이 남는다', async () => {
    const quick = await succeed(input())
    const deep = await succeed(input({ depth: 'deep', stage: 'weak_hint' }))

    const reviews = h.reviews.listReviews(DOCUMENT_ID)
    expect(reviews.find((r) => r.requestId === quick)?.modelId).toBe('test/fake-model')
    expect(reviews.find((r) => r.requestId === deep)?.modelId).toBe('test/fake-deep-model')
  })

  it('깊이가 다르면 캐시를 나눠 쓴다. 같은 문단이라도 다시 묻는다', async () => {
    await succeed(input())
    // 같은 대상·관점·단계지만 깊이가 다르므로 캐시가 맞지 않는다.
    await succeed(input({ depth: 'deep' }))

    expect(h.model.calls).toHaveLength(1)
    expect(h.deepModel.calls).toHaveLength(1)

    // 같은 깊이로 다시 물으면 캐시를 쓴다.
    await h.staged.requestStagedReview(input())
    expect(h.model.calls).toHaveLength(1)
  })

  it('캐시 키에 모델 식별자와 재심 지문이 함께 들어간다', () => {
    const base = {
      documentId: DOCUMENT_ID, paragraphId: 'p1', paragraphHash: 'hash',
      rubricVersion: 'r1', promptVersion: 'v1', perspective: 'logic',
      stage: 'question', scope: 'paragraph', sentenceHash: null,
    } as const

    expect(createCacheKey({ ...base, modelId: 'a' })).not.toBe(createCacheKey({ ...base, modelId: 'b' }))
    expect(createCacheKey({ ...base, modelId: 'a' }))
      .not.toBe(createCacheKey({ ...base, modelId: 'a', priorFeedbackHash: '["반박"]' }))
  })
})

describe('깊이별 가용성 (PRD 4.3)', () => {
  it('화면이 깊이마다 쓸 수 있는지와 그 이유를 함께 받는다', async () => {
    h.deepModel.availability = {
      available: false, reason: 'not-installed', message: 'Claude Code 를 찾지 못했습니다.',
    }
    const panel = await h.staged.getPanel(DOCUMENT_ID)
    if ('ok' in panel) throw new Error(panel.message)

    expect(panel.depths.map((entry) => entry.depth)).toEqual([...REVIEW_DEPTHS])
    expect(panel.depths.find((entry) => entry.depth === 'quick')).toMatchObject({
      available: true, label: '빠른 검토', unavailableMessage: '',
    })
    expect(panel.depths.find((entry) => entry.depth === 'deep')).toMatchObject({
      available: false, label: '심층 검토', unavailableMessage: 'Claude Code 를 찾지 못했습니다.',
    })
    // 심층을 못 써도 빠른 검토 요청 바는 열려 있다.
    expect(panel.requestAvailable).toBe(true)
  })

  it('심층을 쓸 수 없으면 그 요청만 막히고 빠른 검토는 그대로 된다 (PRD 4.3)', async () => {
    h.deepModel.availability = {
      available: false, reason: 'not-logged-in', message: '로그인되어 있지 않습니다.',
    }

    const blocked = await h.staged.requestStagedReview(input({ depth: 'deep' }))
    expect(blocked).toMatchObject({ ok: false, reason: 'not-logged-in' })
    expect(h.deepModel.calls).toHaveLength(0)

    await succeed(input())
    expect(h.model.calls).toHaveLength(1)
  })

  it('오프라인이면 두 깊이 모두 막힌다 ([Q-21])', async () => {
    h.setOnline(false)
    const panel = await h.staged.getPanel(DOCUMENT_ID)
    if ('ok' in panel) throw new Error(panel.message)

    expect(panel.depths.every((entry) => !entry.available)).toBe(true)
    // 기록 조회는 그대로 된다.
    expect(panel.paragraphs.length).toBeGreaterThan(0)
  })
})

describe('심층 재검토 (PRD 4.3·4.4)', () => {
  /** 빠른 검토로 피드백 하나를 받고 그 식별자를 돌려준다. */
  async function firstFeedback(items?: readonly Record<string, unknown>[]): Promise<string> {
    const requestId = await succeed(input(), items)
    const review = h.reviews.listReviews(DOCUMENT_ID).find((r) => r.requestId === requestId)
    if (review?.status !== 'succeeded') throw new Error('성공한 검토가 있어야 합니다')
    const item = review.items[0]
    if (item === undefined) throw new Error('피드백이 있어야 합니다')
    return item.itemId
  }

  it('원 피드백과 사용자 판단을 함께 심층 어댑터로 보낸다', async () => {
    const reactions = new Map([['', { kind: '', reason: '' }]])
    h.close()
    h = createReviewHarness({
      userReaction: (id) => reactions.get(id) ?? null,
    })

    const feedbackId = await firstFeedback()
    reactions.set(feedbackId, { kind: 'rebuttal', reason: '표 2에 측정값을 적어 두었습니다.' })

    h.deepModel.replies.push(modelReply([feedbackItem({ body: '표 2와 본문의 연결을 확인해 보세요.' })]))
    const result = await h.staged.requestReReview({ documentId: DOCUMENT_ID, feedbackId })
    expect(result.ok).toBe(true)

    const sent = h.deepModel.calls[0]!
    expect(sent.priorFeedback).toHaveLength(1)
    expect(sent.priorFeedback[0]).toMatchObject({
      paragraphId: h.uuidAt(4),
      perspective: 'logic',
      stage: 'question',
      reaction: 'rebuttal',
      reactionReason: '표 2에 측정값을 적어 두었습니다.',
    })
    // 빠른 검토 어댑터는 재검토에 불리지 않는다.
    expect(h.model.calls).toHaveLength(1)
  })

  it('사용자 판단이 없어도 원 피드백만으로 다시 볼 수 있다', async () => {
    const feedbackId = await firstFeedback()

    h.deepModel.replies.push(modelReply())
    expect((await h.staged.requestReReview({ documentId: DOCUMENT_ID, feedbackId })).ok).toBe(true)
    expect(h.deepModel.calls[0]!.priorFeedback[0]).toMatchObject({ reaction: '', reactionReason: '' })
  })

  it('원 피드백과 내 판단을 지우지 않는다 (`CLAUDE.md` §1)', async () => {
    const feedbackId = await firstFeedback()
    const before = h.reviews.listReviews(DOCUMENT_ID)

    h.deepModel.replies.push(modelReply())
    await h.staged.requestReReview({ documentId: DOCUMENT_ID, feedbackId })

    const after = h.reviews.listReviews(DOCUMENT_ID)
    // 원 검토 기록이 그대로 있고, 새 기록이 더해졌을 뿐이다.
    expect(after.length).toBe(before.length + 1)
    const original = after.find((review) => review.requestId === before[0]!.requestId)
    expect(original).toEqual(before[0])
  })

  it('단계를 새로 열지 않는다 — 재검토 뒤에도 다음 단계는 그대로 잠겨 있다 (T-4)', async () => {
    const feedbackId = await firstFeedback()

    h.deepModel.replies.push(modelReply())
    await h.staged.requestReReview({ documentId: DOCUMENT_ID, feedbackId })

    // 질문까지만 열렸으므로 강한 힌트는 여전히 막힌다.
    const skipped = await h.staged.requestStagedReview(input({ stage: 'strong_hint' }))
    expect(skipped).toMatchObject({ ok: false, reason: 'stage-locked' })
  })

  it('예시 단계 피드백은 설명 단계로 낮춰 다시 본다 — 재검토가 예시를 만들지 않는다 (T-3)', async () => {
    // 질문 → … → 예시까지 차례로 연다.
    await succeed(input())
    await succeed(input({ stage: 'weak_hint' }))
    await succeed(input({ stage: 'strong_hint' }))
    await succeed(input({ stage: 'explanation' }))
    const requestId = await succeed(
      input({ stage: 'example', exampleRequested: true }),
      [feedbackItem({ example: '측정값을 문장에 함께 적어 보세요.' })],
    )
    const review = h.reviews.listReviews(DOCUMENT_ID).find((r) => r.requestId === requestId)
    if (review?.status !== 'succeeded') throw new Error('성공해야 합니다')
    const feedbackId = review.items[0]!.itemId

    h.deepModel.replies.push(modelReply())
    expect((await h.staged.requestReReview({ documentId: DOCUMENT_ID, feedbackId })).ok).toBe(true)

    const sent = h.deepModel.calls[0]!
    expect(sent.stage).toBe('explanation')
    // 원 피드백이 예시였다는 사실은 그대로 전한다. 이번에 예시를 만들라는 뜻은 아니다.
    expect(sent.priorFeedback[0]?.stage).toBe('example')
  })

  it('없는 피드백이나 등록되지 않은 문서는 모델을 부르지 않고 막는다', async () => {
    expect(await h.staged.requestReReview({ documentId: 'nope', feedbackId: 'x' }))
      .toMatchObject({ ok: false, reason: 'unknown-document' })
    expect(await h.staged.requestReReview({ documentId: DOCUMENT_ID, feedbackId: 'x' }))
      .toMatchObject({ ok: false, reason: 'unknown-target' })
    expect(h.deepModel.calls).toHaveLength(0)
  })

  it('가리키던 문단이 사라졌으면 임의로 다른 문단에 붙이지 않는다', async () => {
    const feedbackId = await firstFeedback()
    // 결과 문단이 사라진 새 버전을 기록한다.
    h.saveVersion(['1. 실험 방법', '주사기에 공기를 넣었다.'])

    const result = await h.staged.requestReReview({ documentId: DOCUMENT_ID, feedbackId })
    expect(result).toMatchObject({ ok: false, reason: 'unknown-target' })
    expect(h.deepModel.calls).toHaveLength(0)
  })

  it('심층을 쓸 수 없으면 재검토도 그 이유로 막히고 기존 기록은 그대로다', async () => {
    const feedbackId = await firstFeedback()
    h.deepModel.availability = {
      available: false, reason: 'not-installed', message: 'Claude Code 를 찾지 못했습니다.',
    }

    const result = await h.staged.requestReReview({ documentId: DOCUMENT_ID, feedbackId })
    expect(result).toMatchObject({ ok: false, reason: 'not-installed' })
    expect(h.reviews.listReviews(DOCUMENT_ID)).toHaveLength(1)
  })
})
