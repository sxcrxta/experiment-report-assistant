/** 결정론적 피드백 우선순위 점수. */
import { FEEDBACK_PRIORITY } from '../../shared/priority.js'

export { FEEDBACK_PRIORITY }

export interface PriorityInputs {
  /** 확정 지침의 중요도 (1~5) */
  rubricImportance: number
  /** AI 응답의 심각도 (1~5). 순위 결정권은 프로그램에 있다. */
  severity: number
  /** 같은 관점·지침 조합이 이전에 관찰된 횟수 */
  repeatedWeaknessCount: number
  /** 사용자가 고른 관점과 일치하는 정도 (1~5) */
  perspectiveMatch: number
}

function normalizedLevel(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(5, Math.max(0, value)) / 5
}

/** 0~1 사이의 점수. 모든 입력은 프로그램이 정규화해 사용한다. */
export function priorityScore(input: PriorityInputs): number {
  const repeated = Math.min(
    FEEDBACK_PRIORITY.repeatedWeaknessCap,
    Number.isFinite(input.repeatedWeaknessCount) ? Math.max(0, input.repeatedWeaknessCount) : 0,
  ) / FEEDBACK_PRIORITY.repeatedWeaknessCap

  const score =
    FEEDBACK_PRIORITY.rubricImportance * normalizedLevel(input.rubricImportance) +
    FEEDBACK_PRIORITY.severity * normalizedLevel(input.severity) +
    FEEDBACK_PRIORITY.repeatedWeakness * repeated +
    FEEDBACK_PRIORITY.perspectiveMatch * normalizedLevel(input.perspectiveMatch)
  // 부동소수점 오차가 동점 정렬에 영향을 주지 않도록 계산 결과를 고정한다.
  return Number(score.toFixed(12))
}
