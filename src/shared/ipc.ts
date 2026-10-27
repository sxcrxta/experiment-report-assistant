/**
 * 메인 프로세스와 렌더러가 공유하는 IPC 계약.
 *
 * CLAUDE.md §7: "Electron에서 렌더러에 파일·네트워크 접근을 주지 않는다.
 * 외부 세계는 메인 프로세스에서만 다루고 IPC로 노출한다."
 *
 * 이 모듈은 순수한 상수와 타입만 담는다. 여기에 로직을 넣지 않는다.
 */

import type {
  AnchorDecision,
  AnchorState,
  ReviewPanel,
  SectionBoundary,
  SectionOverride,
  StagedReviewInput,
} from './feedback.js'
import type { RubricItemInput } from './rubric.js'
import type { ReviewDepth } from './review.js'
import type { FirstRunGuide } from './first-run.js'
import type { GrowthView, PersonalDelete, PersonalMutation, PersonalResult, SelfAssessment, UserReaction } from './personalization.js'

export type { RubricItemInput } from './rubric.js'

export const CHANNELS = {
  getGrowth: 'personalization:growth',
  getPersonalRecords: 'personalization:records',
  savePersonalRecord: 'personalization:save',
  deletePersonalRecord: 'personalization:delete',
  summarizeGrowth: 'personalization:summarize',
  /** 앱이 살아 있는지와 기본 환경을 확인한다. 0단계 골격 확인용. */
  appInfo: 'app:info',
  /** 첫 실행에서 아직 남은 설정 단계 (9단계). */
  getFirstRun: 'app:first-run',
  /** 파일 선택 창을 열어 감시할 HWPX 를 고르고 경로를 저장한다 (2단계). */
  chooseDocument: 'document:choose',
  /** 등록된 문서 목록. */
  listDocuments: 'document:list',
  getDocumentWorkspace: 'document:workspace',
  refreshDocument: 'document:refresh',
  /** HWPX 원본의 서식·표·그림을 읽어 검토 화면의 미리보기로 준다. 경로는 렌더러에 보내지 않는다. */
  getDocumentPreview: 'document:preview',
  /** 경로를 잃은 문서의 새 경로를 사용자가 다시 골라 **같은 문서**에 이어 붙인다 (PRD 5절). */
  reconnectDocument: 'document:reconnect',
  /** 메인 → 렌더러. 감시 중 일어난 일(저장 기록, 경로 유실, 실패)을 알린다. */
  documentEvent: 'document:event',
  /** 지금 시점을 사용자 지정 체크포인트로 남긴다 (PRD 4.5). */
  markCheckpoint: 'checkpoint:mark',
  /** 체크포인트를 사용자가 고른 **새 파일**로 되살린다. 원본을 덮어쓰지 않는다 (PRD 4.5). */
  restoreCheckpoint: 'checkpoint:restore',
  /** 사용자가 남긴 체크포인트를 지운다. 확인 창을 거친다. 최초본은 지우지 않는다. */
  deleteCheckpoint: 'checkpoint:delete',
  /** 보고서를 이 앱에서 지운다 (기록 전부). 확인 창을 거친다. 한글 원본은 건드리지 않는다. */
  deleteDocument: 'document:delete',
  /** 받은 피드백 하나를 지운다. 확인 창을 거친다. 거기 달린 내 판단도 함께 지워진다. */
  deleteFeedback: 'review:delete-feedback',
  /** 제출 점검 ([Q-48]). 점검표 항목마다 있음/부족/없음을 AI 가 판단한다. 누를 때만 */
  runCheck: 'rubric:check',
  /** 마지막 점검 결과 */
  getCheck: 'rubric:get-check',
  /** 문서 종류를 사용자가 고친다 ([Q-48]). 검토·다듬기가 참고한다 */
  setDocumentKind: 'review:set-kind',
  /** AI 로 보고서 목차(제목과 급)를 나눠 저장한다 ([Q-47]). 범위는 프로그램이 정한다. */
  analyzeOutline: 'review:analyze-outline',
  /** 보조 창 모드를 켜고 끈다 ([Q-44]). 켜면 화면 오른쪽에 좁게, 늘 위에 뜬다. */
  setCompactWindow: 'window:set-compact',
  /** 사용자가 적은 내용을 AI 가 보고서 문체로 다듬는다 ([Q-43]). 결과는 화면에만 보인다. */
  polishText: 'polish:request',
  /** 등록한 문서의 과목을 고친다 (PRD 4.4). */
  setSubject: 'document:set-subject',
  /** 문서의 평가 지침 편집 상태(초안·현재 확정 버전·이전 버전)를 가져온다 (3단계). */
  getRubric: 'rubric:get',
  /** 편집기 내용을 확정하지 않고 초안으로 저장한다. */
  saveRubricDraft: 'rubric:save-draft',
  /** 편집기 내용을 확정한다. 바뀐 것이 있으면 새 지침 버전이 생긴다. */
  confirmRubric: 'rubric:confirm',
  /** 확정하지 않은 초안을 버린다. 확인 창을 거친다. */
  discardRubricDraft: 'rubric:discard-draft',
  /** 문서 구조로 지침 초안을 제안받는다 (보조 기능, 4단계 이후 제공). */
  suggestRubricDraft: 'rubric:suggest',
  /** 평가 지침 모음과, 고른 보고서가 어느 모음 지침을 따르는지 ([Q-40]) */
  listRubricTemplates: 'rubric-library:list',
  /** 모음에 새 지침을 만든다. 어느 보고서에도 적용하지 않는다 */
  createRubricTemplate: 'rubric-library:create',
  /** 모음 지침을 고쳐 저장한다. 따라가는 보고서에 함께 확정된다 */
  updateRubricTemplate: 'rubric-library:update',
  /** 모음 지침을 지운다. 확인 창을 거친다. 보고서의 확정 지침은 남는다 */
  deleteRubricTemplate: 'rubric-library:delete',
  /** 모음 지침을 보고서에 적용한다 (= 그 내용으로 확정하고 따라가기) */
  applyRubricTemplate: 'rubric-library:apply',
  /** 보고서의 확정 지침을 모음에 새 지침으로 저장한다 */
  saveDocumentRubricToLibrary: 'rubric-library:save-document',
  /** AI 검토 설정 상태(키 등록 여부, 온라인 여부, 지금 요청할 수 있는지)를 가져온다 (4단계). */
  getAiSettings: 'settings:get-ai',
  /** 사용자가 입력한 OpenRouter 키를 macOS 키체인에 넣는다. 키는 다시 렌더러로 돌아가지 않는다. */
  saveOpenRouterKey: 'settings:save-openrouter-key',
  /** 키체인에서 OpenRouter 키를 지운다. 확인 창을 거친다. */
  deleteOpenRouterKey: 'settings:delete-openrouter-key',
  /** Claude Code 를 다시 찾아본다. 설치하거나 로그인한 뒤에 쓴다 (7단계). */
  recheckClaudeMode: 'settings:recheck-claude',
  /** 자동으로 찾지 못했을 때 사용자가 Claude Code 실행 파일 경로를 직접 지정한다. */
  saveClaudeCliPath: 'settings:save-claude-path',
  /** 직접 지정한 경로를 지우고 다시 자동 탐색으로 돌아간다. */
  clearClaudeCliPath: 'settings:clear-claude-path',
  /** 검토 화면의 상태(범위 선택거리·항목 경계·피드백 카드)를 가져온다 (5단계). */
  getReviewPanel: 'review:panel',
  /** 고른 범위·관점·단계로 검토를 요청한다. 단계 순서는 메인 프로세스가 강제한다. */
  requestStagedReview: 'review:request',
  /** 사용자가 고친 보고서 항목 경계를 저장한다. 빈 목록이면 추정으로 되돌린다. */
  saveSectionBoundaries: 'review:save-sections',
  /** 가리키던 문장을 찾지 못한 피드백에 대한 사용자 확인 (다시 연결 / 그대로 두기). */
  decideSentenceAnchor: 'review:decide-anchor',
  /** 이미 받은 피드백 하나를 원 피드백·사용자 판단과 함께 심층으로 다시 본다 (7단계, PRD 4.3·4.4). */
  requestReReview: 'review:re-review',
  /** 실행 중인 심층 검토를 취소한다. 자식 프로세스를 정리한다. */
  cancelDeepReview: 'review:cancel-deep',
} as const

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

/** 체크포인트 이름의 최대 길이. 입력칸과 메인 프로세스 검증이 같은 값을 쓴다 */
export const CHECKPOINT_LABEL_MAX_LENGTH = 50

/** 과목 이름의 최대 길이. 입력칸과 메인 프로세스 검증이 같은 값을 쓴다 */
export const SUBJECT_MAX_LENGTH = 30

export interface AppInfo {
  appVersion: string
  electronVersion: string
  /** 로컬 데이터가 저장되는 위치 (~/Library/Application Support/experiment-agent) */
  userDataPath: string
  /** 로그 위치 (~/Library/Logs/experiment-agent) */
  logPath: string
}

/** 복구할 수 있는 시점 하나. 보관 사본의 위치는 렌더러에 알리지 않는다. */
export interface CheckpointSummary {
  checkpointId: string
  /** 'initial' = 최초본(자동), 'user' = 사용자 지정 */
  kind: 'initial' | 'user'
  label: string
  /** 이 체크포인트가 가리키는 버전 번호 (1부터) */
  versionOrdinal: number
  createdAt: string
}

/** 등록된 문서를 화면에 보여 주기 위한 최소 정보. */
export interface DocumentSummary {
  documentId: string
  displayName: string
  path: string
  /** 사용자가 입력한 과목. 과목 없이 등록된 문서는 null */
  subject: string | null
  /** 지금까지 기록된 버전 수 */
  versionCount: number
  paragraphCount: number
  /** 경로를 잃은 상태인가 (PRD 5절) */
  pathLost: boolean
  /** 남긴 순서대로. 최초본이 맨 앞이다 */
  checkpoints: CheckpointSummary[]
  /**
   * 보고서 목록에 보여 줄 한 문단 요약 ([Q-36]). 아직 없거나 만들지 못했으면 null.
   *
   * `modelId` 는 **어느 모델이 썼는지 사용자에게 보여 주기 위한 것**이다. 화면이 이 값으로
   * 갈라지지 않는다 (`CLAUDE.md` §5). `stale` 이면 최신 저장보다 오래된 요약이다.
   */
  summary: { text: string; modelId: string; createdAt: string; stale: boolean } | null
}

/** 저장소에서 읽은 최신 문단과 버전 기록. HWPX 원본을 수정하지 않는다. */
export interface DocumentWorkspace {
  document: DocumentSummary
  paragraphs: {
    paragraphId: string; number: number; text: string; equations: string[]
    tableNumber: number | null; changed: boolean
  }[]
  versions: {
    versionId: string; ordinal: number; detectedAt: string; paragraphCount: number
    changedCount: number; removedCount: number
  }[]
}

export type DocumentWorkspaceResult =
  | { status: 'ok'; workspace: DocumentWorkspace }
  | { status: 'failed'; message: string }

/** 문서 선택 결과. 실패 시 사용자에게 보여 줄 문구를 함께 돌려준다. */
export type ChooseDocumentResult =
  | { status: 'canceled' }
  | { status: 'registered'; document: DocumentSummary }
  | { status: 'failed'; message: string }

/** 재선택 결과. 성공하면 기존 문서의 버전·체크포인트 기록이 그대로 이어진다. */
export type ReconnectDocumentResult =
  | { status: 'canceled' }
  | { status: 'reconnected'; document: DocumentSummary }
  | { status: 'failed'; message: string }

/** 체크포인트 남기기 결과. 성공하면 체크포인트 목록이 갱신된 문서 정보를 돌려준다. */
export type MarkCheckpointResult =
  | { status: 'marked'; checkpoint: CheckpointSummary; document: DocumentSummary }
  | { status: 'failed'; message: string }

/**
 * 체크포인트 되살리기 결과.
 * 저장 위치 선택이나 확인 창에서 취소하면 아무 파일도 만들지 않는다.
 */
export type RestoreCheckpointResult =
  | { status: 'canceled' }
  | { status: 'restored'; path: string }
  | { status: 'failed'; message: string }

/** 제출 점검 결과 ([Q-48]) */
export interface CheckItemView {
  title: string
  /** 충족도 0~100 ([Q-49]) */
  score: number
  status: 'met' | 'partial' | 'missing'
  evidence: string
  paragraphNumbers: number[]
}

export interface DocumentCheckView {
  /** 전체 충족도: 조건별 충족도의 평균. 프로그램이 계산한다 */
  overall: number | null
  createdAt: string
  modelId: string
  /** 점검한 뒤 문서가 새로 저장되었다 */
  documentChanged: boolean
  /** 점검한 뒤 점검표를 다시 확정했다 */
  checklistChanged: boolean
  results: CheckItemView[]
}

export type RunCheckResult = { status: 'checked'; check: DocumentCheckView } | { status: 'failed'; message: string }
export type GetCheckResult = { status: 'ok'; check: DocumentCheckView | null } | { status: 'failed'; message: string }

export type SetDocumentKindResult = { status: 'saved' } | { status: 'failed'; message: string }

/** 목차 나누기 결과 ([Q-47]). 실패해도 화면은 번호 규칙 목차로 계속 쓴다 */
export type AnalyzeOutlineResult =
  | { status: 'analyzed'; count: number; modelId: string }
  | { status: 'failed'; message: string }

/** 삭제 결과. 확인 창에서 취소하면 아무것도 지우지 않는다. */
export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'canceled' }
  | { status: 'failed'; message: string }

/** 다듬을 글의 최대 길이. 입력칸과 메인 프로세스 검증이 같은 값을 쓴다 */
export const POLISH_DRAFT_MAX_LENGTH = 3000
/** 요청 한 줄(어떻게 써 달라는지)의 최대 길이 */
export const POLISH_NOTE_MAX_LENGTH = 200

/** 글 다듬기 요청 ([Q-43]). 과목은 고른 보고서의 것이고, 없으면 null */
export interface PolishRequest {
  draft: string
  note: string
  subject: string | null
  depth: ReviewDepth
  /** 문서 종류 ([Q-48]). 검토 화면이 보여 주는 값 그대로 */
  kind?: string | null
}

export type PolishResult =
  | { status: 'polished'; text: string; modelId: string }
  | { status: 'failed'; message: string }

export type SetSubjectResult =
  | { status: 'saved'; document: DocumentSummary }
  | { status: 'failed'; message: string }

/** 지침 항목 하나. 중요도는 `shared/rubric.ts` 의 단계 중 하나다. */
export interface RubricItemView {
  itemId: string
  title: string
  description: string
  importance: number
}

/** 확정한 지침 버전 하나. */
export interface RubricVersionView {
  /** 화면에 "버전 N" 으로 보이는 순번 (1부터) */
  ordinal: number
  rubricVersion: string
  confirmedAt: string
  items: RubricItemView[]
}

/** 지침 편집기가 그리는 상태. */
export interface RubricEditorView {
  documentId: string
  /** 확정하지 않은 초안. 없으면 null */
  draft: { items: RubricItemView[]; updatedAt: string } | null
  /** 지금 적용되는 지침(가장 최근 확정). 확정한 적이 없으면 null */
  current: RubricVersionView | null
  /** 확정한 모든 버전. 최근 버전이 맨 앞이다 */
  history: RubricVersionView[]
}

export type RubricEditorResult =
  | { status: 'ok'; editor: RubricEditorView }
  | { status: 'failed'; message: string }

export type ConfirmRubricResult =
  | {
      status: 'confirmed'
      /** 새 버전을 만들었으면 true. 바뀐 것이 없어 마지막 버전을 그대로 쓰면 false */
      created: boolean
      ordinal: number
      editor: RubricEditorView
    }
  | { status: 'failed'; message: string }

export type DiscardRubricDraftResult =
  | { status: 'canceled' }
  | { status: 'discarded'; editor: RubricEditorView }
  | { status: 'failed'; message: string }

/** 초안 제안 결과. 제안은 저장되지 않고 편집기에만 채워진다. */
export type SuggestRubricDraftResult =
  | { status: 'suggested'; items: RubricItemInput[] }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string }

/** 모음 지침 하나 ([Q-40]) */
export interface RubricTemplateView {
  id: string
  name: string
  items: RubricItemView[]
  updatedAt: string
  /** 지금 이 지침을 따라가는 보고서. 저장하면 여기에 함께 확정된다 */
  followingDocumentIds: string[]
  /** 적용했다가 보고서에서 고친 보고서. 저장해도 바뀌지 않는다 */
  detachedDocumentIds: string[]
}

/** 보고서 하나가 어느 모음 지침과 이어져 있는가. `following` 이 false 면 "보고서에서 고침" */
export interface DocumentRubricLinkView {
  templateId: string
  templateName: string
  following: boolean
}

/** 모음 지침 이름의 최대 길이. 입력칸과 메인 프로세스 검증이 같은 값을 쓴다 */
export const RUBRIC_TEMPLATE_NAME_MAX_LENGTH = 50

export type RubricLibraryResult =
  | {
      status: 'ok'
      templates: RubricTemplateView[]
      /** 요청한 보고서의 연결. 보고서를 주지 않았거나 이어진 지침이 없으면 null */
      link: DocumentRubricLinkView | null
      /** 요청한 과목에 먼저 골라 둘 지침. 적용된 것이 아니다 */
      suggestedId: string | null
    }
  | { status: 'failed'; message: string }

export type SaveRubricTemplateResult =
  | { status: 'saved'; template: RubricTemplateView; updatedDocuments: number }
  | { status: 'failed'; message: string }

export type DeleteRubricTemplateResult =
  | { status: 'deleted'; unlinkedDocuments: number }
  | { status: 'canceled' }
  | { status: 'failed'; message: string }

export type ApplyRubricTemplateResult =
  | { status: 'applied'; ordinal: number }
  | { status: 'failed'; message: string }

/** OpenRouter 키 입력칸의 최대 길이. 입력칸과 메인 프로세스 검증이 같은 값을 쓴다 */
export const OPENROUTER_KEY_MAX_LENGTH = 512

/**
 * AI 검토 설정 화면이 그리는 상태.
 * **키 자체는 들어 있지 않다.** 렌더러는 키가 등록됐는지만 안다.
 */
/** Claude Code 를 지금 쓸 수 있는지 (7단계, PRD 4.3·5절). 화면은 이 값만 보고 그린다. */
export interface ClaudeModeView {
  /** 'ready' 가 아니면 심층 검토를 고를 수 없다 */
  state: 'ready' | 'not-installed' | 'not-logged-in' | 'error'
  /** 찾은 실행 파일 경로. 못 찾았으면 null */
  path: string | null
  /** `--version` 첫 줄. 확인하지 못했으면 null */
  version: string | null
  /** 사용자가 그대로 읽는 안내 */
  message: string
  /** 사용자가 직접 지정한 경로를 쓰고 있는가 */
  fromOverride: boolean
  /** 오프라인까지 따졌을 때 지금 심층 검토를 요청할 수 있는가 */
  deepAvailable: boolean
  /** 요청할 수 없으면 이유. 요청할 수 있으면 빈 문자열 */
  deepUnavailableMessage: string
  /** 심층 검토에 쓰는 모델 */
  modelId: string
}

export interface AiSettingsView {
  /** 'unreadable' = 키체인을 확인하지 못했다 */
  keyStatus: 'registered' | 'missing' | 'unreadable'
  online: boolean
  /** 지금 빠른 검토를 요청할 수 있는가 */
  reviewAvailable: boolean
  /** 요청할 수 없으면 이유와 할 일. 요청할 수 있으면 빈 문자열 */
  unavailableMessage: string
  /** 빠른 검토에 쓰는 모델 */
  modelId: string
  /** 검토를 요청하면 외부로 무엇이 나가는지 (`CLAUDE.md` §4) */
  outboundNotice: string
  /** 심층 검토(Claude 모드) 상태. 없어도 나머지 기능은 그대로 쓴다 */
  claude: ClaudeModeView
}

/** 사용자가 직접 지정한 Claude Code 경로의 최대 길이. 입력칸과 메인 프로세스가 같은 값을 쓴다 */
export const CLAUDE_CLI_PATH_MAX_LENGTH = 1024

export type ClaudeModeResult =
  | { status: 'ok'; settings: AiSettingsView }
  | { status: 'failed'; message: string }

export type AiSettingsResult =
  | { status: 'ok'; settings: AiSettingsView }
  | { status: 'failed'; message: string }

export type SaveOpenRouterKeyResult =
  | { status: 'saved'; settings: AiSettingsView }
  | { status: 'failed'; message: string }

export type DeleteOpenRouterKeyResult =
  | { status: 'canceled' }
  | { status: 'deleted'; settings: AiSettingsView }
  | { status: 'failed'; message: string }

// ---------------------------------------------------------------------------
// 선택적 피드백 (5단계)
// ---------------------------------------------------------------------------

export type ReviewPanelResult =
  | { status: 'ok'; panel: ReviewPanel }
  | { status: 'failed'; message: string }

/**
 * 검토 요청 결과.
 * 실패해도 예외를 던지지 않는다. 단계가 잠겨 있거나(순서·예시), 글이 없거나, 오프라인이거나,
 * 응답이 형식을 어긴 경우 모두 사용자에게 보여 줄 문구로 돌아온다.
 */
export type StagedReviewResultView =
  | { status: 'reviewed'; itemCount: number; droppedCount: number; panel: ReviewPanel }
  | { status: 'failed'; message: string }

/** 심층 재검토 결과. 요청 실패도 예외가 아니라 문구로 돌아온다. */
export type ReReviewResultView =
  | { status: 'reviewed'; itemCount: number; droppedCount: number; panel: ReviewPanel }
  | { status: 'failed'; message: string }

export type CancelDeepReviewResult = { status: 'canceled' } | { status: 'idle' }

export type SaveSectionBoundariesResult =
  | { status: 'saved'; sections: SectionBoundary[] }
  | { status: 'failed'; message: string }

export type DecideSentenceAnchorResult =
  | { status: 'decided'; anchor: AnchorState }
  | { status: 'failed'; message: string }

/**
 * 감시 중 일어난 일. 메인 프로세스가 렌더러로 보낸다.
 * 문단 내용은 싣지 않는다. 화면이 알아야 할 것은 무엇이 일어났는지와 그 규모뿐이다.
 */
export type DocumentEvent =
  | {
      kind: 'saved'
      documentId: string
      versionOrdinal: number
      changedCount: number
      removedCount: number
      /** 바이트가 이전 버전과 같아 새 버전을 만들지 않았다 */
      alreadyKnown: boolean
    }
  /** 보고서 요약이 새로 만들어졌다(또는 만들지 못했다). 목록을 다시 읽으면 된다 ([Q-36]) */
  | { kind: 'summary'; documentId: string }
  /** 경로를 잃었다. 감시를 멈췄고 사용자가 다시 골라야 한다 */
  | { kind: 'path-lost'; documentId: string; message: string }
  /** 기다렸는데도 온전히 읽지 못했거나, 저장을 기록하지 못했다. 감시는 계속된다 */
  | { kind: 'failed'; documentId: string; message: string }

/** preload 가 렌더러에 노출하는 유일한 표면. */
export interface AgentBridge {
  getGrowth(): Promise<PersonalResult<GrowthView>>
  getPersonalRecords(documentId: string): Promise<PersonalResult<{reactions:UserReaction[];assessments:SelfAssessment[]}>>
  savePersonalRecord(input: PersonalMutation): Promise<PersonalResult<null>>
  deletePersonalRecord(input: PersonalDelete): Promise<PersonalResult<null>>
  /** @param depth 'deep' 이면 Claude 모드로 심층 분석을 받는다 (PRD 4.6) */
  summarizeGrowth(depth?: 'quick' | 'deep'): Promise<PersonalResult<null>>
  getAppInfo(): Promise<AppInfo>
  getFirstRun(): Promise<FirstRunGuide>
  /** 과목은 등록할 때 함께 입력한다 (PRD 4.4) */
  chooseDocument(subject: string): Promise<ChooseDocumentResult>
  listDocuments(): Promise<DocumentSummary[]>
  getDocumentWorkspace(documentId: string): Promise<DocumentWorkspaceResult>
  refreshDocument(documentId: string): Promise<DocumentWorkspaceResult>
  getDocumentPreview(documentId: string): Promise<import('./document-preview.js').DocumentPreviewResult>
  reconnectDocument(documentId: string): Promise<ReconnectDocumentResult>
  markCheckpoint(documentId: string, label: string): Promise<MarkCheckpointResult>
  restoreCheckpoint(checkpointId: string): Promise<RestoreCheckpointResult>
  deleteCheckpoint(checkpointId: string): Promise<DeleteResult>
  deleteDocument(documentId: string): Promise<DeleteResult>
  deleteFeedback(documentId: string, feedbackId: string): Promise<DeleteResult>
  polishText(request: PolishRequest): Promise<PolishResult>
  setCompactWindow(on: boolean): Promise<{ compact: boolean }>
  analyzeOutline(documentId: string): Promise<AnalyzeOutlineResult>
  setDocumentKind(documentId: string, kind: string): Promise<SetDocumentKindResult>
  runCheck(documentId: string): Promise<RunCheckResult>
  getCheck(documentId: string): Promise<GetCheckResult>
  setSubject(documentId: string, subject: string): Promise<SetSubjectResult>
  getRubric(documentId: string): Promise<RubricEditorResult>
  saveRubricDraft(documentId: string, items: RubricItemInput[]): Promise<RubricEditorResult>
  confirmRubric(documentId: string, items: RubricItemInput[]): Promise<ConfirmRubricResult>
  discardRubricDraft(documentId: string): Promise<DiscardRubricDraftResult>
  suggestRubricDraft(documentId: string): Promise<SuggestRubricDraftResult>
  listRubricTemplates(query: { documentId?: string; subject?: string }): Promise<RubricLibraryResult>
  createRubricTemplate(name: string, items: RubricItemInput[]): Promise<SaveRubricTemplateResult>
  updateRubricTemplate(id: string, name: string, items: RubricItemInput[]): Promise<SaveRubricTemplateResult>
  deleteRubricTemplate(id: string): Promise<DeleteRubricTemplateResult>
  applyRubricTemplate(documentId: string, templateId: string): Promise<ApplyRubricTemplateResult>
  saveDocumentRubricToLibrary(documentId: string, name: string): Promise<SaveRubricTemplateResult>
  getAiSettings(): Promise<AiSettingsResult>
  saveOpenRouterKey(key: string): Promise<SaveOpenRouterKeyResult>
  deleteOpenRouterKey(): Promise<DeleteOpenRouterKeyResult>
  /** Claude Code 를 다시 찾아본다 (설치·로그인 뒤) */
  recheckClaudeMode(): Promise<ClaudeModeResult>
  /** 자동으로 찾지 못했을 때 실행 파일 경로를 직접 지정한다 */
  saveClaudeCliPath(path: string): Promise<ClaudeModeResult>
  /** 직접 지정한 경로를 지우고 자동 탐색으로 돌아간다 */
  clearClaudeCliPath(): Promise<ClaudeModeResult>
  /** @param includeAll 상위 5개 대신 모든 피드백을 받는다 ("나머지 N개 더 보기") */
  getReviewPanel(documentId: string, includeAll?: boolean): Promise<ReviewPanelResult>
  requestStagedReview(input: StagedReviewInput): Promise<StagedReviewResultView>
  saveSectionBoundaries(
    documentId: string,
    overrides: SectionOverride[],
  ): Promise<SaveSectionBoundariesResult>
  decideSentenceAnchor(anchorId: string, decision: AnchorDecision): Promise<DecideSentenceAnchorResult>
  /** 이미 받은 피드백 하나를 심층으로 다시 본다 (PRD 4.3·4.4) */
  requestReReview(documentId: string, feedbackId: string): Promise<ReReviewResultView>
  /** 실행 중인 심층 검토를 취소한다 */
  cancelDeepReview(): Promise<CancelDeepReviewResult>
  /** @returns 구독을 끊는 함수 */
  onDocumentEvent(listener: (event: DocumentEvent) => void): () => void
}

declare global {
  interface Window {
    agent: AgentBridge
  }
}
