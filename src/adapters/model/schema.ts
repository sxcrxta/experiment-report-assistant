/**
 * AI 모델 공통 요청/응답 스키마와 검증 (IMPLEMENTATION_PLAN.md §1.5).
 *
 * PRD 4.3: "두 모델은 공통 응답 형식을 사용하여 교체 가능하게 설계한다."
 * CLAUDE.md §5: 모델 응답은 반드시 스키마 검증을 통과해야 저장·표시된다.
 *
 * 흐름
 * 1. `createReviewRequest` — 앱이 모은 대상·문맥·지침으로 요청을 만든다. **확정 지침만 받는다.**
 * 2. `toModelPayload` — 요청에서 모델에 보낼 것만 뽑는다. 외부로 나가는 문서 텍스트는 이것뿐이다.
 *    문단·지침 식별자는 짧은 별칭(P1, C1, R1)으로 바꾼다. 모델이 긴 식별자를 옮겨 적다 틀리지 않게 하고,
 *    내부 식별자를 밖으로 보내지 않기 위해서다.
 * 3. `validateModelOutput` — 모델이 돌려준 글을 검증해 `ReviewResponse` 로 만든다.
 *    - 응답 전체가 형식에 맞지 않으면 실패다. 부르는 쪽이 정해진 횟수만 다시 묻는다.
 *    - 규칙을 어긴 항목은 그 항목만 버린다.
 *      · 예시를 요청하지 않았는데(stage != example) 예시가 들어 있는 항목 (PRD 4.2)
 *      · 요청의 검토 대상이 아닌 문단을 가리키는 항목. AI 가 대상을 새로 만들지 못한다.
 *        문맥 문단도 대상이 아니다. 사용자가 고른 범위 밖에 피드백을 달지 않는다
 *      · 요청하지 않은 관점, 요청에 없던 지침 항목을 가리키는 항목
 *    - 항목 식별자·단계·문장 위치는 모델이 정하지 않는다. 프로그램이 요청에서 채운다.
 *    - 스키마에 있는 필드만 옮긴다. 모델이 덧붙인 필드와 원문은 결과에 섞이지 않는다.
 *    - 검증 문제를 설명하는 문구에는 모델이 보낸 값을 넣지 않는다. 미검증 원문이 화면에 새지 않게 한다.
 *
 * 여기에는 네트워크도 저장소도 없다. 검증을 통과한 결과를 저장하는 것은 앱 계층이다 (`CLAUDE.md` §2).
 */
import { assertConfirmedRubric, type ConfirmedRubric } from '../../core/rubric/model.js'
import {
  FEEDBACK_SEVERITY_LEVELS,
  REVIEW_PERSPECTIVE_LABELS,
  REVIEW_PERSPECTIVES,
  REVIEW_SCOPES,
  REVIEW_STAGES,
  type FeedbackSeverity,
  type ReviewPerspective,
  type ReviewScope,
  type ReviewStage,
} from '../../shared/review.js'

/** 그림 하나의 크기 한도. 넘는 그림은 보내지 않는다. */
export const IMAGE_BYTES_MAX = 4 * 1024 * 1024
/** 한 요청에 실을 그림 총량. 요청이 끝없이 커지지 않게 묶는다. */
export const IMAGE_BYTES_TOTAL_MAX = 12 * 1024 * 1024
/** 한 요청에 실을 그림 개수. */
export const IMAGE_COUNT_MAX = 40

// ---------------------------------------------------------------------------
// 한도. 넘으면 그 항목(요약이면 응답 전체)을 받지 않는다.
// ---------------------------------------------------------------------------

/** 카드에 접어서 보여 줄 요약의 최대 길이 */
export const SUMMARY_MAX_LENGTH = 500
/** 피드백 본문·근거의 최대 길이 */
export const BODY_MAX_LENGTH = 1500
/** "짧은" 수정 예시의 최대 길이 (PRD 4.2). 길게 대신 써 주는 것을 막는다 */
export const EXAMPLE_MAX_LENGTH = 200
/** 응답 하나에 받을 수 있는 항목 수 */
export const MAX_ITEMS_PER_RESPONSE = 30

// ---------------------------------------------------------------------------
// 요청
// ---------------------------------------------------------------------------

/** 문장 범위 검토일 때 대상 문장 (IMPLEMENTATION_PLAN.md §2.3). 앵커 추적은 5단계에서 한다. */
export interface SentenceRef {
  /** 문단 안에서 몇 번째 문장인가 (0부터) */
  index: number
  text: string
}

export interface ReviewTarget {
  paragraphId: string
  text: string
  /** 문서 안에서의 순서. 대상과 문맥을 문서 순서로 보여 주는 데만 쓴다 */
  order: number
  sentenceRef?: SentenceRef
}

export interface ReviewContext {
  paragraphId: string
  text: string
  order: number
}

/** 요청에 싣는 지침 항목. 확정 지침에서 그대로 옮긴다. */
export interface ReviewRubricItem {
  itemId: string
  title: string
  description: string
}

/**
 * 이미 받은 피드백과 그에 대한 사용자 판단 (PRD 4.3 "Gemma 피드백에 대한 재심, 사용자 반박의 재검토",
 * `IMPLEMENTATION_PLAN.md` §1.5).
 *
 * 재심을 요청할 때만 실린다. **누가 준 피드백인지는 싣지 않는다.** 모델 이름이 들어가면
 * 재검토가 모델에 따라 갈라지고, 코어·앱이 모델을 모른다는 약속도 흔들린다 (`CLAUDE.md` §5).
 * 사용자 판단은 그대로 옮긴다. AI 가 덮어쓰거나 조용히 무시하지 못하게 하기 위해서다 (`CLAUDE.md` §1).
 */
export interface PriorFeedback {
  /** 이 피드백이 달렸던 문단. 이번 요청의 **검토 대상 안**에 있어야 한다 */
  paragraphId: string
  perspective: ReviewPerspective
  stage: ReviewStage
  body: string
  rationale: string
  /** 사용자가 고른 판단. `agree` `partial` `rebuttal` `unclear` `completed` */
  reaction: string
  /** 사용자가 적은 사유. 없으면 빈 문자열 */
  reactionReason: string
}

/**
 * 검토와 함께 보내는 보고서의 그림 ([Q-38], 2026-09-18).
 *
 * 사용자 결정으로 **문서 전체의 그림**을 보낸다. 표·그림 관점 피드백이 캡션 글만 보고 나오던 것을
 * 실제 그림을 보고 나오게 하기 위한 것이다.
 *
 * `bytes` 는 HWPX ZIP 안에 있던 그림 그대로다. 프로그램이 다시 그리거나 고치지 않는다.
 * 별칭(`G1`, `G2`…)만 프롬프트 글에 실리고 바이트는 요청의 그림 부분으로 따로 간다 —
 * **base64 가 프롬프트 글에 섞이지 않게** 하기 위해서다.
 */
export interface ReviewImage {
  /** 프롬프트 글에서 부를 이름. 내부 식별자를 밖으로 보내지 않는다 */
  alias: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif'
  bytes: Uint8Array
}

export interface ReviewRequest {
  requestId: string
  scope: ReviewScope
  /** 검토 대상 문단. 문서 순서 */
  targets: readonly ReviewTarget[]
  /** 판단에 필요한 앞뒤 문맥만. 문서 순서 */
  context: readonly ReviewContext[]
  perspectives: readonly ReviewPerspective[]
  stage: ReviewStage
  /**
   * 기록을 잇는 식별자와 지침 항목. [Q-48] 뒤로 검토는 평가 지침을 쓰지 않으므로 items 는 비어 있고,
   * rubricVersion 은 보고서마다 하나인 "검토 맥락" 식별자다 (저장소의 외래 키를 잇는 데만 쓴다).
   */
  rubric: { rubricVersion: string; items: readonly ReviewRubricItem[] }
  /** AI 가 짐작하거나 사용자가 고친 문서 종류 ([Q-48]). 모르면 빈 문자열 */
  documentKind: string
  /** 사용자가 승인한 개인화 지침만 (8단계에서 채운다) */
  personalization: { approvedGuidelines: readonly string[] }
  /** 재심·반박 재검토일 때 함께 보는 기존 피드백과 사용자 판단. 아니면 빈 목록 */
  priorFeedback: readonly PriorFeedback[]
  /** 보고서의 그림. 읽지 못했거나 그림이 없으면 빈 목록이고, 그때는 글만으로 검토한다 ([Q-38]) */
  images: readonly ReviewImage[]
  documentVersionId: string
}

export interface ReviewRequestInput {
  requestId: string
  documentVersionId: string
  scope: ReviewScope
  stage: ReviewStage
  /** 보고서의 그림. 없으면 글만으로 검토한다 ([Q-38]) */
  images?: readonly ReviewImage[]
  perspectives: readonly ReviewPerspective[]
  targets: readonly ReviewTarget[]
  context: readonly ReviewContext[]
  /**
   * 기록을 잇는 식별자와 지침 항목 ([Q-48]). 검토는 평가 지침을 쓰지 않으므로 보통 items 는 비어 있다.
   * 지침을 실을 때는 확정 지침만 받는다 (`CLAUDE.md` §1).
   */
  rubric: ConfirmedRubric | { rubricVersion: string; items: readonly [] }
  /** 문서 종류 ([Q-48]). 모르면 빈 문자열이거나 없다 */
  documentKind?: string
  approvedGuidelines: readonly string[]
  /** 재심을 요청할 때만 넣는다. 대상 문단에 달렸던 피드백만 받는다 */
  priorFeedback?: readonly PriorFeedback[]
}

export type CreateRequestResult = { ok: true; request: ReviewRequest } | { ok: false; problems: string[] }

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** 요청을 만든다. 규칙을 어기면 만들지 않고 이유를 돌려준다. 모델은 불리지 않는다. */
export function createReviewRequest(input: ReviewRequestInput): CreateRequestResult {
  const problems: string[] = []

  // 지침 항목을 싣는다면 확정 지침이어야 한다. 항목 없는 검토 맥락은 그대로 받는다 ([Q-48]).
  if (input.rubric.items.length > 0) {
    try {
      assertConfirmedRubric(input.rubric)
    } catch {
      return { ok: false, problems: ['확정한 평가 지침이 아니면 요청에 실을 수 없습니다.'] }
    }
  }
  // 초안처럼 식별자가 없는 것은 받지 않는다 (`CLAUDE.md` §1).
  const link = (input.rubric as { rubricVersion?: unknown }).rubricVersion
  if (typeof link !== 'string' || link === '' || (input.rubric as { status?: unknown }).status === 'draft') {
    return { ok: false, problems: ['검토 기록을 이을 식별자가 없습니다. 초안은 요청에 실을 수 없습니다.'] }
  }

  if (!isOneOf(REVIEW_SCOPES, input.scope)) problems.push('검토 범위가 올바르지 않습니다.')
  if (!isOneOf(REVIEW_STAGES, input.stage)) problems.push('피드백 단계가 올바르지 않습니다.')

  if (input.perspectives.length === 0) problems.push('관점을 하나 이상 골라 주세요.')
  if (!input.perspectives.every((p) => isOneOf(REVIEW_PERSPECTIVES, p))) {
    problems.push('알 수 없는 관점이 있습니다.')
  }
  if (new Set(input.perspectives).size !== input.perspectives.length) {
    problems.push('같은 관점이 두 번 들어 있습니다.')
  }

  if (input.targets.length === 0) problems.push('검토할 문단을 하나 이상 골라 주세요.')
  // 선행 작성 보장: 사용자가 쓴 글이 없는 대상에는 피드백을 만들지 않는다 (`CLAUDE.md` §1).
  if (input.targets.some((t) => t.text.trim() === '')) {
    problems.push('아직 글로 쓴 내용이 없는 문단은 검토를 요청할 수 없습니다.')
  }
  if (input.context.some((c) => c.text.trim() === '')) problems.push('내용이 없는 문맥 문단이 있습니다.')

  const ids = [...input.targets, ...input.context].map((p) => p.paragraphId)
  if (ids.some((id) => id === '') || new Set(ids).size !== ids.length) {
    problems.push('문단 식별자가 비었거나 겹칩니다.')
  }

  const targetIds = new Set(input.targets.map((t) => t.paragraphId))
  if ((input.priorFeedback ?? []).some((prior) => !targetIds.has(prior.paragraphId))) {
    problems.push('검토 대상이 아닌 문단의 기존 피드백은 실을 수 없습니다.')
  }
  if ((input.priorFeedback ?? []).some((prior) => prior.body.trim() === '')) {
    problems.push('내용이 없는 기존 피드백이 있습니다.')
  }

  for (const target of input.targets) {
    const ref = target.sentenceRef
    if (ref === undefined) continue
    if (!Number.isInteger(ref.index) || ref.index < 0 || ref.text === '' || !target.text.includes(ref.text)) {
      problems.push('대상 문장이 그 문단에 없습니다.')
    }
  }

  if (problems.length > 0) return { ok: false, problems }

  const byOrder = <T extends { order: number }>(list: readonly T[]): T[] =>
    [...list].sort((a, b) => a.order - b.order)

  return {
    ok: true,
    request: {
      requestId: input.requestId,
      scope: input.scope,
      targets: byOrder(input.targets).map((t) => ({ ...t })),
      context: byOrder(input.context).map((c) => ({ ...c })),
      perspectives: [...input.perspectives],
      stage: input.stage,
      images: (input.images ?? []).map((image) => ({ ...image })),
      rubric: {
        rubricVersion: input.rubric.rubricVersion,
        items: input.rubric.items.map(({ itemId, title, description }) => ({ itemId, title, description })),
      },
      personalization: { approvedGuidelines: [...input.approvedGuidelines] },
      priorFeedback: (input.priorFeedback ?? []).map((prior) => ({ ...prior })),
      documentKind: (input.documentKind ?? '').trim(),
      documentVersionId: input.documentVersionId,
    },
  }
}

// ---------------------------------------------------------------------------
// 모델에 보내는 것
// ---------------------------------------------------------------------------

/**
 * 모델에 보내는 내용 전부. 프롬프트 템플릿이 이것을 글로 옮긴다.
 * 요청 식별자·문서 버전·내부 문단 uuid 는 들어 있지 않다.
 */
/**
 * 프롬프트 글에 실리는 그림 안내. **바이트는 여기 없다.**
 * `JSON.stringify(payload)` 로 프롬프트를 만들기 때문에, 바이트를 넣으면 base64 가 글에 섞인다.
 */
export interface PayloadImageNote {
  alias: string
  /** 이 그림이 놓인 문단의 별칭. 대상·문맥 밖이면 null */
  paragraph: string | null
}

export interface ModelPayload {
  /**
   * 문서 종류 ([Q-48]). **종류를 알 때만 있다** — 없으면 필드 자체가 없어 예전 판의 프롬프트 글이
   * 한 글자도 바뀌지 않는다.
   */
  document?: { kind: string }
  stage: ReviewStage
  scope: ReviewScope
  perspectives: { code: ReviewPerspective; label: string }[]
  rubric: { id: string; title: string; description: string }[]
  guidelines: string[]
  /** 문서 순서. role 이 target 인 문단에만 피드백을 단다 */
  paragraphs: { id: string; role: 'target' | 'context'; text: string; sentenceRef?: SentenceRef }[]
  /**
   * 이미 받은 피드백과 사용자 판단. **재심을 요청할 때만 있다.**
   * 보통의 검토에서는 이 필드 자체가 없다. 그래야 기존 프롬프트의 글이 한 글자도 바뀌지 않고,
   * 판을 올리지 않은 캐시가 그대로 유효하다 (`CLAUDE.md` §5·§6).
   * 문단은 별칭(P1…)으로 바꾸고, 어느 모델이 준 피드백인지는 싣지 않는다.
   */
  priorFeedback?: {
    paragraph: string
    perspective: ReviewPerspective
    stage: ReviewStage
    body: string
    rationale: string
    userReaction: string
    userReason: string
  }[]
  /**
   * 함께 보내는 그림의 목록. **그림이 없으면 이 필드 자체가 없다** — 그래야 예전 프롬프트의 글이
   * 한 글자도 바뀌지 않고, 그림 없는 문서의 캐시가 그대로 유효하다 (`CLAUDE.md` §6).
   */
  images?: PayloadImageNote[]
}

interface Aliases {
  /** 별칭 → 대상 문단 uuid. 문맥 문단은 여기에 없다 */
  targets: Map<string, ReviewTarget>
  rubric: Map<string, string>
}

/** 별칭은 요청만 보고 정해진다. 보낼 때와 검증할 때 같은 값이 나온다. */
function aliasesOf(request: ReviewRequest): Aliases & { context: Map<string, ReviewContext> } {
  return {
    targets: new Map(request.targets.map((t, i) => [`P${i + 1}`, t])),
    context: new Map(request.context.map((c, i) => [`C${i + 1}`, c])),
    rubric: new Map(request.rubric.items.map((item, i) => [`R${i + 1}`, item.itemId])),
  }
}

export function toModelPayload(request: ReviewRequest): ModelPayload {
  const aliases = aliasesOf(request)
  const paragraphs = [
    ...[...aliases.targets].map(([id, t]) => ({ id, role: 'target' as const, text: t.text, order: t.order,
      ...(t.sentenceRef === undefined ? {} : { sentenceRef: t.sentenceRef }) })),
    ...[...aliases.context].map(([id, c]) => ({ id, role: 'context' as const, text: c.text, order: c.order })),
  ]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...paragraph }) => paragraph)

  return {
    ...(request.documentKind === '' ? {} : { document: { kind: request.documentKind } }),
    stage: request.stage,
    scope: request.scope,
    perspectives: request.perspectives.map((code) => ({ code, label: REVIEW_PERSPECTIVE_LABELS[code] })),
    rubric: request.rubric.items.map((item, i) => ({
      id: `R${i + 1}`,
      title: item.title,
      description: item.description,
    })),
    guidelines: [...request.personalization.approvedGuidelines],
    paragraphs,
    ...priorFeedbackOf(request, aliases),
    ...imageNotesOf(request),
  }
}

/**
 * 함께 보내는 그림의 **이름표만** 프롬프트 글에 넣는다. 바이트는 `toModelImages` 가 따로 뽑는다.
 * 그림이 없으면 키 자체를 만들지 않는다 — 그림 없는 문서의 프롬프트가 예전과 한 글자도 같아야
 * 캐시가 그대로 유효하다 (`CLAUDE.md` §6).
 */
function imageNotesOf(request: ReviewRequest): Pick<ModelPayload, 'images'> {
  const sent = toModelImages(request)
  if (sent.length === 0) return {}
  return { images: sent.map((image) => ({ alias: image.alias, paragraph: null })) }
}

/**
 * 요청과 함께 나갈 **그림 바이트**. `toModelPayload` 와 함께 이 둘이 외부로 나가는 전부다
 * (`CLAUDE.md` §4). 사용자 결정으로 문서 전체의 그림을 보낸다 ([Q-38]).
 *
 * 다만 요청이 끝없이 커지지 않게 **총량을 묶는다.** 넘치면 문서 순서대로 담다가 멈춘다.
 * 몇 장을 보냈는지는 프롬프트 글의 `images` 목록에 그대로 보이므로 감추지 않는다.
 */
export function toModelImages(request: ReviewRequest): ReviewImage[] {
  const sent: ReviewImage[] = []
  let total = 0
  for (const image of request.images) {
    if (image.bytes.byteLength > IMAGE_BYTES_MAX) continue
    if (total + image.bytes.byteLength > IMAGE_BYTES_TOTAL_MAX) break
    if (sent.length >= IMAGE_COUNT_MAX) break
    total += image.bytes.byteLength
    sent.push(image)
  }
  return sent
}

/** 재심일 때만 `priorFeedback` 을 넣는다. 아닐 때는 키 자체를 만들지 않는다. */
function priorFeedbackOf(
  request: ReviewRequest,
  aliases: Aliases,
): Pick<ModelPayload, 'priorFeedback'> {
  const entries = request.priorFeedback.flatMap((prior) => {
    const alias = [...aliases.targets].find(([, target]) => target.paragraphId === prior.paragraphId)?.[0]
    // 대상 밖의 피드백은 애초에 요청에 들어오지 못하지만, 별칭을 못 찾으면 보내지 않는다.
    return alias === undefined
      ? []
      : [{
          paragraph: alias,
          perspective: prior.perspective,
          stage: prior.stage,
          body: prior.body,
          rationale: prior.rationale,
          userReaction: prior.reaction,
          userReason: prior.reactionReason,
        }]
  })
  return entries.length === 0 ? {} : { priorFeedback: entries }
}

// ---------------------------------------------------------------------------
// 응답
// ---------------------------------------------------------------------------

export interface FeedbackItem {
  /** 프로그램이 준 식별자 */
  itemId: string
  /** 대상 문단. 요청의 검토 대상 중 하나다 */
  paragraphId: string
  /** 문장 범위 검토일 때. 요청의 대상 문장을 프로그램이 옮겨 적는다 */
  sentenceRef?: SentenceRef
  perspective: ReviewPerspective
  /** 요청한 단계. 모델이 바꾸지 못한다 */
  stage: ReviewStage
  /** 우선순위 점수의 입력값일 뿐이다 (IMPLEMENTATION_PLAN.md §1.7) */
  severity: FeedbackSeverity
  /** 질문·힌트·설명 본문 */
  body: string
  /** 근거 */
  rationale: string
  /** 적용한 지침 항목 */
  appliedRubricItemIds: string[]
  /** stage == example 인 경우에만 존재한다 */
  example?: string
}

/** 이 모듈의 검증만 붙이는 표식. 타입에만 있고 실제 값은 없다. */
declare const VALIDATED: unique symbol

/**
 * 검증을 통과한 응답. `validateModelOutput` 만 만든다. 저장소는 이 타입만 받는다.
 * 얼려 두므로 검증 뒤에 고칠 수 없다.
 */
export interface ReviewResponse {
  readonly [VALIDATED]: true
  readonly requestId: string
  /** 기록만 한다. 로직 분기에 쓰지 않는다 (`CLAUDE.md` §5) */
  readonly modelId: string
  readonly rubricVersion: string
  readonly promptVersion: string
  readonly items: readonly Readonly<FeedbackItem>[]
  /** 카드에 접어서 보여 줄 짧은 요약 */
  readonly summary: string
}

const validatedResponses = new WeakSet<object>()

/** 이 모듈이 검증해 만든 응답 객체인가. 타입을 속였거나 복제한 객체는 false. */
export function isValidatedReviewResponse(value: unknown): value is ReviewResponse {
  return typeof value === 'object' && value !== null && validatedResponses.has(value)
}

export interface DroppedItem {
  /** 모델 응답의 items 안에서 몇 번째였는가 (0부터) */
  index: number
  problems: string[]
}

export type ValidationResult =
  | { ok: true; response: ReviewResponse; dropped: DroppedItem[] }
  | { ok: false; problems: string[] }

export interface ResponseMeta {
  modelId: string
  promptVersion: string
}

/** 모델이 JSON 을 코드 블록(```json … ```)으로 감싸 보내는 경우만 벗긴다. 글 속에서 JSON 을 찾지 않는다. */
const CODE_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim()
  const fenced = CODE_FENCE.exec(trimmed)
  try {
    return { ok: true, value: JSON.parse(fenced?.[1] ?? trimmed) as unknown }
  } catch {
    return { ok: false }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSeverity(value: unknown): value is FeedbackSeverity {
  return typeof value === 'number' && (FEEDBACK_SEVERITY_LEVELS as readonly number[]).includes(value)
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' || trimmed.length > max ? null : trimmed
}

function checkItem(
  raw: unknown,
  request: ReviewRequest,
  aliases: Aliases,
  newId: () => string,
): { ok: true; item: FeedbackItem } | { ok: false; problems: string[] } {
  if (!isRecord(raw)) return { ok: false, problems: ['항목이 객체가 아닙니다.'] }

  const problems: string[] = []

  const target = typeof raw['paragraph'] === 'string' ? aliases.targets.get(raw['paragraph']) : undefined
  if (target === undefined) problems.push('요청의 검토 대상이 아닌 문단을 가리킵니다.')

  const perspective = raw['perspective']
  if (!isOneOf(request.perspectives, perspective)) problems.push('요청하지 않은 관점입니다.')

  const severity = raw['severity']
  if (!isSeverity(severity)) problems.push('심각도가 1~5 의 정수가 아닙니다.')

  const body = boundedText(raw['body'], BODY_MAX_LENGTH)
  if (body === null) problems.push(`본문이 없거나 ${BODY_MAX_LENGTH}자를 넘습니다.`)

  const rationale = boundedText(raw['rationale'], BODY_MAX_LENGTH)
  if (rationale === null) problems.push(`근거가 없거나 ${BODY_MAX_LENGTH}자를 넘습니다.`)

  // 지침 없이 한 검토([Q-48])에서는 모델이 버릇처럼 적은 지침 id 를 무시한다. 항목까지 버리지 않는다.
  const rubricAliases = aliases.rubric.size === 0 ? [] : raw['rubricItems'] ?? []
  const appliedRubricItemIds: string[] = []
  if (!Array.isArray(rubricAliases)) {
    problems.push('적용 지침이 목록이 아닙니다.')
  } else {
    for (const alias of rubricAliases as unknown[]) {
      const itemId = typeof alias === 'string' ? aliases.rubric.get(alias) : undefined
      if (itemId === undefined) {
        problems.push('요청에 없던 지침 항목을 가리킵니다.')
        break
      }
      if (!appliedRubricItemIds.includes(itemId)) appliedRubricItemIds.push(itemId)
    }
  }

  // 예시는 사용자가 예시 단계를 요청했을 때만 받는다 (PRD 4.2, T-3).
  const hasExample = raw['example'] !== undefined && raw['example'] !== null
  let example: string | null = null
  if (request.stage === 'example') {
    example = boundedText(raw['example'], EXAMPLE_MAX_LENGTH)
    if (example === null) problems.push(`짧은 수정 예시가 없거나 ${EXAMPLE_MAX_LENGTH}자를 넘습니다.`)
  } else if (hasExample) {
    problems.push('예시를 요청하지 않았는데 예시가 들어 있습니다.')
  }

  if (
    problems.length > 0 ||
    target === undefined ||
    !isOneOf(request.perspectives, perspective) ||
    !isSeverity(severity) ||
    body === null ||
    rationale === null
  ) {
    return { ok: false, problems }
  }

  const item: FeedbackItem = {
    itemId: newId(),
    paragraphId: target.paragraphId,
    perspective,
    stage: request.stage,
    severity,
    body,
    rationale,
    appliedRubricItemIds,
  }
  if (target.sentenceRef !== undefined) item.sentenceRef = { ...target.sentenceRef }
  if (example !== null) item.example = example
  return { ok: true, item }
}

function seal(fields: Omit<ReviewResponse, typeof VALIDATED>): ReviewResponse {
  const items = Object.freeze(
    fields.items.map((item) =>
      Object.freeze({
        ...item,
        appliedRubricItemIds: Object.freeze([...item.appliedRubricItemIds]) as string[],
      }),
    ),
  )
  const response = Object.freeze({ ...fields, items }) as ReviewResponse
  validatedResponses.add(response)
  return response
}

/** 이미 검증된 부분 응답들을 묶는다. 모델 응답 한 건의 30개 한도를 합산 결과에 적용하지 않는다. */
export function combineReviewResponses(
  request: ReviewRequest,
  responses: readonly ReviewResponse[],
  meta: ResponseMeta,
): ReviewResponse {
  for (const response of responses) {
    if (!isValidatedReviewResponse(response) || response.rubricVersion !== request.rubric.rubricVersion) {
      throw new Error('검증되지 않은 부분 응답은 합칠 수 없습니다.')
    }
    if (response.items.some((item) => item.stage !== request.stage ||
      !request.perspectives.includes(item.perspective) ||
      !request.targets.some((target) => target.paragraphId === item.paragraphId))) {
      throw new Error('다른 검토 범위의 부분 응답은 합칠 수 없습니다.')
    }
  }
  return seal({
    requestId: request.requestId,
    ...meta,
    rubricVersion: request.rubric.rubricVersion,
    summary: responses.length === 1 ? responses[0]!.summary : '선택한 범위의 검토 결과입니다.',
    items: responses.flatMap((response) => [...response.items]),
  })
}

/**
 * 모델이 돌려준 글을 검증한다.
 *
 * @param newId 통과한 항목에 줄 식별자. 어댑터는 난수를 만들지 않는다
 */
export function validateModelOutput(
  request: ReviewRequest,
  text: string,
  meta: ResponseMeta,
  newId: () => string,
): ValidationResult {
  const parsed = parseJson(text)
  if (!parsed.ok) return { ok: false, problems: ['응답이 JSON 형식이 아닙니다.'] }
  if (!isRecord(parsed.value)) return { ok: false, problems: ['응답이 JSON 객체가 아닙니다.'] }

  const problems: string[] = []
  const summary = boundedText(parsed.value['summary'], SUMMARY_MAX_LENGTH)
  if (summary === null) problems.push(`요약이 없거나 ${SUMMARY_MAX_LENGTH}자를 넘습니다.`)

  const rawItems = parsed.value['items']
  if (!Array.isArray(rawItems)) {
    problems.push('items 가 목록이 아닙니다.')
  } else if (rawItems.length > MAX_ITEMS_PER_RESPONSE) {
    problems.push(`항목이 ${MAX_ITEMS_PER_RESPONSE}개를 넘습니다.`)
  }
  if (problems.length > 0 || summary === null || !Array.isArray(rawItems)) return { ok: false, problems }

  const aliases = aliasesOf(request)
  const items: FeedbackItem[] = []
  const dropped: DroppedItem[] = []
  ;(rawItems as unknown[]).forEach((raw, index) => {
    const checked = checkItem(raw, request, aliases, newId)
    if (checked.ok) items.push(checked.item)
    else dropped.push({ index, problems: checked.problems })
  })

  // 항목을 보냈는데 하나도 쓸 수 없으면 응답 전체가 형식을 어긴 것으로 본다. 다시 물을 수 있다.
  if (rawItems.length > 0 && items.length === 0) {
    const reasons = new Set(dropped.flatMap((d) => d.problems))
    return { ok: false, problems: ['모든 항목이 형식에 맞지 않습니다.', ...reasons] }
  }

  return {
    ok: true,
    dropped,
    response: seal({
      requestId: request.requestId,
      modelId: meta.modelId,
      rubricVersion: request.rubric.rubricVersion,
      promptVersion: meta.promptVersion,
      items,
      summary,
    }),
  }
}
