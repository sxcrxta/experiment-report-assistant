import { describe, expect, it } from 'vitest'

import { FEEDBACK_PRIORITY, priorityScore } from '../src/core/priority/score.js'
import { rankByPriority, selectTopK } from '../src/core/priority/topk.js'

describe('피드백 우선순위', () => {
  it('0과 잘못된 수치가 점수를 오염시키지 않는다', () => {
    expect(priorityScore({ rubricImportance: 0, severity: 0, repeatedWeaknessCount: NaN, perspectiveMatch: 0 })).toBe(0)
  })

  it('힙 Top-K가 전체 정렬과 동일하고 K=0 및 동점도 처리한다 (T-20)', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ value: i, score: (i * 73) % 17 }))
    for (const k of [0, 1, 5, 17, 1001]) expect(selectTopK(items, k)).toEqual(rankByPriority(items).slice(0, k))
    expect(() => selectTopK(items, -1)).toThrow()
  })
  it('가중치는 한 곳에서 정한 값이며 합계는 1이다 (T-21)', () => {
    expect(
      FEEDBACK_PRIORITY.rubricImportance +
        FEEDBACK_PRIORITY.severity +
        FEEDBACK_PRIORITY.repeatedWeakness +
        FEEDBACK_PRIORITY.perspectiveMatch,
    ).toBeCloseTo(1)
    expect(FEEDBACK_PRIORITY.topK).toBe(5)
  })

  it('심각도·지침 중요도·반복 관찰·관점 일치가 높을수록 점수가 높다', () => {
    const low = priorityScore({
      rubricImportance: 1,
      severity: 1,
      repeatedWeaknessCount: 0,
      perspectiveMatch: 1,
    })
    const high = priorityScore({
      rubricImportance: 5,
      severity: 5,
      repeatedWeaknessCount: 5,
      perspectiveMatch: 5,
    })
    expect(high).toBeGreaterThan(low)
    expect(high).toBe(1)
  })

  it('점수가 같으면 입력 순서를 보존하고, 기본 Top-K만 고른다', () => {
    const ranked = rankByPriority([
      { value: 'first', score: 0.5 },
      { value: 'second', score: 0.5 },
      { value: 'high', score: 0.8 },
    ])
    expect(ranked.map((entry) => entry.value)).toEqual(['high', 'first', 'second'])

    const many = Array.from({ length: FEEDBACK_PRIORITY.topK + 2 }, (_, i) => ({ value: i, score: i }))
    expect(selectTopK(many).map((entry) => entry.value)).toEqual([6, 5, 4, 3, 2])
  })
})
