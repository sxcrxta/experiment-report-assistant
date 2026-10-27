import type { WeaknessObservation } from '../../shared/personalization.js'

/** 본문 삭제/문단 분할을 개선이라고 추측하지 않는다. 수정 완료 판단도 실제 변경과 구분한다. */
export function improvement(before: string, after: string | null, completed: boolean): WeaknessObservation['improvement'] {
  if (after === null) return 'unresolved'
  if (before === after) return 'unconfirmed'
  return completed ? 'confirmed-change' : 'changed'
}

/** 같은 관점 + 같은 평가 항목 묶음. 의미적으로 같은 문제라고 단정하지 않는 보수적 후보 분류. */
export function observationKey(observation: Pick<WeaknessObservation, 'perspective' | 'rubricItemIds'>): string {
  return JSON.stringify([observation.perspective, [...new Set(observation.rubricItemIds)].sort()])
}
