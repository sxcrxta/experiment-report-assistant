/**
 * V-2 통합 테스트 — **이 맥에 설치·로그인된 Claude Code 를 실제로 부른다** ([Q-30]).
 *
 * 자동 테스트(`tests/claude-code.test.ts`)는 고정 응답만 쓴다. 인자와 봉투의 모양이 실제와 같은지,
 * 취소·타임아웃이 진짜 프로세스를 정리하는지는 실물로 확인해야 한다 (`CLAUDE.md` §7).
 * 그래서 이 테스트는 기본 `npm run check` 에 들어가지 않고 따로 돌린다.
 *
 * ## 실행 방법
 *
 * ```
 * npm run test:v1 -- tests/integration/v2-claude-code.test.ts
 * ```
 *
 * 로그인되어 있지 않거나 Claude Code 가 없으면 **건너뛴다**. 실패로 보고하지 않는다.
 * 심층 검토는 선택 기능이고, 없는 환경에서도 나머지가 돌아야 하기 때문이다 (PRD 4.3).
 *
 * 확인하는 것 (STAGE_TASKS 7단계 완료 조건)
 * - 확정한 인자로 실제 호출이 성공하고, 구조화 출력이 §1.5 스키마 검증을 통과한다
 * - 질문 단계 응답에 수정 예시가 들어 있지 않다 (T-3)
 * - 취소와 타임아웃이 자식 프로세스를 남기지 않는다 (T-28)
 */
import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { createClaudeCode } from '../../src/adapters/model/claude-code.js'
import { createClaudeCliLocator } from '../../src/adapters/model/claude-path.js'
import { createReviewRequest, validateModelOutput, type ReviewRequest } from '../../src/adapters/model/schema.js'
import { confirmRubric } from '../../src/core/rubric/model.js'

const locator = createClaudeCliLocator()

/** 논리에 구멍이 있는 한 문단. 질문 단계로 검토를 요청한다. */
function request(): ReviewRequest {
  const confirmed = confirmRubric({
    documentId: 'doc-1',
    ordinal: 1,
    confirmedAt: '2026-09-12T00:00:00.000Z',
    items: [{ itemId: 'r1', title: '결과 해석', description: '관찰과 결론의 연결을 밝힌다', importance: 5 }],
  })
  if (!confirmed.ok) throw new Error(confirmed.problems.join(', '))
  const created = createReviewRequest({
    requestId: 'req-1',
    documentVersionId: 'v1',
    scope: 'paragraph',
    stage: 'question',
    perspectives: ['logic'],
    targets: [{
      paragraphId: 'p1',
      text: '실험 결과 온도가 올라갔다. 따라서 기체의 압력이 온도에 비례한다는 가설이 맞다.',
      order: 4,
    }],
    context: [{ paragraphId: 'p0', text: '3. 결과 및 고찰', order: 3 }],
    rubric: confirmed.rubric,
    approvedGuidelines: [],
  })
  if (!created.ok) throw new Error(created.problems.join(', '))
  return created.request
}

/** 우리가 띄운 검토 프로세스의 수. `--no-session-persistence` 는 이 앱만 붙인다. */
function runningReviews(): number {
  try {
    const out = execFileSync('/bin/ps', ['-Ao', 'args']).toString()
    return out.split('\n').filter((line) => /claude\b.*--no-session-persistence/.test(line)).length
  } catch {
    return 0
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 검토 프로세스가 모두 사라질 때까지 기다린다.
 * 죽는 데 걸리는 시간은 정해져 있지 않으므로 고정 시간을 기다리지 않고 확인하며 기다린다.
 */
async function waitForNoReviews(timeoutMs = 15_000): Promise<number> {
  const until = Date.now() + timeoutMs
  let left = runningReviews()
  while (left > 0 && Date.now() < until) {
    await wait(250)
    left = runningReviews()
  }
  return left
}

describe('실제 Claude Code 호출 (V-2)', () => {
  it('설치·로그인 상태를 읽는다', async () => {
    const status = await locator.status()
    console.warn('감지 결과:', status)
    if (status.state !== 'ready') {
      console.warn('Claude Code 를 쓸 수 없어 아래 검토 검증을 건너뜁니다. 심층 검토는 선택 기능입니다.')
    }
    expect(['ready', 'not-installed', 'not-logged-in', 'error']).toContain(status.state)
  })

  it('확정한 인자로 부르고, 응답이 스키마 검증을 통과한다', async () => {
    if ((await locator.status()).state !== 'ready') return

    const model = createClaudeCode({ locator })
    const input = request()
    const started = Date.now()
    const call = await model.review(input)
    console.warn(`걸린 시간: ${Date.now() - started}ms`)

    expect(call.ok).toBe(true)
    if (!call.ok) throw new Error(`${call.reason}: ${call.message}`)

    let sequence = 0
    const validated = validateModelOutput(
      input, call.text,
      { modelId: model.modelId, promptVersion: model.promptVersion },
      () => `item-${(sequence += 1)}`,
    )
    expect(validated.ok).toBe(true)
    if (!validated.ok) throw new Error(validated.problems.join(', '))

    console.warn('요약:', validated.response.summary)
    console.warn(`피드백 ${validated.response.items.length}개, 버린 항목 ${validated.dropped.length}개`)
    expect(validated.response.items.length).toBeGreaterThan(0)
    expect(validated.dropped).toEqual([])
    for (const item of validated.response.items) {
      expect(item.paragraphId).toBe('p1')
      expect(item.stage).toBe('question')
      // 질문 단계에는 수정 예시가 없다 (PRD 4.2, T-3).
      expect(item.example ?? null).toBeNull()
    }
  }, 300_000)

  it('취소하면 자식 프로세스를 남기지 않는다 (T-28)', async () => {
    if ((await locator.status()).state !== 'ready') return

    // 앞 테스트의 프로세스가 남아 있으면 세는 값이 흐려진다. 깨끗한 상태에서 시작한다.
    expect(await waitForNoReviews()).toBe(0)

    const model = createClaudeCode({ locator })
    const pending = model.review(request())
    await wait(3_000)
    expect(model.busy()).toBe(true)
    expect(runningReviews()).toBeGreaterThan(0)

    model.cancel()
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('취소했으므로 실패해야 한다')
    expect(result.message).toContain('취소')

    expect(model.busy()).toBe(false)
    expect(await waitForNoReviews()).toBe(0)
  }, 120_000)

  it('타임아웃이 프로세스를 정리하고 실패로 알린다 (T-28)', async () => {
    if ((await locator.status()).state !== 'ready') return

    // 실제 심층 검토는 이보다 오래 걸린다. 일부러 짧게 잡아 타임아웃 경로를 지난다.
    const model = createClaudeCode({ locator, timeoutMs: 4_000 })
    const result = await model.review(request())

    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(await waitForNoReviews()).toBe(0)
  }, 120_000)
})
