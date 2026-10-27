/**
 * 선택적 피드백 화면이 쓰는 데이터 모양 (PRD 4.2).
 *
 * 코어(문장 앵커·항목 경계), 앱(단계 진행 제어), 메인, 렌더러가 **같은 모양**을 봐야 하는 타입만 둔다.
 * 렌더러는 코어·앱을 import 할 수 없으므로(계층 경계), 경계를 넘는 모양은 여기 한 곳에 둔다.
 *
 * 이 모듈은 순수한 상수와 타입만 담는다. 여기에 로직을 넣지 않는다.
 */
import type { OutlineView } from './outline.js'
import type { FeedbackSeverity, ReviewDepth, ReviewPerspective, ReviewScope, ReviewStage } from './review.js'
import type { RepeatedObservation } from './personalization.js'
import { FEEDBACK_PRIORITY } from './priority.js'

// ---------------------------------------------------------------------------
// 문장
// ---------------------------------------------------------------------------

/** 정규화된 문단 텍스트를 자른 문장 하나 (`core/document/sentence-anchor.ts`). */
export interface Sentence {
  /** 문단 안에서 몇 번째 문장인가 (0부터) */
  index: number
  /** 앞뒤 공백을 걷어 낸 문장 */
  text: string
  /** 문단 텍스트 안에서 이 문장이 시작하는 위치 (문자 기준) */
  offset: number
}

/**
 * 문장 앵커의 상태.
 * - `linked` 가리키던 문장을 다시 찾았다
 * - `unresolved` 찾지 못했다. **사용자 확인을 기다린다** (임의로 다른 문장에 붙이지 않는다)
 * - `confirmed-lost` 찾지 못한 채로 두겠다고 사용자가 확인했다
 */
export type AnchorStatus = 'linked' | 'unresolved' | 'confirmed-lost'

/** 문장 앵커의 지금 상태. 카드에 그대로 보인다. */
export interface AnchorState {
  anchorId: string
  /** 앵커가 가리키는 문장 */
  text: string
  status: AnchorStatus
  /** 지금 문단 안에서의 문장 번호. 찾지 못했으면 null */
  sentenceIndex: number | null
  /** 사용자에게 그대로 보여 줄 한국어 안내 */
  message: string
  /** 사용자 확인을 기다리는 중인가 */
  needsConfirmation: boolean
  /** 사용자가 다시 연결할 때 고를 수 있는 문장. 문단을 찾지 못했으면 빈 배열 */
  candidates: Sentence[]
}

/** 찾지 못한 앵커에 대한 사용자 결정. 프로그램이 대신 고르지 않는다. */
export type AnchorDecision =
  /** 사용자가 직접 고른 문장에 다시 연결한다 */
  | { choice: 'relink'; sentenceIndex: number }
  /** 찾지 못한 채로 두겠다고 확인했다 */
  | { choice: 'keep-lost' }

// ---------------------------------------------------------------------------
// 보고서 항목 경계
// ---------------------------------------------------------------------------

/** 경계를 무엇을 보고 정했는가. */
export type SectionSource =
  /** 제목 스타일 */
  | 'heading'
  /** 지침 항목 이름과 같은 문단 */
  | 'rubric'
  /** 근거가 없어 문서 전체(또는 앞부분)를 한 항목으로 묶었다 */
  | 'fallback'
  /** 사용자가 고쳤다 */
  | 'user'

export const SECTION_SOURCE_LABELS: Readonly<Record<SectionSource, string>> = {
  heading: '제목 스타일로 추정',
  rubric: '지침 항목 이름으로 추정',
  fallback: '근거가 없어 통째로 묶음',
  user: '직접 고침',
}

export interface SectionBoundary {
  /** 화면에 보이는 순번 (1부터) */
  ordinal: number
  title: string
  /** 문단 목록 안에서의 위치 (0부터) */
  startIndex: number
  /** 포함하는 마지막 문단의 위치 */
  endIndex: number
  startParagraphUuid: string
  endParagraphUuid: string
  source: SectionSource
}

/** 사용자가 고친 경계. 저장소에 이 모양으로 남는다. */
export interface SectionOverride {
  ordinal: number
  title: string
  startParagraphUuid: string
  endParagraphUuid: string
}

// ---------------------------------------------------------------------------
// 검토 화면
// ---------------------------------------------------------------------------

/** 문단이 문서에서 맡는 역할 (`core/document/model.ts` 의 ParagraphRole 과 같은 값). */
export type ParagraphRoleName = 'heading' | 'body' | 'caption' | 'other'

/**
 * 표 안 문단이 어디에 있는가 (`core/document/model.ts` 의 `TablePosition` 과 같은 값).
 * 표는 문단이 칸마다 하나씩 들어 있는 구조라, 이 값이 있어야 화면이 표를 표로 그릴 수 있다.
 */
export interface TableCellPosition {
  /** 문서 안에서 몇 번째 표인가 (0부터) */
  tableIndex: number
  row: number
  col: number
}

/** 범위를 고를 때 보여 주는 문단 하나. */
export interface ParagraphChoice {
  paragraphId: string
  /** 화면에 "문단 N" 으로 보이는 번호 (1부터) */
  number: number
  text: string
  /** 글이 있는가. 없으면 검토를 요청할 수 없다 (선행 작성 보장) */
  hasContent: boolean
  role: ParagraphRoleName
  /** 표 안 문단이면 그 칸의 위치. 표 밖이면 null */
  table: TableCellPosition | null
  /** 문장 범위로 고를 수 있는 문장들 */
  sentences: Sentence[]
  /** 최신 저장에서 바뀐 문단인가. "변경된 곳만 검토" 버튼이 쓴다 ([Q-37]) */
  changed: boolean
  /**
   * 이 문단에 있는 한글 수식 스크립트 원문. 글이 비어도 수식만 있는 문단이 있다.
   * 수식은 사용자가 쓴 내용이며 문단 해시에도 들어간다(`core/document/hash.ts`).
   */
  equations: string[]
}

export interface AppliedRubricItem {
  itemId: string
  title: string
  importance: number
}

/** 피드백 카드 하나. 접힌 줄과 펼친 상세가 모두 여기서 나온다 (PRD 4.2). */
export interface FeedbackCard {
  itemId: string
  requestId: string
  paragraphId: string
  /** 지금 버전에서의 문단 번호. 문단이 사라졌으면 null */
  paragraphNumber: number | null
  perspective: ReviewPerspective
  stage: ReviewStage
  severity: FeedbackSeverity
  /** 접힌 카드에 보이는 한 줄 */
  summary: string
  body: string
  rationale: string
  /** 예시 단계에서만 있다. 그 밖의 단계에서는 언제나 null */
  example: string | null
  appliedRubric: AppliedRubricItem[]
  requestedAt: string
  scope: ReviewScope
  /** 문장 범위 피드백이면 앵커 상태, 아니면 null */
  anchor: AnchorState | null
  /** 피드백을 받은 뒤 그 문단이 바뀌었으면 수정 전후 */
  revision: { before: string; after: string } | null
  /** 이 대상에 이미 연 단계 */
  grantedStages: ReviewStage[]
  /** 다음에 열 수 있는 단계. 더 없으면 null */
  nextStage: ReviewStage | null
  /** 다음 단계가 사용자의 명시적 요청을 요구하는가 (짧은 수정 예시) */
  nextStageNeedsRequest: boolean
  /** 단계 진행을 기록하는 대상 키 */
  targetKey: string
  /**
   * 같은 분류가 관찰된 문서 버전 근거 (`CLAUDE.md` §1, PRD 4.4).
   * **모든 카드에 항상 있다.** 근거가 없으면 빈 목록이며, 그 사실을 화면에 그대로 적는다.
   * 반복 관찰은 취약점 **후보**일 뿐이고, 능력을 단정하는 근거가 아니다.
   */
  repeatedObservation: RepeatedObservation
}

/** 검토 화면이 그리는 상태 전부. */
/** 깊이 하나를 지금 고를 수 있는가 (PRD 4.3). 못 고르면 그 이유를 그대로 보여 준다. */
export interface ReviewDepthOption {
  depth: ReviewDepth
  label: string
  available: boolean
  /** 고를 수 없으면 이유와 할 일. 고를 수 있으면 빈 문자열 */
  unavailableMessage: string
}

export interface ReviewPanel {
  documentId: string
  documentName: string
  /** 검토 대상이 되는 최신 버전. 아직 기록된 버전이 없으면 null */
  versionOrdinal: number | null
  /** 기본 깊이로 지금 AI 검토를 요청할 수 있는가 (오프라인·키 미등록·지침 미확정) */
  requestAvailable: boolean
  /** 깊이별로 지금 쓸 수 있는지. 화면이 고를 수 없는 깊이를 잠근다 */
  depths: ReviewDepthOption[]
  /** 요청할 수 없으면 이유. 요청할 수 있으면 빈 문자열 */
  unavailableMessage: string
  rubricConfirmed: boolean
  /**
   * 지침 확정 **하나만** 빠져 있다 (연결·키는 준비됨). 화면은 이때 요청을 막지 않고,
   * 요청 자리에서 미리 채운 초안을 보여 주며 사용자가 확정하게 한다 ([Q-39]).
   * 확정 전 초안으로 AI 를 부르지 않는 것은 그대로다.
   */
  readyExceptRubric: boolean
  paragraphs: ParagraphChoice[]
  sections: SectionBoundary[]
  /** 문서 종류 ([Q-48]). AI 가 짐작했거나(ai) 사용자가 고친(user) 것. 아직 모르면 null */
  profile?: { kind: string; source: 'ai' | 'user' } | null
  /** 목차 ([Q-47]). AI 가 나눈 것이 없으면 번호 규칙으로 나눈 것. 없으면 화면이 번호 규칙으로 만든다 */
  outline?: OutlineView
  /** 경계를 다시 추정했을 때의 안내. 없으면 빈 문자열 */
  sectionNotice: string
  /** 먼저 보여 줄 카드 */
  cards: FeedbackCard[]
  /** 아직 보여 주지 않은 카드 수 */
  hiddenCount: number
  /**
   * 프로그램이 정한 기본 요청 조건 ([Q-37]).
   *
   * 관점은 **사용자가 고르지 않는다** ([Q-41]). 확정한 지침의 항목에서 프로그램이 정하고
   * (**AI 가 아니다**, `CLAUDE.md` §2), 화면은 무엇으로 보는지 한 줄로 알려 주기만 한다.
   * 단계는 질문부터이고, 올리는 것은 카드에서 사용자가 한다.
   */
  recommended: RecommendedRequest
}

export interface RecommendedRequest {
  perspectives: ReviewPerspective[]
  /** 고른 대상이 아직 받지 않은 가장 이른 단계 */
  stage: ReviewStage
  /** 왜 이 관점인지 사용자에게 보여 줄 한 줄 */
  reason: string
}

/** 사용자가 고른 범위·깊이·단계. 관점은 프로그램이 정한다 ([Q-41]). */
export interface StagedReviewInput {
  documentId: string
  /** 사용자가 고른 검토 깊이. 고르지 않으면 빠른 검토다 (PRD 3절 5번) */
  depth?: ReviewDepth
  scope: ReviewScope
  /**
   * 새 요청은 싣지 않는다. 메인 프로세스가 확정한 지침으로 정한다 ([Q-41]).
   * 카드에서 다음 단계를 요청할 때만 그 카드의 관점을 이어 간다.
   */
  perspectives?: ReviewPerspective[]
  stage: ReviewStage
  /**
   * 사용자가 '짧은 수정 예시'를 직접 요청했는가.
   * 이 값이 true 일 때만 예시 단계로 들어간다 (PRD 4.2). 기본은 false 다.
   */
  exampleRequested?: boolean
  /** scope 가 'paragraph' 일 때 고른 문단 */
  paragraphIds?: string[]
  /** scope 가 'section' 일 때 고른 보고서 항목의 순번 */
  sectionOrdinal?: number
  /** scope 가 'sentence' 일 때 고른 문장 */
  sentence?: { paragraphId: string; sentenceIndex: number }
}

/**
 * 목록에 먼저 보여 주는 피드백 수 (PRD 4.5, `CLAUDE.md` §6). 나머지는 사용자가 요청할 때 준다.
 *
 * 우선순위 점수(지침 중요도 0.35 / 심각도 0.30 / 반복 관찰 0.20 / 관점 일치 0.15)는
 * `shared/priority.ts` 한 곳에 있다. **순위와 표시 여부는 프로그램이 정한다. 모델의 심각도는 입력값일 뿐이다.**
 */
export const INITIAL_VISIBLE_CARDS = FEEDBACK_PRIORITY.topK
