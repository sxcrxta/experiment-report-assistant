/**
 * 검토 요청의 범위·관점·단계.
 *
 * 모델 어댑터(요청/응답 스키마)와 검토 화면(렌더러, 5단계)이 같은 값을 써야 하므로 여기에 둔다.
 * 순수한 상수와 타입만 담는다. 여기에 로직을 넣지 않는다.
 */

/** PRD 4.2 범위: 문장, 문단, 보고서 항목, 전체 문서 */
export const REVIEW_SCOPES = ['sentence', 'paragraph', 'section', 'document'] as const

export type ReviewScope = (typeof REVIEW_SCOPES)[number]

/**
 * PRD 4.2 단계. 이 순서로만 올라간다 (순서 강제는 5단계 `app/review-stage.ts`).
 * `example`(짧은 수정 예시)은 사용자가 명시적으로 요청할 때만 쓴다.
 */
export const REVIEW_STAGES = ['question', 'weak_hint', 'strong_hint', 'explanation', 'example'] as const

export type ReviewStage = (typeof REVIEW_STAGES)[number]

export const REVIEW_STAGE_LABELS: Readonly<Record<ReviewStage, string>> = {
  question: '질문',
  weak_hint: '약한 힌트',
  strong_hint: '강한 힌트',
  explanation: '설명',
  example: '짧은 수정 예시',
}

/**
 * PRD 3절 5번·4.3 검토 깊이. 사용자가 고르는 값이며 **모델 이름이 아니다**.
 *
 * 깊이는 "얼마나 깊이 볼 것인가" 라는 사용자 선택이고, 그 깊이에 어느 어댑터가 붙는지는
 * 어댑터 선택 지점만 안다. 코어·앱·화면은 어느 모델이 응답했는지 모른 채 동작한다
 * (`CLAUDE.md` §5, [Q-30]).
 */
export const REVIEW_DEPTHS = ['quick', 'deep'] as const

export type ReviewDepth = (typeof REVIEW_DEPTHS)[number]

export const REVIEW_DEPTH_LABELS: Readonly<Record<ReviewDepth, string>> = {
  quick: '빠른 검토',
  deep: '심층 검토',
}

/** 고르지 않았을 때의 깊이. 기본은 빠른 검토다 (PRD 4.3 "기본 기능은 Gemma 빠른 검토이다"). */
export const DEFAULT_REVIEW_DEPTH: ReviewDepth = 'quick'


/** PRD 4.2 관점 */
export const REVIEW_PERSPECTIVES = [
  'format',
  'figures',
  'references',
  'scientific_accuracy',
  'logic',
  'structure',
  'expression',
] as const

export type ReviewPerspective = (typeof REVIEW_PERSPECTIVES)[number]


export const REVIEW_PERSPECTIVE_LABELS: Readonly<Record<ReviewPerspective, string>> = {
  format: '양식 준수',
  figures: '표·그림 설명',
  references: '참고문헌·출처',
  scientific_accuracy: '과학적 정확성',
  logic: '내용의 논리',
  structure: '글의 구조',
  expression: '문장 표현',
}

/**
 * AI 가 매기는 오류 심각도 단계 (5가 가장 심각).
 * 6단계 우선순위 점수의 "오류 심각도" 입력값일 뿐이다. 순위와 표시 여부는 프로그램이 정한다
 * (IMPLEMENTATION_PLAN.md §1.7). 0~1 정규화는 점수를 계산하는 쪽이 한다.
 */
export const FEEDBACK_SEVERITY_LEVELS = [1, 2, 3, 4, 5] as const

export type FeedbackSeverity = (typeof FEEDBACK_SEVERITY_LEVELS)[number]
