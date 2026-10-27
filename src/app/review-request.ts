/**
 * 빠른 검토 요청 유스케이스.
 *
 * IMPLEMENTATION_PLAN.md §2.3의 모델 호출·6단계 캐시 부분을 옮긴다. 단계 진행 제어는 5단계가 맡는다.
 *
 * ```
 * 검토 요청
 *   └→ 선행 작성 확인 (글이 없는 문단이면 요청 거부)
 *   └→ 온라인 확인: 오프라인이면 검토 요청만 차단하고 안내 [Q-21]
 *   └→ 모델 사용 가능 확인: 키 미등록이면 안내
 *        └→ 문맥 = 대상 문단의 앞뒤 문단만 (core/diff/context.ts)
 *             └→ 확정 지침으로만 요청을 만든다 (RubricService.withConfirmedRubric)
 *                  └→ 모델 호출 → 스키마 검증 → 실패하면 정해진 횟수만 다시 묻는다
 *                       ├ 통과 → 대상 문단·버전에 연결해 저장
 *                       └ 끝내 실패 → 실패와 이유만 저장하고 알린다. 원문은 보여 주지 않는다
 * ```
 *
 * - 이 경로 밖(문서 등록·저장 감지·버전 기록·지침 편집)은 온라인 여부와 키를 모른다. 오프라인이어도 그대로 돈다.
 * - 모델이 누구인지로 갈라지는 로직이 없다. 모델 식별자는 기록만 한다 (`CLAUDE.md` §5).
 *   사용자가 고르는 것은 **깊이**(빠른/심층)이고, 그 깊이에 어느 어댑터가 붙는지는
 *   `ReviewModelSet` 을 만든 곳만 안다. 이 파일은 고른 어댑터를 그대로 쓴다 ([Q-30]).
 * - 이 파일은 조합만 한다. 문맥 범위는 코어, 검증은 `schema.ts`, 영속화는 저장소가 맡는다.
 */
import {
  modelFor,
  type ModelCallResult,
  type ModelUnavailableReason,
  type ReviewModel,
  type ReviewModelSet,
} from '../adapters/model/index.js'
import {
  createReviewRequest,
  combineReviewResponses,
  toModelImages,
  validateModelOutput,
  type PriorFeedback,
  type ReviewImage,
  type ReviewRequest,
  type ReviewResponse,
} from '../adapters/model/schema.js'
import type { OnlineStatus } from '../adapters/net/online.js'
import type { DocumentRepository } from '../adapters/repo/documents.js'
import type { CachedFeedbackItem, ReviewCacheRepository } from '../adapters/repo/cache.js'
import type { ReviewRecord, ReviewRepository, StoredReview } from '../adapters/repo/reviews.js'
import { createCacheKey, type CacheKeyParts } from '../core/cache/key.js'
import { selectContext } from '../core/diff/context.js'
import { hasContent, type Paragraph } from '../core/document/model.js'
import type { ReviewDepth, ReviewPerspective, ReviewScope, ReviewStage } from '../shared/review.js'

import type { RubricFailureReason } from './rubric.js'

/**
 * 모델을 부르는 최대 횟수. 응답이 스키마를 어기면 이 횟수까지만 다시 묻고 실패로 알린다 (`CLAUDE.md` §5).
 * 상수를 여기 한 곳에만 두고 테스트로 고정한다.
 */
export const MAX_MODEL_ATTEMPTS = 3

export interface ReviewServiceDeps {
  documents: DocumentRepository
  /**
   * 검토 맥락 ([Q-48]). 검토는 평가 지침 대신 이것을 쓴다.
   * versionOf: 검토 기록을 잇는 보고서별 식별자 (없으면 만든다). kindOf: 문서 종류, 모르면 빈 문자열
   */
  context: { versionOf(documentId: string): string; kindOf(documentId: string): string }
  reviews: ReviewRepository
  cache: ReviewCacheRepository
  /** 깊이별 어댑터. 고르는 곳은 이 집합을 만든 한 곳뿐이다 */
  models: ReviewModelSet
  online: OnlineStatus
  now: () => string
  newId: () => string
  approvedGuidelines?: (documentId: string) => { id: string; text: string; revision: number }[]
  /**
   * 보고서의 그림 ([Q-38]). 사용자 결정으로 **문서 전체**를 검토와 함께 보낸다.
   *
   * 파일을 읽는 일은 메인 프로세스가 맡는다 (앱 계층은 파일 시스템을 모른다, `CLAUDE.md` §7).
   * 없거나 읽지 못하면 빈 목록이고, 그때는 글만으로 검토한다.
   */
  documentImages?: (documentId: string, versionId: string) => Promise<readonly ReviewImage[]>
}

/**
 * 문장 범위 검토의 대상 문장 (5단계).
 * 문장을 자르고 앵커를 만드는 일은 `app/review-stage.ts` 가 끝낸 뒤 결과만 들어온다.
 */
export interface SentenceTargetInput {
  paragraphId: string
  /** 문단 안에서 몇 번째 문장인가 (0부터) */
  index: number
  text: string
  /** 이 문장을 가리키는 앵커. 피드백은 이 앵커에 달린다 */
  anchorId: string
}

export interface ReviewInput {
  documentId: string
  /** 사용자가 고른 검토 깊이 (PRD 3절 5번) */
  depth: ReviewDepth
  /** 검토할 문단의 uuid. 문서의 최신 버전에 있어야 한다 */
  paragraphIds: readonly string[]
  scope: ReviewScope
  perspectives: readonly ReviewPerspective[]
  stage: ReviewStage
  /** 문장 범위일 때 대상 문장. 문단은 `paragraphIds` 에 있어야 한다 */
  sentences?: readonly SentenceTargetInput[]
  /**
   * 재심·반박 재검토일 때 함께 보내는 기존 피드백과 사용자 판단 (PRD 4.3·4.4).
   * 대상 문단에 달렸던 것만 받는다. 비어 있으면 보통의 검토다.
   */
  priorFeedback?: readonly PriorFeedback[]
}

/** 예전 이름. 빠른 검토만 있던 때의 이름이라 남겨 두고 새 코드는 `ReviewInput` 을 쓴다 */
export type QuickReviewInput = ReviewInput

export type ReviewUnavailableReason = 'offline' | ModelUnavailableReason

export type ReviewAvailability =
  | { available: true }
  | { available: false; reason: ReviewUnavailableReason; message: string }

export type ReviewFailureReason =
  | ReviewUnavailableReason
  | RubricFailureReason
  | 'unknown-document'
  | 'no-version'
  | 'invalid-request'
  | 'no-content'
  /** 모델 호출이 실패했다 (키 거절, 한도, 연결, 서비스 오류 등) */
  | 'model-failed'
  /** 정해진 횟수만큼 물었지만 응답이 끝내 스키마를 어겼다 */
  | 'invalid-response'

export interface ReviewFailure {
  ok: false
  reason: ReviewFailureReason
  /** 사용자에게 그대로 보여 줄 한국어 안내. 모델이 보낸 원문은 들어 있지 않다 */
  message: string
  /** 모델을 불렀다면 실패를 기록한 요청 id. 부르기 전에 막혔으면 null */
  requestId: string | null
}

export interface ReviewSuccess {
  ok: true
  requestId: string
  response: ReviewResponse
  /** 규칙을 어겨 버린 항목 수 */
  droppedCount: number
  /** 모델을 부른 횟수 */
  attempts: number
}

export interface ReviewService {
  /** 고른 깊이로 지금 AI 검토를 요청할 수 있는가. 설정·검토 화면이 안내에 쓴다 */
  availability(depth: ReviewDepth): Promise<ReviewAvailability>
  requestReview(input: ReviewInput): Promise<ReviewSuccess | ReviewFailure>
  /** 저장된 검토 기록. 로컬에서만 읽으므로 오프라인이어도 된다 */
  listReviews(documentId: string): StoredReview[]
}

export const OFFLINE_MESSAGE =
  '인터넷에 연결되어 있지 않아 AI 검토를 요청할 수 없습니다. ' +
  '문서 등록·저장 감지·버전 기록·지침 편집·기존 기록 보기는 그대로 쓸 수 있습니다.'

/**
 * AI 검토를 지금 요청할 수 있는지. 오프라인이면 모델에 묻지도 않는다.
 * 설정 화면과 검토 요청이 같은 판정과 문구를 쓴다.
 */
export async function checkReviewAvailability(deps: {
  online: OnlineStatus
  model: ReviewModel
}): Promise<ReviewAvailability> {
  if (!deps.online.isOnline()) return { available: false, reason: 'offline', message: OFFLINE_MESSAGE }
  return deps.model.checkAvailability()
}

function blocked(reason: ReviewFailureReason, message: string): ReviewFailure {
  return { ok: false, reason, message, requestId: null }
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const { documents, reviews, cache, models, online, now, newId } = deps

  /** 대상 문단을 최신 버전에서 찾는다. 없거나 겹치면 요청하지 않는다. */
  function resolveTargets(
    paragraphs: readonly Paragraph[],
    ids: readonly string[],
  ): { ok: true; targets: Paragraph[] } | ReviewFailure {
    if (ids.length === 0) return blocked('invalid-request', '검토할 문단을 하나 이상 골라 주세요.')
    if (new Set(ids).size !== ids.length) return blocked('invalid-request', '같은 문단이 두 번 선택되었습니다.')

    const wanted = new Set(ids)
    const targets = paragraphs.filter((p) => wanted.has(p.uuid))
    if (targets.length !== ids.length) {
      return blocked(
        'invalid-request',
        '선택한 문단을 최신 버전에서 찾지 못했습니다. 문서가 바뀌었으면 다시 골라 주세요.',
      )
    }
    // 선행 작성 보장: 사용자가 쓴 것이 없는 대상에는 피드백을 만들지 않는다 (`CLAUDE.md` §1).
    // 글도 수식도 없는 문단이 섞였으면 요청하지 않는다.
    if (targets.some((p) => !hasContent(p))) {
      return blocked(
        'no-content',
        '아직 글로 쓴 내용이 없는 문단은 검토를 요청할 수 없습니다. 한글에서 먼저 작성하고 저장해 주세요.',
      )
    }
    // 수식만 있는 문단은 사용자가 쓴 것이지만 모델에 보낼 글이 없다(수식은 싣지 않는다).
    // 그런 문단 때문에 항목 전체("이론적 배경")를 막지 않고, 글이 있는 문단만 보낸다.
    const written = targets.filter((p) => p.text !== '')
    if (written.length === 0) {
      return blocked('no-content', '고른 곳에는 수식만 있어 검토할 글이 없습니다. 글이 있는 부분을 함께 골라 주세요.')
    }
    return { ok: true, targets: written }
  }

  /** 모델을 부르고 검증한다. 저장은 호출자가 최종 응답 하나만 맡는다. */
  async function callModel(
    request: ReviewRequest,
    model: ReviewModel,
  ): Promise<
    | { ok: true; response: ReviewResponse; droppedCount: number; attempts: number }
    | {
        ok: false
        reason: 'model-failed' | 'invalid-response'
        storageReason: string
        message: string
        attempts: number
      }
  > {
    let attempts = 0
    while (attempts < MAX_MODEL_ATTEMPTS) {
      attempts += 1

      let call: ModelCallResult
      try {
        call = await model.review(request)
      } catch (cause) {
        // 어댑터는 예외를 던지지 않기로 했지만, 던지더라도 조용히 사라지게 두지 않는다.
        call = {
          ok: false,
          reason: 'network',
          message: `AI 검토를 요청하지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
        }
      }

      if (!call.ok) {
        if (call.reason === 'malformed') continue
        return { ok: false, reason: 'model-failed', storageReason: call.reason, message: call.message, attempts }
      }

      const validated = validateModelOutput(
        request,
        call.text,
        { modelId: model.modelId, promptVersion: model.promptVersion },
        newId,
      )
      if (!validated.ok) continue

      return {
        ok: true,
        response: validated.response,
        droppedCount: validated.dropped.length,
        attempts,
      }
    }

    // 끝내 형식을 어겼다. 받은 글은 결과인 척 보여 주지도, 저장하지도 않는다.
    const message =
      `AI 응답이 약속한 형식에 맞지 않아 ${attempts}번 물었지만 결과를 보여 드릴 수 없습니다. ` +
      '잠시 뒤 다시 요청해 주세요.'
    return { ok: false, reason: 'invalid-response', storageReason: 'invalid-response', message, attempts }
  }

  function cacheParts(
    paragraph: Paragraph,
    perspective: ReviewPerspective,
    input: ReviewInput,
    sentence: SentenceTargetInput | undefined,
    rubricVersion: string,
    personalizationVersion: string,
    model: ReviewModel,
    imagesHash: string | null,
  ): CacheKeyParts {
    return {
      documentId: input.documentId,
      paragraphId: paragraph.uuid,
      paragraphHash: paragraph.hash,
      rubricVersion,
      promptVersion: model.promptVersion,
      modelId: model.modelId,
      perspective,
      stage: input.stage,
      scope: input.scope,
      // 문단 전체와 그 안의 특정 문장 결과가 서로 섞이지 않도록 문장 텍스트를 쓴다.
      sentenceHash: sentence === undefined ? null : JSON.stringify([sentence.index, sentence.text]),
      personalizationVersion,
      // 문단이 그대로여도 그림이 달라지면 다른 결과다 ([Q-38]).
      imagesHash,
      // 재심은 "무엇을 다시 보라고 했는가" 가 달라지면 다른 요청이다.
      priorFeedbackHash:
        (input.priorFeedback ?? []).length === 0
          ? null
          : JSON.stringify(
              (input.priorFeedback ?? [])
                .filter((prior) => prior.paragraphId === paragraph.uuid)
                .map((prior) => [prior.perspective, prior.stage, prior.body, prior.reaction, prior.reactionReason]),
            ),
    }
  }

  /**
   * 캐시 값도 현재 요청의 대상·지침·단계에 다시 통과시킨다.
   * 따라서 DB가 손상됐거나 옛 캐시가 현재 계약과 안 맞아도 화면·저장소에 바로 들어가지 않는다.
   */
  function restoreCachedResponse(
    request: ReviewRequest,
    summary: string,
    items: readonly CachedFeedbackItem[],
    model: ReviewModel,
  ): { response: ReviewResponse; droppedCount: number } | null {
    const paragraphAliases = new Map(request.targets.map((target, i) => [target.paragraphId, `P${i + 1}`]))
    const rubricAliases = new Map(request.rubric.items.map((item, i) => [item.itemId, `R${i + 1}`]))
    if (items.some((item) => item === null || typeof item !== 'object' ||
      !Array.isArray(item.appliedRubricItemIds) || item.stage !== request.stage ||
      !request.targets.some((target) => target.paragraphId === item.paragraphId))) return null
    const rawItems = items.map((item) => ({
      paragraph: paragraphAliases.get(item.paragraphId),
      perspective: item.perspective,
      severity: item.severity,
      body: item.body,
      rationale: item.rationale,
      rubricItems: item.appliedRubricItemIds.map((id) => rubricAliases.get(id)),
      ...(item.example === undefined ? {} : { example: item.example }),
    }))
    const validated = validateModelOutput(
      request,
      JSON.stringify({ summary, items: rawItems }),
      { modelId: model.modelId, promptVersion: model.promptVersion },
      newId,
    )
    return validated.ok && validated.dropped.length === 0
      ? { response: validated.response, droppedCount: 0 } : null
  }

  const service: ReviewService = {
    availability: (depth) => checkReviewAvailability({ online, model: modelFor(models, depth) }),

    async requestReview(input): Promise<ReviewSuccess | ReviewFailure> {
      // 어댑터를 고르는 것은 여기 한 줄뿐이다. 아래 흐름은 어느 모델인지 모른다 (`CLAUDE.md` §5).
      const model = modelFor(models, input.depth)

      const document = documents.getDocument(input.documentId)
      if (document === null) return blocked('unknown-document', '등록되지 않은 문서입니다.')

      const version = documents.latestVersion(document.id)
      if (version === null) {
        return blocked('no-version', '이 문서의 기록된 버전이 없습니다. 문서를 다시 등록해 주세요.')
      }

      const paragraphs = documents.listParagraphs(version.id).map((entry) => entry.paragraph)
      const resolved = resolveTargets(paragraphs, input.paragraphIds)
      if (!resolved.ok) return resolved

      const available = await checkReviewAvailability({ online, model })
      if (!available.available) return blocked(available.reason, available.message)

      const targetIds = new Set(resolved.targets.map((p) => p.uuid))
      const context = selectContext(paragraphs, targetIds)

      // 문장 범위: 대상 문단마다 문장을 하나까지 붙인다. 앵커는 이 요청의 기록에 함께 남는다.
      const sentences = input.sentences ?? []
      if (sentences.some((sentence) => !targetIds.has(sentence.paragraphId))) {
        return blocked('invalid-request', '검토 대상이 아닌 문단의 문장을 고를 수 없습니다.')
      }
      const sentenceByParagraph = new Map(sentences.map((s) => [s.paragraphId, s]))
      if (sentenceByParagraph.size !== sentences.length) {
        return blocked('invalid-request', '한 문단에 두 문장을 고를 수 없습니다.')
      }
      const sentenceAnchors = Object.fromEntries(sentences.map((s) => [s.paragraphId, s.anchorId]))

      // 재심에 실을 기존 피드백은 이번 검토 대상에 달렸던 것만 받는다 (PRD 4.3).
      const priorFeedback = input.priorFeedback ?? []
      if (priorFeedback.some((prior) => !targetIds.has(prior.paragraphId))) {
        return blocked('invalid-request', '검토 대상이 아닌 문단의 피드백은 함께 보낼 수 없습니다.')
      }

      // 검토는 평가 지침을 쓰지 않는다 ([Q-48]). 문서 종류를 싣고, 기록은 보고서의 검토 맥락에 잇는다.
      const reviewContext = { rubricVersion: deps.context.versionOf(document.id), items: [] as const }
      const documentKind = deps.context.kindOf(document.id)
      const run = async (): Promise<ReviewSuccess | ReviewFailure> => {
          const requestedAt = now()
          // 그림을 읽지 못해도 검토는 글만으로 이어 간다. 그림은 거드는 자료다.
          const images = await (deps.documentImages?.(document.id, version.id) ?? Promise.resolve([]))
            .catch((cause: unknown) => {
              console.error('검토에 실을 그림을 읽지 못했습니다', cause)
              return [] as readonly ReviewImage[]
            })
          const personal = deps.approvedGuidelines?.(document.id) ?? []
          const personalizationVersion = JSON.stringify(personal.map(g=>[g.id,g.revision,g.text]))
          const created = createReviewRequest({
            requestId: newId(),
            documentVersionId: version.id,
            scope: input.scope,
            stage: input.stage,
            perspectives: input.perspectives,
            images,
            targets: resolved.targets.map((p) => {
              const sentence = sentenceByParagraph.get(p.uuid)
              const target = { paragraphId: p.uuid, text: p.text, order: p.index }
              return sentence === undefined
                ? target
                : { ...target, sentenceRef: { index: sentence.index, text: sentence.text } }
            }),
            context: context.map((p) => ({ paragraphId: p.uuid, text: p.text, order: p.index })),
            rubric: reviewContext,
            documentKind,
            approvedGuidelines: personal.map(g=>g.text),
            priorFeedback,
          })
          if (!created.ok) return blocked('invalid-request', created.problems.join('\n'))

          const { request } = created
          // 캐시 키의 "지침" 자리에는 검토 맥락과 문서 종류를 함께 넣는다 ([Q-48]).
          // 사용자가 문서 종류를 고치면 같은 문단이라도 다시 묻는다 (`CLAUDE.md` §6).
          const cacheContext = request.documentKind === ''
            ? request.rubric.rubricVersion
            : `${request.rubric.rubricVersion}#${JSON.stringify(request.documentKind)}`
          // 실제로 나갈 그림만 센다. 총량 한도에 걸려 빠진 그림은 결과에 영향을 주지 않는다.
          const sentImages = toModelImages(request)
          const imagesHash = sentImages.length === 0
            ? null
            : JSON.stringify(sentImages.map((image) => [image.alias, image.mimeType, image.bytes.byteLength]))
          const recordBase: Omit<ReviewRecord, 'completedAt' | 'attempts'> = {
            requestId: request.requestId,
            documentId: document.id,
            versionId: version.id,
            rubricVersion: request.rubric.rubricVersion,
            scope: request.scope,
            stage: request.stage,
            perspectives: [...request.perspectives],
            targetParagraphIds: request.targets.map((t) => t.paragraphId),
            contextParagraphIds: request.context.map((c) => c.paragraphId),
            modelId: model.modelId,
            promptVersion: model.promptVersion,
            requestedAt,
            sentenceAnchors,
          }

          const responses: ReviewResponse[] = []
          const pendingCache: Parameters<ReviewCacheRepository['put']>[0][] = []
          const sentTargets = new Set<string>()
          const sentContext = new Set<string>()
          let attempts = 0
          let droppedCount = 0

          // 누락된 관점이 같은 문단만 묶는다. 이미 검토한 관점은 다시 분석하지 않는다.
          const groups = new Map<string, { perspectives: ReviewPerspective[]; targets: Paragraph[] }>()
          for (const paragraph of resolved.targets) {
            const missing: ReviewPerspective[] = []
            for (const perspective of request.perspectives) {
              const parts = cacheParts(paragraph, perspective, input,
                sentenceByParagraph.get(paragraph.uuid), cacheContext, personalizationVersion,
                model, imagesHash)
              const cached = cache.get(createCacheKey(parts))
              const restored = cached === null ? null : restoreCachedResponse(
                { ...request, targets: request.targets.filter((target) => target.paragraphId === paragraph.uuid),
                  perspectives: [perspective],
                  priorFeedback: request.priorFeedback.filter((prior) => prior.paragraphId === paragraph.uuid) },
                cached.summary, cached.items, model,
              )
              if (restored === null) missing.push(perspective)
              else responses.push(restored.response)
            }
            if (missing.length === 0) continue
            const groupKey = JSON.stringify([...missing].sort())
            const group = groups.get(groupKey) ?? { perspectives: missing, targets: [] }
            group.targets.push(paragraph)
            groups.set(groupKey, group)
          }

          for (const group of groups.values()) {
            const ids = new Set(group.targets.map((paragraph) => paragraph.uuid))
            const subRequest: ReviewRequest = {
              ...request,
              perspectives: group.perspectives,
              targets: request.targets.filter((target) => ids.has(target.paragraphId)),
              context: selectContext(paragraphs, ids).map((paragraph) => ({
                paragraphId: paragraph.uuid, text: paragraph.text, order: paragraph.index,
              })),
              priorFeedback: request.priorFeedback.filter((prior) => ids.has(prior.paragraphId)),
            }
            subRequest.targets.forEach((target) => sentTargets.add(target.paragraphId))
            subRequest.context.forEach((context) => sentContext.add(context.paragraphId))
            const executed = await callModel(subRequest, model)
            attempts += executed.attempts
            if (!executed.ok) {
              reviews.saveFailed({
                ...recordBase, attempts, completedAt: now(),
                sentTargetParagraphIds: [...sentTargets], sentContextParagraphIds: [...sentContext],
              }, { reason: executed.storageReason, message: executed.message })
              return { ok: false, reason: executed.reason, message: executed.message, requestId: request.requestId }
            }
            responses.push(executed.response)
            droppedCount += executed.droppedCount
            // 일부 항목을 버린 응답을 문제없는 결과로 캐시하지 않는다.
            if (executed.droppedCount !== 0) continue
            for (const paragraph of group.targets) {
              for (const perspective of group.perspectives) {
                const parts = cacheParts(paragraph, perspective, input,
                  sentenceByParagraph.get(paragraph.uuid), cacheContext, personalizationVersion,
                  model, imagesHash)
                pendingCache.push({
                  key: createCacheKey(parts), parts, summary: '이 문단의 검토 결과입니다.',
                  items: executed.response.items
                    .filter((item) => item.paragraphId === paragraph.uuid && item.perspective === perspective)
                    .map(({ itemId: _itemId, ...item }) => item),
                  createdAt: now(),
                })
              }
            }
          }

          const response = combineReviewResponses(request, responses, {
            modelId: model.modelId, promptVersion: model.promptVersion,
          })
          reviews.saveSucceeded({
            ...recordBase, attempts, completedAt: now(),
            sentTargetParagraphIds: [...sentTargets], sentContextParagraphIds: [...sentContext],
          }, response, droppedCount)
          // 최종 기록 저장이 성공한 뒤 캐시를 남긴다.
          pendingCache.forEach((entry) => cache.put(entry))
          return { ok: true, requestId: request.requestId, response, droppedCount, attempts }
      }
      return run()
    },

    listReviews: (documentId) => reviews.listReviews(documentId),
  }
  // 같은 문서의 동시 요청은 앞 요청의 캐시 저장 이후에 처리한다.
  const queues = new Map<string, Promise<unknown>>()
  return {
    ...service,
    requestReview(input) {
      const queued = (queues.get(input.documentId) ?? Promise.resolve())
        .catch(() => undefined).then(() => service.requestReview(input))
      queues.set(input.documentId, queued)
      void queued.finally(() => {
        if (queues.get(input.documentId) === queued) queues.delete(input.documentId)
      }).catch(() => undefined)
      return queued
    },
  }
}
