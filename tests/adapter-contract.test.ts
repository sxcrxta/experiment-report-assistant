/**
 * 9단계 — 어댑터 계약 (T-24, `IMPLEMENTATION_PLAN.md` §4.2, `CLAUDE.md` §5).
 *
 * "같은 `ReviewRequest` 를 두 어댑터에 넣었을 때 응답이 동일 스키마를 만족한다."
 *
 * 어댑터는 둘이다: 빠른 검토(Gemma)와 심층 검토(로컬 Claude Code) ([Q-30]).
 * 여기서는 **어느 어댑터든 같은 요청을 받아 같은 검증기를 지난다**는 것을 계약으로 고정한다.
 * `ReviewModel` 만 구현한 가짜 어댑터 둘에 같은 요청을 넣고 같은 검증기를 통과시킨다.
 * 검증기·요청 만들기·응답 결합 어디에도 모델별 갈래가 없다는 뜻이다.
 *
 * 실제 두 어댑터의 개별 동작은 `gemma.test.ts` 와 `claude-code.test.ts` 가 본다.
 * 이 테스트가 깨지면 세 번째 어댑터를 붙이는 비용이 커진 것이다. 느슨하게 고치지 않는다.
 */
import { describe, expect, it } from 'vitest'

import { modelFor, type ModelCallResult, type ReviewModel } from '../src/adapters/model/index.js'
import {
  createReviewRequest,
  isValidatedReviewResponse,
  toModelPayload,
  validateModelOutput,
  type ReviewRequest,
} from '../src/adapters/model/schema.js'
import { confirmRubric } from '../src/core/rubric/model.js'

function request(): ReviewRequest {
  const confirmed = confirmRubric({
    documentId: 'doc-1',
    ordinal: 1,
    confirmedAt: '2026-09-12T00:00:00.000Z',
    items: [{ itemId: 'r1', title: '결과', description: '측정값을 밝힌다', importance: 4 }],
  })
  if (!confirmed.ok) throw new Error(confirmed.problems.join(', '))
  const created = createReviewRequest({
    requestId: 'req-1',
    documentVersionId: 'doc-1-v1',
    scope: 'paragraph',
    stage: 'question',
    perspectives: ['logic', 'structure'],
    targets: [{ paragraphId: 'p1', text: '온도가 올라가면 압력이 증가했다.', order: 4 }],
    context: [{ paragraphId: 'p0', text: '2. 결과', order: 3 }],
    rubric: confirmed.rubric,
    approvedGuidelines: ['근거를 먼저 물어봐 주세요.'],
  })
  if (!created.ok) throw new Error(created.problems.join(', '))
  return created.request
}

/** 어댑터 하나. 밖으로 나가지 않고, 받은 요청에 맞춰 스키마를 지키는 글을 돌려준다. */
function adapter(modelId: string, promptVersion: string, reply: (request: ReviewRequest) => string): ReviewModel {
  return {
    modelId,
    promptVersion,
    checkAvailability: () => Promise.resolve({ available: true }),
    review: (input): Promise<ModelCallResult> => Promise.resolve({ ok: true, text: reply(input) }),
  }
}

describe('두 어댑터가 같은 계약을 지킨다 (T-24)', () => {
  // 같은 요청을 받되 글의 모양은 서로 다르게 만든다. 스키마만 같으면 된다.
  const first = adapter('test/first', 'quick-review.test', (input) =>
    JSON.stringify({
      summary: '결과 문단의 근거를 확인해 보세요.',
      items: input.targets.map((_target, index) => ({
        paragraph: `P${index + 1}`,
        perspective: 'logic',
        severity: 3,
        body: '어떤 측정값으로 확인했나요?',
        rationale: '측정값이 드러나지 않습니다.',
        rubricItems: ['R1'],
      })),
    }),
  )
  const second = adapter('test/second', 'deep-review.test', (input) =>
    JSON.stringify({
      summary: '근거의 연결을 살펴보세요.',
      items: [
        ...input.targets.map((_target, index) => ({
          paragraph: `P${index + 1}`,
          perspective: 'structure',
          severity: 5,
          body: '결과와 고찰의 연결이 보이지 않습니다. 어디에서 이어지나요?',
          rationale: '두 문단을 잇는 문장이 없습니다.',
          rubricItems: [],
        })),
      ],
    }),
  )

  it('같은 요청을 넣으면 두 응답 모두 같은 검증기를 통과한다', async () => {
    const input = request()
    let sequence = 0
    const newId = (): string => `item-${(sequence += 1)}`

    for (const model of [first, second]) {
      const call = await model.review(input)
      expect(call.ok).toBe(true)
      if (!call.ok) throw new Error(call.message)

      const validated = validateModelOutput(input, call.text, {
        modelId: model.modelId,
        promptVersion: model.promptVersion,
      }, newId)
      expect(validated.ok).toBe(true)
      if (!validated.ok) throw new Error(validated.problems.join(', '))

      // 같은 모양이다. 모델 식별자는 기록될 뿐, 구조를 바꾸지 않는다.
      expect(isValidatedReviewResponse(validated.response)).toBe(true)
      expect(validated.response.modelId).toBe(model.modelId)
      expect(Object.keys(validated.response.items[0]!).sort())
        .toEqual(Object.keys(validated.response.items[0]!).sort())
      for (const item of validated.response.items) {
        expect(input.targets.map((target) => target.paragraphId)).toContain(item.paragraphId)
        expect(item.stage).toBe(input.stage)
        // 예시 단계가 아니므로 어느 어댑터의 응답이든 예시가 없다 (T-3).
        expect(item.example ?? null).toBeNull()
      }
    }
  })

  it('응답 객체의 키 구성이 어댑터와 무관하게 같다', async () => {
    const input = request()
    const newId = (): string => 'item-1'
    const responses = []
    for (const model of [first, second]) {
      const call = await model.review(input)
      if (!call.ok) throw new Error(call.message)
      const validated = validateModelOutput(input, call.text,
        { modelId: model.modelId, promptVersion: model.promptVersion }, newId)
      if (!validated.ok) throw new Error(validated.problems.join(', '))
      responses.push(validated.response)
    }
    expect(Object.keys(responses[0]!).sort()).toEqual(Object.keys(responses[1]!).sort())
    expect(Object.keys(responses[0]!.items[0]!).sort()).toEqual(Object.keys(responses[1]!.items[0]!).sort())
  })

  it('두 어댑터에 보내는 페이로드도 같은 함수 하나가 만든다', () => {
    const input = request()
    // 모델이 무엇이든 나가는 내용은 같다. 어댑터가 페이로드를 따로 짓지 않는다.
    expect(toModelPayload(input)).toEqual(toModelPayload(input))
    expect(JSON.stringify(toModelPayload(input))).not.toContain('doc-1-v1')
  })

  it('선택 기능이 없는 어댑터도 검토 계약은 그대로 만족한다', () => {
    // 성장 요약은 선택이다. 없다고 해서 검토가 막히지 않는다.
    expect('summarizeGrowth' in first).toBe(false)
    expect(Object.keys(first).sort()).toEqual(['checkAvailability', 'modelId', 'promptVersion', 'review'])
  })

  it('깊이로 어댑터를 고르는 곳은 한 함수뿐이고, 고른 뒤에는 모두 같은 타입이다 ([Q-30])', () => {
    const models = { quick: first, deep: second }
    expect(modelFor(models, 'quick')).toBe(first)
    expect(modelFor(models, 'deep')).toBe(second)
    // 깊이는 사용자 선택이지 모델 이름이 아니다. 고른 뒤에는 구별할 근거가 없다.
    expect(Object.keys(modelFor(models, 'quick')).sort()).toEqual(Object.keys(modelFor(models, 'deep')).sort())
  })
})
