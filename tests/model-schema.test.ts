/**
 * 4단계 — 공통 요청/응답 스키마와 검증 (adapters/model/schema.ts).
 *
 * T-3  `stage != example` 요청의 응답에 예시가 들어오면 그 항목은 버려진다.
 * T-27 스키마를 어긴 응답은 결과가 되지 않고, 문제 설명에 미검증 원문이 섞이지 않는다
 *      (재시도 횟수와 실패 보고는 tests/review-request.test.ts).
 * T-29 모델에 보내는 내용이 대상 문단·지정된 문맥·확정 지침으로 한정된다.
 *
 * 그 밖에
 * - 요청에 없던 paragraphId 를 가리키는 항목은 버린다. 문맥 문단도 대상이 아니다
 * - 확정 지침만 요청에 실린다 (T-5 의 연장)
 * - 검증을 거친 응답만 저장소가 받는 표식을 단다 (T-11)
 */
import { describe, expect, it } from 'vitest'

import {
  BODY_MAX_LENGTH,
  createReviewRequest,
  EXAMPLE_MAX_LENGTH,
  isValidatedReviewResponse,
  MAX_ITEMS_PER_RESPONSE,
  SUMMARY_MAX_LENGTH,
  toModelPayload,
  validateModelOutput,
  type ReviewRequest,
  type ReviewRequestInput,
} from '../src/adapters/model/schema.js'
import { confirmRubric, type ConfirmedRubric, type RubricDraft } from '../src/core/rubric/model.js'

const META = { modelId: 'test/model', promptVersion: 'quick-review.v1' }

/** 모델이 보낸 값에 섞어 넣는 표식. 검증 문제 설명에 이 값이 보이면 원문이 샌 것이다 */
const RAW = 'RAW-모델원문-표식'

function confirmed(): ConfirmedRubric {
  const result = confirmRubric({
    documentId: 'doc-1',
    ordinal: 1,
    items: [
      { itemId: 'rubric-a', title: '실험 목적', description: '', importance: 4 },
      { itemId: 'rubric-b', title: '결과 해석', description: '그래프를 근거로 해석하는가', importance: 5 },
    ],
    confirmedAt: '2026-09-11T00:00:00.000Z',
  })
  if (!result.ok) throw new Error(result.problems.join('\n'))
  return result.rubric
}

function requestInput(overrides: Partial<ReviewRequestInput> = {}): ReviewRequestInput {
  return {
    requestId: 'req-1',
    documentVersionId: 'ver-1',
    scope: 'paragraph',
    stage: 'question',
    perspectives: ['logic', 'expression'],
    targets: [
      { paragraphId: 'uuid-target-2', text: '따라서 보일 법칙이 성립한다.', order: 3 },
      { paragraphId: 'uuid-target-1', text: '온도가 올라가면 압력이 증가했다.', order: 2 },
    ],
    context: [
      { paragraphId: 'uuid-context-2', text: '5. 결론', order: 4 },
      { paragraphId: 'uuid-context-1', text: '주사기에 공기를 넣고 온도를 바꾸었다.', order: 1 },
    ],
    rubric: confirmed(),
    approvedGuidelines: [],
    ...overrides,
  }
}

function makeRequest(overrides: Partial<ReviewRequestInput> = {}): ReviewRequest {
  const result = createReviewRequest(requestInput(overrides))
  if (!result.ok) throw new Error(result.problems.join('\n'))
  return result.request
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

function output(items: unknown[], summary: unknown = '결과와 결론의 연결을 다시 볼 곳이 있습니다.'): string {
  return JSON.stringify({ summary, items })
}

function ids(): () => string {
  let n = 0
  return () => `item-${(n += 1)}`
}

// ---------------------------------------------------------------------------
// 요청
// ---------------------------------------------------------------------------

describe('요청 만들기', () => {
  it('대상과 문맥을 문서 순서로 정리하고 확정 지침의 항목만 옮긴다', () => {
    const request = makeRequest()
    expect(request.targets.map((t) => t.paragraphId)).toEqual(['uuid-target-1', 'uuid-target-2'])
    expect(request.context.map((c) => c.paragraphId)).toEqual(['uuid-context-1', 'uuid-context-2'])
    expect(request.rubric).toEqual({
      rubricVersion: confirmed().rubricVersion,
      items: [
        { itemId: 'rubric-a', title: '실험 목적', description: '' },
        { itemId: 'rubric-b', title: '결과 해석', description: '그래프를 근거로 해석하는가' },
      ],
    })
    expect(request.personalization).toEqual({ approvedGuidelines: [] })
  })

  it('확정 지침이 아니면 요청을 만들지 않는다', () => {
    const draft: RubricDraft = { status: 'draft', documentId: 'doc-1', items: [], updatedAt: 'now' }
    // @ts-expect-error 초안은 요청에 실을 수 없다
    expect(createReviewRequest(requestInput({ rubric: draft }))).toMatchObject({ ok: false })
    // IPC 등으로 복제돼 표식을 잃은 지침도 받지 않는다
    expect(createReviewRequest(requestInput({ rubric: structuredClone(confirmed()) }))).toMatchObject({
      ok: false,
    })
  })

  it('글이 없는 대상 문단으로는 요청을 만들지 않는다 (선행 작성)', () => {
    const result = createReviewRequest(
      requestInput({ targets: [{ paragraphId: 'uuid-empty', text: '   ', order: 0 }] }),
    )
    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.problems.join()).toContain('글로 쓴 내용이 없는')
  })

  it('대상·관점이 없거나, 알 수 없는 값이거나, 식별자가 겹치면 만들지 않는다', () => {
    expect(createReviewRequest(requestInput({ targets: [] })).ok).toBe(false)
    expect(createReviewRequest(requestInput({ perspectives: [] })).ok).toBe(false)
    expect(createReviewRequest(requestInput({ perspectives: ['logic', 'logic'] })).ok).toBe(false)
    // @ts-expect-error 알 수 없는 관점
    expect(createReviewRequest(requestInput({ perspectives: ['tone'] })).ok).toBe(false)
    // @ts-expect-error 알 수 없는 단계
    expect(createReviewRequest(requestInput({ stage: 'rewrite' })).ok).toBe(false)
    expect(
      createReviewRequest(
        requestInput({ context: [{ paragraphId: 'uuid-target-1', text: '겹치는 문단', order: 9 }] }),
      ).ok,
    ).toBe(false)
  })

  it('대상 문장은 그 문단 안에 있어야 한다', () => {
    const target = { paragraphId: 'uuid-t', text: '첫 문장. 둘째 문장.', order: 0 }
    expect(
      createReviewRequest(requestInput({ targets: [{ ...target, sentenceRef: { index: 1, text: '둘째 문장.' } }] }))
        .ok,
    ).toBe(true)
    expect(
      createReviewRequest(requestInput({ targets: [{ ...target, sentenceRef: { index: 0, text: '없는 문장' } }] }))
        .ok,
    ).toBe(false)
  })
})

describe('모델에 보내는 내용 (T-29)', () => {
  it('대상·문맥·확정 지침·관점·단계만 담고, 내부 식별자는 별칭으로 바꾼다', () => {
    const request = makeRequest()
    const payload = toModelPayload(request)

    expect(payload).toEqual({
      stage: 'question',
      scope: 'paragraph',
      perspectives: [
        { code: 'logic', label: '내용의 논리' },
        { code: 'expression', label: '문장 표현' },
      ],
      rubric: [
        { id: 'R1', title: '실험 목적', description: '' },
        { id: 'R2', title: '결과 해석', description: '그래프를 근거로 해석하는가' },
      ],
      guidelines: [],
      paragraphs: [
        { id: 'C1', role: 'context', text: '주사기에 공기를 넣고 온도를 바꾸었다.' },
        { id: 'P1', role: 'target', text: '온도가 올라가면 압력이 증가했다.' },
        { id: 'P2', role: 'target', text: '따라서 보일 법칙이 성립한다.' },
        { id: 'C2', role: 'context', text: '5. 결론' },
      ],
    })

    const sent = JSON.stringify(payload)
    for (const internal of ['req-1', 'ver-1', 'uuid-', 'rubric-a', confirmed().rubricVersion, 'doc-1']) {
      expect(sent).not.toContain(internal)
    }
  })
})

// ---------------------------------------------------------------------------
// 응답 검증
// ---------------------------------------------------------------------------

describe('응답 검증 — 통과', () => {
  it('별칭을 실제 문단·지침으로 되돌리고, 식별자와 단계는 프로그램이 채운다', () => {
    const request = makeRequest()
    const result = validateModelOutput(
      request,
      output([
        modelItem({ stage: 'example', itemId: '모델이-정한-id', paragraph: 'P2', rubricItems: ['R1', 'R1', 'R2'] }),
      ]),
      META,
      ids(),
    )
    if (!result.ok) throw new Error(result.problems.join('\n'))

    expect(result.dropped).toEqual([])
    expect(result.response).toMatchObject({
      requestId: 'req-1',
      modelId: 'test/model',
      promptVersion: 'quick-review.v1',
      rubricVersion: confirmed().rubricVersion,
      summary: '결과와 결론의 연결을 다시 볼 곳이 있습니다.',
    })
    expect(result.response.items).toEqual([
      {
        itemId: 'item-1',
        paragraphId: 'uuid-target-2',
        perspective: 'logic',
        stage: 'question',
        severity: 3,
        body: '온도와 압력의 관계를 어떤 자료로 확인했나요?',
        rationale: '결과 문단에 근거가 된 측정값이 드러나지 않습니다.',
        appliedRubricItemIds: ['rubric-a', 'rubric-b'],
      },
    ])
  })

  it('스키마에 없는 필드는 옮기지 않는다', () => {
    const result = validateModelOutput(
      makeRequest(),
      output([modelItem({ rewrite: `${RAW} 이렇게 고치세요`, note: RAW })]),
      META,
      ids(),
    )
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(RAW)
  })

  it('코드 블록으로 감싼 JSON 은 벗겨서 읽는다', () => {
    const text = '```json\n' + output([modelItem()]) + '\n```'
    expect(validateModelOutput(makeRequest(), text, META, ids()).ok).toBe(true)
  })

  it('지적할 것이 없으면 항목 없이 요약만 있는 응답도 통과한다', () => {
    const result = validateModelOutput(makeRequest(), output([]), META, ids())
    expect(result.ok && result.response.items).toEqual([])
  })

  it('검증을 통과한 응답은 얼어 있고 표식이 붙는다. 복제하거나 흉내 낸 객체에는 없다', () => {
    const result = validateModelOutput(makeRequest(), output([modelItem()]), META, ids())
    if (!result.ok) throw new Error('검증 실패')
    const { response } = result

    expect(isValidatedReviewResponse(response)).toBe(true)
    expect(Object.isFrozen(response) && Object.isFrozen(response.items[0])).toBe(true)
    expect(() => {
      ;(response.items[0] as { body: string }).body = '몰래 바꾼 본문'
    }).toThrow(TypeError)

    expect(isValidatedReviewResponse(structuredClone(response))).toBe(false)
    expect(isValidatedReviewResponse({ ...response })).toBe(false)
  })
})

describe('예시는 예시 단계에서만 (T-3)', () => {
  const nonExampleStages = ['question', 'weak_hint', 'strong_hint', 'explanation'] as const

  it.each(nonExampleStages)('%s 단계 응답에 예시가 들어 있는 항목은 버린다', (stage) => {
    const request = makeRequest({ stage })
    const result = validateModelOutput(
      request,
      output([modelItem({ example: `${RAW} 온도가 높을수록 압력이 커졌다.` }), modelItem({ paragraph: 'P2' })]),
      META,
      ids(),
    )
    if (!result.ok) throw new Error(result.problems.join('\n'))

    expect(result.response.items).toHaveLength(1)
    expect(result.response.items[0]?.paragraphId).toBe('uuid-target-2')
    expect(result.response.items.every((item) => item.example === undefined)).toBe(true)
    expect(result.dropped).toEqual([
      { index: 0, problems: ['예시를 요청하지 않았는데 예시가 들어 있습니다.'] },
    ])
    expect(JSON.stringify(result)).not.toContain(RAW)
  })

  it('예시가 빈 문자열이어도 들어 있는 것으로 보고 버린다', () => {
    const result = validateModelOutput(makeRequest(), output([modelItem({ example: '' })]), META, ids())
    expect(result.ok).toBe(false)
  })

  it('예시만 담은 항목뿐이면 쓸 수 있는 결과가 없으므로 응답 전체를 실패로 본다', () => {
    const result = validateModelOutput(makeRequest(), output([modelItem({ example: '고친 문장' })]), META, ids())
    expect(result).toMatchObject({ ok: false })
  })

  it('예시 단계에서는 짧은 예시가 있어야 하고, 길면 버린다', () => {
    const request = makeRequest({ stage: 'example' })
    const result = validateModelOutput(
      request,
      output([
        modelItem({ example: '온도가 10 ℃ 오를 때 압력은 3 % 늘었다.' }),
        modelItem({ paragraph: 'P2' }),
        modelItem({ paragraph: 'P2', example: '가'.repeat(EXAMPLE_MAX_LENGTH + 1) }),
      ]),
      META,
      ids(),
    )
    if (!result.ok) throw new Error(result.problems.join('\n'))

    expect(result.response.items).toEqual([
      expect.objectContaining({ stage: 'example', example: '온도가 10 ℃ 오를 때 압력은 3 % 늘었다.' }),
    ])
    expect(result.dropped.map((d) => d.index)).toEqual([1, 2])
  })
})

describe('요청에 없던 대상을 가리키는 항목은 버린다', () => {
  it.each([
    ['요청에 없는 별칭', 'P9'],
    ['문맥 문단', 'C1'],
    ['내부 uuid 를 그대로 적은 경우', 'uuid-target-1'],
    ['빈 값', ''],
    ['문자열이 아닌 값', 1],
  ])('%s', (_label, paragraph) => {
    const result = validateModelOutput(
      makeRequest(),
      output([modelItem({ paragraph }), modelItem()]),
      META,
      ids(),
    )
    if (!result.ok) throw new Error(result.problems.join('\n'))
    expect(result.response.items.map((i) => i.paragraphId)).toEqual(['uuid-target-1'])
    expect(result.dropped).toEqual([{ index: 0, problems: ['요청의 검토 대상이 아닌 문단을 가리킵니다.'] }])
  })

  it('요청하지 않은 관점, 잘못된 심각도, 빈 본문, 요청에 없던 지침 항목도 버린다', () => {
    const bad = [
      modelItem({ perspective: 'references' }),
      modelItem({ perspective: 'tone' }),
      modelItem({ severity: 0 }),
      modelItem({ severity: 6 }),
      modelItem({ severity: 2.5 }),
      modelItem({ severity: '3' }),
      modelItem({ body: '  ' }),
      modelItem({ body: '가'.repeat(BODY_MAX_LENGTH + 1) }),
      modelItem({ rationale: undefined }),
      modelItem({ rubricItems: ['R3'] }),
      modelItem({ rubricItems: 'R1' }),
      'not an object',
    ]
    const result = validateModelOutput(makeRequest(), output([...bad, modelItem()]), META, ids())
    if (!result.ok) throw new Error(result.problems.join('\n'))

    expect(result.response.items).toHaveLength(1)
    expect(result.dropped.map((d) => d.index)).toEqual(bad.map((_, i) => i))
  })
})

describe('응답 전체가 형식을 어기면 결과가 되지 않는다 (T-27)', () => {
  it.each([
    ['JSON 이 아닌 글', `${RAW} 좋은 보고서입니다!`],
    ['앞에 설명이 붙은 JSON', `${RAW} 결과는 다음과 같습니다.\n${output([modelItem()])}`],
    ['배열', JSON.stringify([modelItem()])],
    ['요약 없음', JSON.stringify({ items: [modelItem()] })],
    ['빈 요약', output([modelItem()], '  ')],
    ['너무 긴 요약', output([modelItem()], `${RAW}${'가'.repeat(SUMMARY_MAX_LENGTH)}`)],
    ['items 가 목록이 아님', JSON.stringify({ summary: '요약', items: { a: RAW } })],
    ['항목이 너무 많음', output(Array.from({ length: MAX_ITEMS_PER_RESPONSE + 1 }, () => modelItem()))],
    ['모든 항목이 규칙 위반', output([modelItem({ paragraph: 'P9', body: RAW }), modelItem({ severity: RAW })])],
    ['빈 응답', ''],
  ])('%s', (_label, text) => {
    const result = validateModelOutput(makeRequest(), text, META, ids())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.length).toBeGreaterThan(0)
    // 문제 설명에 모델이 보낸 원문을 옮기지 않는다.
    expect(JSON.stringify(result)).not.toContain(RAW)
  })
})
