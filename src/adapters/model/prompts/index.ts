/**
 * 버전이 붙은 프롬프트 템플릿 (`CLAUDE.md` §5).
 *
 * 프롬프트는 코드에 흩뿌리지 않고 판마다 파일 하나로 둔다. 판 이름(`version`)은 응답과 함께 기록되고
 * 6단계 캐시 키에 들어간다. 글을 고치면 새 판 파일을 만들고 여기의 기본 판을 바꾼다.
 */
import type { ModelPayload } from '../schema.js'

import { DEEP_REVIEW_V1 } from './deep-review.v1.js'
import { DEEP_REVIEW_V2 } from './deep-review.v2.js'
import { QUICK_REVIEW_V1 } from './quick-review.v1.js'
import { QUICK_REVIEW_V2 } from './quick-review.v2.js'
import { QUICK_REVIEW_V3 } from './quick-review.v3.js'
import { QUICK_REVIEW_V4 } from './quick-review.v4.js'

export interface PromptTemplate {
  /** 판 이름. 예: quick-review.v1 */
  version: string
  /** 모델에 보낼 글. 입력은 `toModelPayload` 가 뽑은 것뿐이다 */
  render(payload: ModelPayload): string
}

/**
 * 명령줄 도구를 부르는 판. 시스템 프롬프트를 우리 것으로 대체하므로 글이 둘로 나뉜다.
 * `system` 은 규칙, `render` 는 이번 요청의 입력이다 (`docs/V2-claude-code-확인.md` 3절).
 */
export interface CliPromptTemplate extends PromptTemplate {
  system: string
}

/** 빠른 검토가 지금 쓰는 판 */
export const QUICK_REVIEW_PROMPT: PromptTemplate = QUICK_REVIEW_V4

/** 심층 검토가 지금 쓰는 판 */
export const DEEP_REVIEW_PROMPT: CliPromptTemplate = DEEP_REVIEW_V2

export { QUICK_REVIEW_V1, QUICK_REVIEW_V2, QUICK_REVIEW_V3, DEEP_REVIEW_V1 }

/**
 * 보조 기능의 프롬프트 판. 검토 프롬프트와 달리 캐시 키에 들어가지 않는다
 * (제안과 요약은 캐시하지 않는다). 글을 고치면 새 판 파일을 만든다.
 */
export { RUBRIC_DRAFT_PROMPT_VERSION, renderRubricDraftPrompt } from './rubric-draft.v1.js'
export { renderGrowthPrompt } from './growth-summary.v1.js'
export { OUTLINE_LINE_MAX, OUTLINE_SYSTEM, parseOutline, type OutlinePayload } from './outline.v1.js'
// 양식 점검은 3판을 쓴다 ([Q-49], [Q-50]): 조건마다 충족도 %, 글자 수는 프로그램이 센 값을 함께 보낸다.
export {
  CHECK_OUTPUT_SCHEMA, CHECK_PROMPT_VERSION, CHECK_SYSTEM, parseCheck, renderCheckPrompt,
  type CheckPayloadV3 as CheckPayload, type CheckResult,
} from './check.v3.js'
// 목차는 2판을 쓴다 ([Q-48]): 같은 호출에서 문서 종류도 함께 짐작한다.
export {
  OUTLINE_OUTPUT_SCHEMA, OUTLINE_PROMPT_VERSION, parseDocumentKind, renderOutlinePrompt,
} from './outline.v2.js'
export {
  POLISH_DRAFT_MAX_LENGTH, POLISH_NOTE_MAX_LENGTH, POLISH_OUTPUT_SCHEMA, POLISH_SYSTEM, parsePolish,
} from './polish.v1.js'
// 다듬기는 2판을 쓴다 ([Q-48]): 문서 종류에 맞는 문체로 다듬는다.
export { POLISH_PROMPT_VERSION, renderPolishPrompt, type PolishPayloadV2 as PolishPayload } from './polish.v2.js'
export {
  DOCUMENT_SUMMARY_PROMPT_VERSION, SUMMARY_MAX_LENGTH,
  parseDocumentSummary, renderDocumentSummaryPrompt, type DocumentSummaryPayload,
} from './document-summary.v1.js'
