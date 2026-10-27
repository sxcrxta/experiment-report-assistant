/**
 * AI 모델 어댑터 경계.
 *
 * PRD 4.3: "두 모델은 공통 응답 형식을 사용하여 교체 가능하게 설계한다."
 * CLAUDE.md §5: 코어와 UI 는 어떤 모델이 응답했는지 몰라도 동작해야 한다.
 *
 * 요청/응답 스키마와 검증은 `schema.ts` 에 있다 (IMPLEMENTATION_PLAN.md §1.5).
 * 구현은 4단계(OpenRouter Gemma)와 7단계(로컬 Claude Code)에서 채운다.
 *
 * 어댑터는 모델이 돌려준 **글**만 돌려준다. 검증·저장은 하지 않는다.
 * 앱 계층이 `validateModelOutput` 으로 검증하고, 통과한 것만 저장한다. 어댑터는 저장소를 모른다.
 *
 * 요청에 싣는 지침은 `ConfirmedRubric`(core/rubric/model.ts) 만 받는다. 앱 계층은 지침을
 * `RubricService.withConfirmedRubric` 로만 얻는다. 확정하지 않은 초안은 이 경계를 넘지 못한다 (`CLAUDE.md` §1).
 */
import type { ReviewRequest } from './schema.js'
import type { DocumentOutline } from '../../core/rubric/outline.js'
import type { CheckPayload, DocumentSummaryPayload, OutlinePayload, PolishPayload } from './prompts/index.js'
import type { GrowthPayload } from '../../shared/personalization.js'

export type { ReviewPerspective, ReviewScope, ReviewStage } from '../../shared/review.js'
import type { ReviewDepth } from '../../shared/review.js'

/**
 * 모델을 부르기 전에 알 수 있는, 쓸 수 없는 이유.
 *
 * 이름은 어느 모델인지를 말하지 않는다. 앱과 화면은 이 이유와 함께 온 한국어 안내를
 * 그대로 보여 줄 뿐이고, 무엇이 없는지는 어댑터가 문구에 적는다.
 */
export type ModelUnavailableReason =
  /** 필요한 자격 증명이 등록되지 않았다 */
  | 'no-key'
  | 'keychain-error'
  /** 부를 프로그램을 찾지 못했다 */
  | 'not-installed'
  /** 프로그램은 있는데 로그인되어 있지 않다 */
  | 'not-logged-in'

export type ModelAvailability =
  | { available: true }
  | { available: false; reason: ModelUnavailableReason; message: string }

export type ModelFailureReason =
  | ModelUnavailableReason
  /** 키가 거절됐다 */
  | 'unauthorized'
  /** 크레딧이 부족하다 */
  | 'payment-required'
  | 'rate-limited'
  /** 서비스가 요청을 받지 않았다 (모델 이름·요청 형식 등) */
  | 'rejected'
  | 'server-error'
  | 'network'
  | 'timeout'
  /** 응답은 왔지만 모델의 글을 꺼낼 수 없다. 스키마 위반과 같이 다시 물을 수 있다 */
  | 'malformed'

export type ModelCallResult =
  | { ok: true; text: string }
  | { ok: false; reason: ModelFailureReason; message: string }

export interface ReviewModel {
  /** 응답과 함께 기록한다. 로직 분기에 쓰지 않는다 */
  readonly modelId: string
  /** 이 어댑터가 쓰는 프롬프트 판 */
  readonly promptVersion: string
  /** 부르기 전에 확인한다. 키 미등록 등 */
  checkAvailability(): Promise<ModelAvailability>
  /** 모델을 한 번 부른다. 예외를 던지지 않고 실패를 결과로 돌려준다 */
  review(request: ReviewRequest): Promise<ModelCallResult>
  /** 집계 기반 성장 요약. 선택적 기능이므로 기존 검토 어댑터 계약을 유지한다. */
  summarizeGrowth?(payload: GrowthPayload): Promise<ModelCallResult>
  /**
   * 보고서 목록에 보여 줄 한 문단 요약 ([Q-36]). 피드백이 아니라 알아보기 위한 설명이다.
   * 선택적이다. 없는 어댑터는 요약 없이 나머지 계약을 그대로 만족한다.
   */
  summarizeDocument?(payload: DocumentSummaryPayload): Promise<ModelCallResult>
  /**
   * 문서 뼈대로 평가 지침 **초안**을 제안한다 (PRD 4.1의 보조 기능).
   * 선택적이다. 없는 어댑터는 제안 없이 나머지 계약을 그대로 만족한다.
   */
  suggestRubricDraft?(outline: DocumentOutline, subject: string | null): Promise<ModelCallResult>
  /**
   * 사용자가 적은 내용을 보고서 문체로 다듬는다 ([Q-43], 사용자 결정으로 대필 금지의 예외).
   * 선택적이다. 없는 어댑터는 다듬기 없이 나머지 계약을 그대로 만족한다.
   */
  polishText?(payload: PolishPayload): Promise<ModelCallResult>
  /**
   * 보고서의 목차(제목 문단과 급)를 제안한다 ([Q-47]). 범위는 프로그램이 정한다.
   * 선택적이다. 없는 어댑터는 번호 규칙 목차로 대신한다.
   */
  analyzeOutline?(payload: OutlinePayload): Promise<ModelCallResult>
  /**
   * 제출 점검 ([Q-48]). 점검표 항목마다 있음/부족/없음과 근거를 준다. 사용자가 누를 때만 부른다.
   * 선택적이다. 없는 어댑터는 점검을 하지 않는다.
   */
  checkSubmission?(payload: CheckPayload): Promise<ModelCallResult>
}

/**
 * 어댑터 선택 지점 ([Q-30], `STAGE_TASKS.md` 7단계).
 *
 * **모델을 고르는 곳은 여기 하나뿐이다.** 앱은 사용자가 고른 깊이를 넘길 뿐이고,
 * 어느 어댑터가 붙어 있는지도, 그 어댑터의 `modelId` 가 무엇인지도 보지 않는다 (`CLAUDE.md` §5).
 *
 * 깊이가 늘면 여기에 항목을 더한다. 코어·앱·화면은 바뀌지 않는다.
 */
export type ReviewModelSet = Readonly<Record<ReviewDepth, ReviewModel>>

/** 깊이에 붙은 어댑터를 돌려준다. 없는 깊이는 타입에서 걸린다. */
export function modelFor(models: ReviewModelSet, depth: ReviewDepth): ReviewModel {
  return models[depth]
}
