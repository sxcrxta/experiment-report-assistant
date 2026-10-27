/**
 * 평가 지침 입력 규칙.
 *
 * 지침 편집기(렌더러)와 검증(코어)이 같은 값을 써야 하므로 여기에 둔다.
 * 순수한 상수와 타입만 담는다. 여기에 로직을 넣지 않는다.
 */

/**
 * 항목별 중요도 단계. 6단계 우선순위 점수의 "평가 기준 중요도" 입력값이다
 * (IMPLEMENTATION_PLAN.md §1.7). 0~1 정규화는 점수를 계산하는 쪽이 한다.
 */
export const RUBRIC_IMPORTANCE_LEVELS = [1, 2, 3, 4, 5] as const

export type RubricImportance = (typeof RUBRIC_IMPORTANCE_LEVELS)[number]

/** 새 항목의 중요도 */
export const RUBRIC_IMPORTANCE_DEFAULT: RubricImportance = 3

export const RUBRIC_IMPORTANCE_LABELS: Readonly<Record<RubricImportance, string>> = {
  1: '매우 낮음',
  2: '낮음',
  3: '보통',
  4: '높음',
  5: '매우 높음',
}

/** 항목 이름의 최대 길이 */
export const RUBRIC_ITEM_TITLE_MAX_LENGTH = 100

/** 항목 설명의 최대 길이 */
export const RUBRIC_ITEM_DESCRIPTION_MAX_LENGTH = 1000

/** 지침 하나에 둘 수 있는 항목 수 */
export const RUBRIC_MAX_ITEMS = 50

/**
 * 지침 편집기가 보내는 항목. 새로 추가한 항목은 itemId 가 null 이다.
 * 정규화와 검증은 코어(`core/rubric/model.ts`)가 한다.
 */
export interface RubricItemInput {
  itemId: string | null
  title: string
  description: string
  importance: number
}
