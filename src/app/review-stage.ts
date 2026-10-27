/**
 * 선택적 피드백의 단계 진행 제어 (PRD 3절 5~6번, 4.2).
 *
 * IMPLEMENTATION_PLAN.md §2.3 중 5단계 부분이다. 4단계가 "요청 하나를 모델에 보내는 길"이라면,
 * 여기는 **무엇을 대상으로, 어느 단계까지 열 수 있는지**를 정하는 곳이다.
 *
 * ```
 * 사용자가 범위·관점·단계 선택
 *   └→ 범위 해석: 문장 / 문단 / 보고서 항목 / 전체
 *        └→ 선행 작성 확인: 글이 없는 대상은 요청 자체를 만들지 않는다
 *             └→ 단계 순서 확인: 질문 → 약한 힌트 → 강한 힌트 → 설명 → 짧은 수정 예시
 *                  예시는 사용자가 **직접 요청했을 때만** 열린다
 *                  └→ (문장 범위면) 문장 앵커를 만들고
 *                       └→ 4단계 검토 요청 → 성공하면 그 대상의 단계를 하나 연다
 * ```
 *
 * 지키는 것
 * - **건너뛰기 금지.** 대상마다 어디까지 열었는지 저장하고, 그 다음 단계까지만 요청할 수 있다.
 *   이미 받은 단계를 다시 받는 것은 건너뛰기가 아니므로 허용한다.
 * - **예시는 명시 요청뿐.** `exampleRequested` 가 true 가 아니면 예시 단계로 가는 길이 없다.
 *   이 값은 사용자가 예시 버튼을 눌렀을 때만 들어온다. 다른 단계의 요청이 예시로 바뀌는 경로는 없다.
 * - **임의 연결 금지.** 문장 앵커를 다시 찾지 못하면 비슷한 문장에 붙이지 않고 "찾지 못했습니다" 상태로
 *   두고 사용자에게 확인을 요청한다. 다시 연결하는 것은 사용자가 문장을 직접 고를 때뿐이다.
 * - **대필 금지.** 이 모듈에는 본문을 고치거나 적용하는 길이 없다. 수정은 사용자가 한글에서 직접 한다.
 *
 * 판정은 전부 프로그램이 한다. 여기서 모델을 부르는 곳은 4단계 `ReviewService` 하나뿐이다.
 */
import type { AnchorRepository, SentenceAnchorRow } from '../adapters/repo/anchors.js'
import type { DocumentRepository, ParagraphInput } from '../adapters/repo/documents.js'
import type { ReviewRepository, StoredFeedbackItem, StoredReview } from '../adapters/repo/reviews.js'
import type { OutlineView } from '../shared/outline.js'
import { hasContent, type Paragraph } from '../core/document/model.js'
import { priorityScore } from '../core/priority/score.js'
import { rankByPriority, selectTopK, type Scored } from '../core/priority/topk.js'
import {
  createSentenceAnchor,
  resolveSentenceAnchor,
  splitSentences,
  type AnchorResolution,
  type Sentence,
  type SentenceAnchor,
} from '../core/document/sentence-anchor.js'
import {
  estimateSectionBoundaries,
  resolveSectionOverrides,
  sectionOverrideProblems,
  type SectionBoundary,
  type SectionOverride,
} from '../core/rubric/section-boundary.js'
import {
  INITIAL_VISIBLE_CARDS,
  type AnchorDecision,
  type AnchorState,
  type AnchorStatus,
  type AppliedRubricItem,
  type FeedbackCard,
  type ParagraphChoice,
  type RecommendedRequest,
  type ReviewPanel,
  type StagedReviewInput,
} from '../shared/feedback.js'
import {
  DEFAULT_REVIEW_DEPTH,
  REVIEW_DEPTHS,
  REVIEW_DEPTH_LABELS,
  REVIEW_PERSPECTIVES,
  REVIEW_STAGE_LABELS,
  REVIEW_STAGES,
  type ReviewScope,
  type ReviewStage,
} from '../shared/review.js'
import { NO_REPEATED_OBSERVATION, type RepeatedObservation } from '../shared/personalization.js'

import type {
  ReviewFailureReason,
  ReviewService,
  ReviewSuccess,
  SentenceTargetInput,
} from './review-request.js'
import type { RubricService } from './rubric.js'

// ---------------------------------------------------------------------------
// 단계 순서
// ---------------------------------------------------------------------------

export function stageIndex(stage: ReviewStage): number {
  return REVIEW_STAGES.indexOf(stage)
}

/** 이 단계 다음에 열 수 있는 단계. 마지막이면 null. */
export function nextStage(stage: ReviewStage | null): ReviewStage | null {
  const at = stage === null ? -1 : stageIndex(stage)
  return REVIEW_STAGES[at + 1] ?? null
}

/** 지금까지 연 단계 중 가장 깊은 것. 아직 없으면 null. */
export function deepestStage(granted: readonly ReviewStage[]): ReviewStage | null {
  let deepest: ReviewStage | null = null
  for (const stage of granted) {
    if (deepest === null || stageIndex(stage) > stageIndex(deepest)) deepest = stage
  }
  return deepest
}

export type StagePlan = { ok: true } | { ok: false; reason: StageBlockReason; message: string }

export type StageBlockReason = 'stage-locked' | 'example-not-requested'

export const EXAMPLE_NOT_REQUESTED_MESSAGE =
  '짧은 수정 예시는 직접 요청하셔야 열립니다. 다른 단계의 요청에는 예시가 들어가지 않습니다.'

/**
 * 이 대상에 이 단계를 열어도 되는가.
 *
 * @param granted 이 대상에 이미 연 단계
 * @param exampleRequested 사용자가 '짧은 수정 예시'를 직접 요청했는가
 */
export function planStage({
  granted,
  requested,
  exampleRequested,
}: {
  granted: readonly ReviewStage[]
  requested: ReviewStage
  exampleRequested: boolean
}): StagePlan {
  // 예시는 사용자가 직접 요청했을 때만 열린다 (PRD 4.2, `CLAUDE.md` §1).
  if (requested === 'example' && !exampleRequested) {
    return { ok: false, reason: 'example-not-requested', message: EXAMPLE_NOT_REQUESTED_MESSAGE }
  }

  const deepest = deepestStage(granted)
  const allowed = deepest === null ? stageIndex('question') : stageIndex(deepest) + 1
  if (stageIndex(requested) > allowed) {
    const next = REVIEW_STAGES[allowed]
    const nextLabel = next === undefined ? '' : REVIEW_STAGE_LABELS[next]
    return {
      ok: false,
      reason: 'stage-locked',
      message:
        deepest === null
          ? '검토는 질문 단계부터 시작합니다. 먼저 질문을 받아 보세요.'
          : `단계는 차례대로 열립니다. 지금은 '${nextLabel}' 까지 요청할 수 있습니다.`,
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 대상 키
// ---------------------------------------------------------------------------

/**
 * 단계 진행을 기록할 대상 키. 프로그램이 만든다.
 * 문장은 문단 uuid 와 문장 해시로 이어지므로, 문장이 문단 안에서 밀려도 같은 대상으로 이어진다.
 */
export function targetKeysOf(
  scope: ReviewScope,
  paragraphIds: readonly string[],
  sentenceHash: string | null,
): string[] {
  const first = paragraphIds[0]
  switch (scope) {
    case 'sentence':
      return first === undefined || sentenceHash === null ? [] : [`sentence:${first}:${sentenceHash}`]
    case 'paragraph':
      return paragraphIds.map((id) => `paragraph:${id}`)
    case 'section':
      return first === undefined ? [] : [`section:${first}`]
    case 'document':
      return ['document']
  }
}

// ---------------------------------------------------------------------------
// 서비스
// ---------------------------------------------------------------------------

export type StagedFailureReason = ReviewFailureReason | StageBlockReason | 'unknown-target'

export interface StagedFailure {
  ok: false
  reason: StagedFailureReason
  message: string
  requestId: string | null
}

export type StagedReviewResult = ReviewSuccess | StagedFailure

/** 심층 재검토 요청. 사용자가 카드의 '심층 재검토' 를 눌렀을 때만 들어온다. */
export interface ReReviewInput {
  documentId: string
  /** 다시 볼 피드백 */
  feedbackId: string
}

export type AnchorDecisionResult = { ok: true; anchor: AnchorState } | StagedFailure

export interface SaveSectionsResult {
  ok: true
  sections: SectionBoundary[]
}

export interface StagedReviewService {
  /** 검토 화면이 그릴 상태 전부. 오프라인이어도 저장된 기록은 그대로 보인다 */
  getPanel(documentId: string, options?: { includeAll?: boolean }): Promise<ReviewPanel | StagedFailure>
  requestStagedReview(input: StagedReviewInput): Promise<StagedReviewResult>
  /**
   * 이미 받은 피드백과 사용자 반박을 함께 보내 **심층으로 다시 본다** (PRD 4.3·4.4).
   * 대상·관점·단계는 그 피드백에서 가져오므로 사용자가 다시 고르지 않는다.
   */
  requestReReview(input: ReReviewInput): Promise<StagedReviewResult>
  /** 사용자가 고친 보고서 항목 경계를 저장한다. 빈 목록이면 추정으로 되돌린다 */
  saveSections(documentId: string, overrides: readonly SectionOverride[]): SaveSectionsResult | StagedFailure
  /** 찾지 못한 문장 앵커에 대한 사용자 확인 */
  decideAnchor(anchorId: string, decision: AnchorDecision): AnchorDecisionResult | StagedFailure
  /**
   * 사용자가 지우기로 한 피드백. 캐시 재사용으로 생긴 **같은 내용의 복제본**도 함께 지운다 —
   * 하나만 지우면 가려져 있던 복제본이 그 자리에 다시 나타난다.
   * 복제본에 따로 남긴 판단이 있으면 그 카드는 따로 보이던 것이므로 지우지 않는다.
   * 이미 연 단계(단계 순서 기록)는 지우지 않는다.
   */
  deleteFeedback(documentId: string, feedbackId: string): { ok: true; deletedCount: number } | StagedFailure
}

export interface StagedReviewDeps {
  documents: DocumentRepository
  reviews: ReviewRepository
  anchors: AnchorRepository
  rubric: RubricService
  review: ReviewService
  now: () => string
  newId: () => string
  /**
   * 8단계의 근거 있는 누적 관찰만 주입한다. 카드 수를 취약점 횟수로 세지 않는다.
   * 카드마다 근거(문서 버전)를 함께 붙인다. 주입하지 않으면 근거 없음으로 그린다 (T-8).
   */
  repeatedObservation?: (card: Pick<FeedbackCard, 'perspective' | 'appliedRubric'>) => RepeatedObservation
  /** 사용자 판단이 달린 과거 카드는 새 캐시 복제 카드로 가리지 않는다. */
  preserveFeedback?: (itemId: string) => boolean
  /**
   * 그 피드백에 사용자가 남긴 판단. 심층 재검토에 함께 보낸다 (PRD 4.4).
   * 주입하지 않으면 판단 없이 원 피드백만 보낸다.
   */
  userReaction?: (feedbackId: string) => { kind: string; reason: string } | null
  /** 문서 종류 ([Q-48]). 검토 화면 위에 보이고 사용자가 고친다 */
  profile?: (documentId: string) => { kind: string; source: 'ai' | 'user' } | null
  /** 검토 화면에 줄 목차 ([Q-47]). 주입하지 않으면 목차 없이 그린다 (화면이 번호 규칙으로 만든다) */
  outline?: (documentId: string, paragraphs: readonly ParagraphChoice[]) => OutlineView
}

function fail(reason: StagedFailureReason, message: string): StagedFailure {
  return { ok: false, reason, message, requestId: null }
}

/**
 * 선행 작성 확인에 걸렸을 때의 안내 (`CLAUDE.md` §1).
 * 4단계에도 같은 관문이 있지만(`review-request.ts`), 범위를 푸는 이 단계에서 먼저 막는다.
 * 그래야 문장·항목·전체 범위처럼 문단 목록으로 풀리기 전의 대상도 같은 이유로 막힌다.
 */
export const NO_CONTENT_MESSAGE =
  '아직 글로 쓴 내용이 없는 대상은 검토를 요청할 수 없습니다. 한글에서 먼저 작성하고 저장해 주세요.'

const ANCHOR_MESSAGE: Readonly<Record<string, string>> = {
  'paragraph-missing':
    '이 피드백이 가리키던 문단을 지금 문서에서 찾지 못했습니다. 어느 문장을 가리키는지 확인해 주세요.',
  'sentence-missing':
    '이 피드백이 가리키던 문장을 찾지 못했습니다. 어느 문장을 가리키는지 확인해 주세요.',
  ambiguous:
    '똑같은 문장이 여럿이라 어느 문장을 가리켰는지 정할 수 없습니다. 어느 문장인지 확인해 주세요.',
}

const CONFIRMED_LOST_MESSAGE = '가리키던 문장을 찾지 못한 채로 두기로 확인하셨습니다.'

/**
 * 같은 피드백인지 가르는 열쇠. 캐시를 다시 써서 같은 내용이 여러 번 저장되면 한 카드로만 보인다.
 * @param before 요청 당시 그 문단의 글
 */
function feedbackIdentity(stored: StoredReview, item: StoredFeedbackItem, before: string | null): string {
  return JSON.stringify([item.paragraphId, before, stored.rubricVersion, stored.scope,
    item.sentenceRef ?? null, item.perspective, item.stage, item.body, item.rationale,
    item.severity, item.example ?? null, item.appliedRubricItemIds])
}

/** 접힌 카드에 보여 줄 한 줄. 본문의 첫 문장만 쓰고, 없으면 본문을 그대로 쓴다. */
function summarize(body: string): string {
  return splitSentences(body)[0]?.text ?? body
}

export function createStagedReviewService(deps: StagedReviewDeps): StagedReviewService {
  const { documents, reviews, anchors, rubric, review, now, newId } = deps

  function paragraphsOfLatest(documentId: string): { versionId: string; ordinal: number; paragraphs: Paragraph[] } | null {
    const version = documents.latestVersion(documentId)
    if (version === null) return null
    return {
      versionId: version.id,
      ordinal: version.ordinal,
      paragraphs: documents.listParagraphs(version.id).map((entry: ParagraphInput) => entry.paragraph),
    }
  }

  /** 최신 버전에서 바뀐 문단. "변경된 곳만 검토" 가 쓴다 ([Q-37]). */
  function changedIn(versionId: string): Set<string> {
    return new Set(documents.listDiffEntries(versionId)
      .filter(entry => entry.change !== 'deleted')
      .map(entry => entry.paragraphUuid))
  }

  /**
   * 프로그램이 정하는 요청 조건 ([Q-37], [Q-41]).
   *
   * 관점은 **사용자가 고르지 않는다.** 확정한 지침의 모든 항목에서 프로그램이 읽는다 (AI 없음).
   * 단계는 질문부터다. 단계를 올리는 것은 카드에서 사용자가 한다.
   */
  /**
   * 추천 요청. 검토는 평가 지침을 쓰지 않으므로([Q-48]) 모든 관점으로 보고, 문서 종류는 프롬프트가 싣는다.
   */
  function recommend(): RecommendedRequest {
    return { perspectives: [...REVIEW_PERSPECTIVES], stage: 'question',
      reason: '문서 종류에 맞춰 모든 관점으로 검토합니다.' }
  }

  /** 저장된 앵커를 지금 문단에 비춰 본다. 판정은 코어가 하고, 여기서는 상태와 문구만 붙인다. */
  function anchorState(anchor: SentenceAnchorRow, paragraphs: readonly Paragraph[]): AnchorState {
    const paragraph = paragraphs.find((p) => p.uuid === anchor.paragraphUuid) ?? null
    const stored: SentenceAnchor = {
      paragraphUuid: anchor.paragraphUuid,
      sentenceIndex: anchor.sentenceIndex,
      text: anchor.text,
      offset: anchor.offset,
      hash: anchor.hash,
    }
    const resolution: AnchorResolution = resolveSentenceAnchor(stored, paragraph)
    const candidates = paragraph === null ? [] : splitSentences(paragraph.text)

    if (resolution.status === 'found') {
      if (anchor.status !== 'linked' || anchor.sentenceIndex !== resolution.sentenceIndex) {
        anchors.updateAnchor(
          anchor.anchorId,
          {
            sentenceIndex: resolution.sentenceIndex,
            offset: resolution.offset,
            text: resolution.text,
            hash: anchor.hash,
            status: 'linked',
          },
          now(),
        )
      }
      return {
        anchorId: anchor.anchorId,
        text: resolution.text,
        status: 'linked',
        sentenceIndex: resolution.sentenceIndex,
        message: resolution.moved ? '문단 안에서 위치가 바뀐 같은 문장에 이어져 있습니다.' : '',
        needsConfirmation: false,
        candidates,
      }
    }

    // 찾지 못했다. 비슷한 문장에 붙이지 않는다 (PRD 4.2, T-23).
    const status: AnchorStatus = anchor.status === 'confirmed-lost' ? 'confirmed-lost' : 'unresolved'
    if (anchor.status !== status) {
      anchors.updateAnchor(
        anchor.anchorId,
        {
          sentenceIndex: anchor.sentenceIndex,
          offset: anchor.offset,
          text: anchor.text,
          hash: anchor.hash,
          status,
        },
        now(),
      )
    }
    return {
      anchorId: anchor.anchorId,
      text: anchor.text,
      status,
      sentenceIndex: null,
      message:
        status === 'confirmed-lost'
          ? CONFIRMED_LOST_MESSAGE
          : (ANCHOR_MESSAGE[resolution.reason] ?? '이 피드백이 가리키던 문장을 찾지 못했습니다.'),
      needsConfirmation: status === 'unresolved',
      candidates,
    }
  }

  /** 사용자가 고친 경계가 있으면 그것을, 쓸 수 없으면 추정을 쓴다. */
  function sectionsOf(
    documentId: string,
    paragraphs: readonly Paragraph[],
  ): { sections: SectionBoundary[]; notice: string } {
    // 항목 경계도 평가 지침에 기대지 않는다 ([Q-48]). 제목 스타일로만 추정한다.
    const estimated = estimateSectionBoundaries(paragraphs, [])

    const overrides = anchors.listSections(documentId)
    if (overrides.length === 0) return { sections: estimated, notice: '' }

    const resolved = resolveSectionOverrides(
      paragraphs,
      overrides.map((row) => ({
        ordinal: row.ordinal,
        title: row.title,
        startParagraphUuid: row.startParagraphUuid,
        endParagraphUuid: row.endParagraphUuid,
      })),
    )
    if (resolved !== null) return { sections: resolved, notice: '' }

    return {
      sections: estimated,
      notice:
        '문서가 바뀌어 직접 고치신 항목 경계를 그대로 쓸 수 없었습니다. 다시 추정한 경계를 보여 드립니다. 필요하면 다시 고쳐 주세요.',
    }
  }

  /** 범위에 따라 검토 대상을 고른다. 글이 없는 대상에는 요청을 만들지 않는다 (`CLAUDE.md` §1). */
  function resolveScope(
    input: StagedReviewInput,
    paragraphs: readonly Paragraph[],
    sections: readonly SectionBoundary[],
  ): { ok: true; targets: Paragraph[]; sentence: (Sentence & { paragraph: Paragraph }) | null } | StagedFailure {
    switch (input.scope) {
      case 'sentence': {
        const chosen = input.sentence
        if (chosen === undefined) return fail('invalid-request', '검토할 문장을 골라 주세요.')
        const paragraph = paragraphs.find((p) => p.uuid === chosen.paragraphId)
        if (paragraph === undefined) {
          return fail('unknown-target', '고른 문단을 최신 버전에서 찾지 못했습니다. 다시 골라 주세요.')
        }
        if (!hasContent(paragraph)) return fail('no-content', NO_CONTENT_MESSAGE)

        const sentence = splitSentences(paragraph.text)[chosen.sentenceIndex]
        if (sentence === undefined) {
          return fail('unknown-target', '고른 문장을 찾지 못했습니다. 문장을 다시 골라 주세요.')
        }
        return { ok: true, targets: [paragraph], sentence: { ...sentence, paragraph } }
      }

      case 'paragraph': {
        const ids = input.paragraphIds ?? []
        if (ids.length === 0) return fail('invalid-request', '검토할 문단을 하나 이상 골라 주세요.')

        const targets: Paragraph[] = []
        for (const id of ids) {
          const paragraph = paragraphs.find((p) => p.uuid === id)
          if (paragraph === undefined) {
            return fail('unknown-target', '고른 문단을 최신 버전에서 찾지 못했습니다. 다시 골라 주세요.')
          }
          // 사용자가 직접 고른 문단이므로 조용히 빼지 않고 이유를 알린다.
          if (!hasContent(paragraph)) return fail('no-content', NO_CONTENT_MESSAGE)
          targets.push(paragraph)
        }
        return { ok: true, targets, sentence: null }
      }

      case 'section': {
        const section = sections.find((s) => s.ordinal === input.sectionOrdinal)
        if (section === undefined) return fail('unknown-target', '고른 보고서 항목을 찾지 못했습니다.')
        const targets = paragraphs
          .slice(section.startIndex, section.endIndex + 1)
          .filter((paragraph) => hasContent(paragraph))
        if (targets.length === 0) return fail('no-content', NO_CONTENT_MESSAGE)
        return { ok: true, targets, sentence: null }
      }

      case 'document': {
        const targets = paragraphs.filter((paragraph) => hasContent(paragraph))
        if (targets.length === 0) return fail('no-content', NO_CONTENT_MESSAGE)
        return { ok: true, targets, sentence: null }
      }
    }
  }

  function grantsOf(documentId: string): Map<string, ReviewStage[]> {
    const byKey = new Map<string, ReviewStage[]>()
    for (const grant of anchors.listGrants(documentId)) {
      const list = byKey.get(grant.targetKey) ?? []
      list.push(grant.stage)
      byKey.set(grant.targetKey, list)
    }
    return byKey
  }

  function buildCards(documentId: string, latest: { versionId: string; paragraphs: Paragraph[] }): Scored<FeedbackCard>[] {
    const anchorById = new Map(anchors.listAnchors(documentId).map((row) => [row.anchorId, row]))
    const grants = grantsOf(documentId)
    const numbers = new Map(latest.paragraphs.map((paragraph, position) => [paragraph.uuid, position + 1]))
    const latestText = new Map(latest.paragraphs.map((paragraph) => [paragraph.uuid, paragraph.text]))

    // 지침 항목 이름은 그 요청에 실린 지침 버전에서 찾는다.
    const editor = rubric.getEditor(documentId)
    const rubricItems = new Map<string, Map<string, AppliedRubricItem>>()
    if (editor.ok) {
      for (const version of editor.state.history) {
        rubricItems.set(
          version.rubricVersion,
          new Map(
            version.items.map((item) => [
              item.itemId,
              { itemId: item.itemId, title: item.title, importance: item.importance },
            ]),
          ),
        )
      }
    }

    const versionTexts = new Map<string, Map<string, string>>()
    function textsOfVersion(versionId: string): Map<string, string> {
      const known = versionTexts.get(versionId)
      if (known !== undefined) return known
      const texts = new Map(
        documents.listParagraphs(versionId).map((entry) => [entry.paragraph.uuid, entry.paragraph.text]),
      )
      versionTexts.set(versionId, texts)
      return texts
    }

    // 반복 관찰 근거는 아래에서 한 번에 붙인다. 여기서는 아직 없다.
    const cards: Omit<FeedbackCard, 'repeatedObservation'>[] = []
    const seen = new Set<string>()
    for (const stored of reviews.listReviews(documentId).reverse()) {
      if (stored.status !== 'succeeded') continue

      const anchorRow =
        stored.items
          .map((item: StoredFeedbackItem) => item.sentenceAnchorId)
          .find((id): id is string => id !== null) ?? null
      const sentenceKey = anchorRow === null ? null : (anchorById.get(anchorRow)?.hash ?? null)
      const [firstKey] = targetKeysOf(stored.scope, stored.targetParagraphIds, sentenceKey)

      const requestKeys: string[] = []
      for (const item of stored.items) {
        const anchor = item.sentenceAnchorId === null ? null : anchorById.get(item.sentenceAnchorId)
        const targetKey =
          stored.scope === 'paragraph'
            ? `paragraph:${item.paragraphId}`
            : (firstKey ?? `paragraph:${item.paragraphId}`)

        const before = textsOfVersion(stored.versionId).get(item.paragraphId) ?? null
        const after = latestText.get(item.paragraphId) ?? null
        const granted = grants.get(targetKey) ?? []
        const identity = feedbackIdentity(stored, item, before)
        if (seen.has(identity) && !deps.preserveFeedback?.(item.itemId)) continue
        requestKeys.push(identity)

        cards.push({
          itemId: item.itemId,
          requestId: stored.requestId,
          paragraphId: item.paragraphId,
          paragraphNumber: numbers.get(item.paragraphId) ?? null,
          perspective: item.perspective,
          stage: item.stage,
          severity: item.severity,
          summary: summarize(item.body),
          body: item.body,
          rationale: item.rationale,
          // 예시는 예시 단계에서만 존재한다. 다른 단계의 카드에는 언제나 null 이다.
          example: item.stage === 'example' ? (item.example ?? null) : null,
          appliedRubric: item.appliedRubricItemIds.map(
            (itemId) =>
              rubricItems.get(stored.rubricVersion)?.get(itemId) ?? {
                itemId,
                title: '(이 지침 항목을 찾지 못했습니다)',
                importance: 0,
              },
          ),
          requestedAt: stored.requestedAt,
          scope: stored.scope,
          anchor: anchor === undefined || anchor === null ? null : anchorState(anchor, latest.paragraphs),
          revision:
            before !== null && after !== null && before !== after ? { before, after } : null,
          grantedStages: [...granted].sort((a, b) => stageIndex(a) - stageIndex(b)),
          nextStage: nextStage(deepestStage(granted)),
          nextStageNeedsRequest: nextStage(deepestStage(granted)) === 'example',
          targetKey,
        })
      }
      requestKeys.forEach((key) => seen.add(key))
    }

    // 반복 관찰 근거는 카드를 다 만든 뒤에 붙인다. 그래야 점수와 화면이 같은 값을 본다.
    return cards.map((card) => {
      const repeated = deps.repeatedObservation?.(card) ?? NO_REPEATED_OBSERVATION
      const value = { ...card, repeatedObservation: repeated }
      return {
        value,
        score: priorityScore({
          rubricImportance: Math.max(0, ...card.appliedRubric.map((item) => item.importance)),
          severity: card.severity,
          repeatedWeaknessCount: repeated.count,
          perspectiveMatch: 5,
        }),
      }
    })
  }

  return {
    async getPanel(documentId, options): Promise<ReviewPanel | StagedFailure> {
      const document = documents.getDocument(documentId)
      if (document === null) return fail('unknown-document', '등록되지 않은 문서입니다.')

      // 검토 요청 바만 잠근다. 아래 목록과 경계 편집은 오프라인·키 미등록에서도 그대로 쓴다 (PRD 5절).
      // 깊이마다 따로 묻는다. 심층을 쓸 수 없어도 빠른 검토는 그대로 열려 있어야 한다 (PRD 4.3).
      const depthStates = await Promise.all(
        REVIEW_DEPTHS.map(async (depth) => ({ depth, state: await review.availability(depth) })),
      )
      const availability =
        depthStates.find((entry) => entry.depth === DEFAULT_REVIEW_DEPTH)?.state ??
        ({ available: false, reason: 'offline', message: '검토 깊이를 확인하지 못했습니다.' } as const)
      // 키체인 확인을 기다리는 사이 저장된 문서·지침도 같은 최신 스냅샷으로 그린다.
      const latest = paragraphsOfLatest(documentId)
      const paragraphs = latest?.paragraphs ?? []
      // 검토는 평가 지침 확정을 기다리지 않는다 ([Q-48]). 연결만 되면 요청할 수 있다.
      const unavailable = availability.available ? '' : availability.message

      const changed = latest === null ? new Set<string>() : changedIn(latest.versionId)
      const choices: ParagraphChoice[] = paragraphs.map((paragraph, position) => ({
        paragraphId: paragraph.uuid,
        number: position + 1,
        text: paragraph.text,
        hasContent: hasContent(paragraph),
        role: paragraph.role,
        // 표 안 문단은 칸 위치를 함께 넘긴다.
        table: paragraph.table === null ? null : { ...paragraph.table },
        sentences: splitSentences(paragraph.text),
        // 수식만 있는 문단도 있으므로 글과 함께 넘긴다.
        equations: [...paragraph.equations],
        changed: changed.has(paragraph.uuid),
      }))
      const { sections, notice } = sectionsOf(documentId, paragraphs)
      const all = latest === null ? [] : buildCards(documentId, latest)
      const visible =
        options?.includeAll === true
          ? rankByPriority(all).map(({ value }) => value)
          : selectTopK(all, INITIAL_VISIBLE_CARDS).map(({ value }) => value)

      return {
        documentId,
        documentName: document.displayName,
        depths: depthStates.map(({ depth, state }) => ({
          depth,
          label: REVIEW_DEPTH_LABELS[depth],
          available: state.available,
          unavailableMessage: state.available ? '' : state.message,
        })),
        versionOrdinal: latest?.ordinal ?? null,
        requestAvailable: unavailable === '',
        unavailableMessage: unavailable,
        // 예전 화면과의 호환을 위해 남긴 값. 검토는 지침을 기다리지 않는다 ([Q-48]).
        rubricConfirmed: true,
        readyExceptRubric: false,
        ...(deps.profile === undefined ? {} : { profile: deps.profile(documentId) }),
        paragraphs: choices,
        sections,
        // 목차 ([Q-47]). 저장된 AI 목차를 지금 문단 위에서 다시 계산한다. 모델을 부르지 않는다.
        ...(deps.outline === undefined ? {} : { outline: deps.outline(documentId, choices) }),
        sectionNotice: notice,
        cards: visible,
        hiddenCount: all.length - visible.length,
        recommended: recommend(),
      }
    },

    async requestStagedReview(input): Promise<StagedReviewResult> {
      const document = documents.getDocument(input.documentId)
      if (document === null) return fail('unknown-document', '등록되지 않은 문서입니다.')

      const latest = paragraphsOfLatest(input.documentId)
      if (latest === null) {
        return fail('no-version', '이 문서의 기록된 버전이 없습니다. 문서를 다시 등록해 주세요.')
      }

      const { sections } = sectionsOf(input.documentId, latest.paragraphs)
      const scoped = resolveScope(input, latest.paragraphs, sections)
      if (!scoped.ok) return scoped

      const anchorInput =
        scoped.sentence === null
          ? null
          : createSentenceAnchor({
              paragraphUuid: scoped.sentence.paragraph.uuid,
              paragraphText: scoped.sentence.paragraph.text,
              sentenceIndex: scoped.sentence.index,
            })
      if (scoped.sentence !== null && anchorInput === null) {
        return fail('unknown-target', '고른 문장을 찾지 못했습니다. 문장을 다시 골라 주세요.')
      }

      // 단계 순서 확인. 대상이 여럿이면 가장 덜 열린 대상에 맞춘다.
      const keys = targetKeysOf(
        input.scope,
        scoped.targets.map((paragraph) => paragraph.uuid),
        anchorInput?.hash ?? null,
      )
      if (keys.length === 0) return fail('unknown-target', '검토 대상을 정하지 못했습니다.')

      const grants = grantsOf(input.documentId)
      for (const key of keys) {
        const plan = planStage({
          granted: grants.get(key) ?? [],
          requested: input.stage,
          exampleRequested: input.exampleRequested === true,
        })
        if (!plan.ok) return fail(plan.reason, plan.message)
      }

      // 앵커는 요청 전에 만든다. 피드백이 이 앵커에 달리기 때문이다. 요청이 실패하면 다시 치운다.
      let anchorId: string | null = null
      if (anchorInput !== null) {
        const timestamp = now()
        anchorId = newId()
        anchors.addAnchor({
          anchorId,
          documentId: input.documentId,
          versionId: latest.versionId,
          paragraphUuid: anchorInput.paragraphUuid,
          sentenceIndex: anchorInput.sentenceIndex,
          text: anchorInput.text,
          offset: anchorInput.offset,
          hash: anchorInput.hash,
          status: 'linked',
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      }

      const sentences: SentenceTargetInput[] =
        anchorInput === null || anchorId === null
          ? []
          : [
              {
                paragraphId: anchorInput.paragraphUuid,
                index: anchorInput.sentenceIndex,
                text: anchorInput.text,
                anchorId,
              },
            ]

      const result = await review.requestReview({
        documentId: input.documentId,
        depth: input.depth ?? DEFAULT_REVIEW_DEPTH,
        paragraphIds: scoped.targets.map((paragraph) => paragraph.uuid),
        scope: input.scope,
        // 새 요청은 관점을 싣지 않는다. 확정한 지침으로 여기서 정한다 ([Q-41]).
        perspectives: input.perspectives ?? [...REVIEW_PERSPECTIVES],
        stage: input.stage,
        sentences,
      })

      if (!result.ok) {
        if (anchorId !== null) anchors.deleteAnchorIfUnused(anchorId)
        return result
      }

      const grantedAt = now()
      for (const key of keys) {
        anchors.grantStage({ documentId: input.documentId, targetKey: key, stage: input.stage, grantedAt })
      }
      return result
    },

    /**
     * 심층 재검토 (PRD 4.3 "Gemma 피드백에 대한 재심, 사용자 반박의 재검토", 4.4).
     *
     * 사용자가 이미 받은 피드백 하나를 가리켜 "다시 봐 달라" 고 할 때만 들어온다.
     * - 대상·관점은 그 피드백에서 가져온다. 사용자가 다시 고르지 않는다.
     * - **단계를 새로 열지 않는다.** 이미 받은 단계를 같은 깊이로 다시 보는 것이므로
     *   단계 순서 판정을 지나지 않고, 통과해도 새 단계를 열어 주지 않는다.
     * - 원 피드백이 **예시 단계**였으면 설명 단계로 낮춰 다시 본다. 예시는 사용자가
     *   명시적으로 요청했을 때만 나오는 것이라, 재검토가 예시를 다시 만들어 내지 않게 한다
     *   (`CLAUDE.md` §1).
     * - 원 피드백과 사용자 판단을 함께 보낸다. AI 판단이 사용자 판단을 덮어쓰지 못하게,
     *   두 기록은 저장소에 그대로 남는다.
     */
    async requestReReview(input): Promise<StagedReviewResult> {
      const document = documents.getDocument(input.documentId)
      if (document === null) return fail('unknown-document', '등록되지 않은 문서입니다.')

      const item = reviews
        .listReviews(input.documentId)
        .flatMap((review) => (review.status === 'succeeded' ? review.items : []))
        .find((candidate) => candidate.itemId === input.feedbackId)
      if (item === undefined) return fail('unknown-target', '다시 볼 피드백을 찾지 못했습니다.')

      const latest = paragraphsOfLatest(input.documentId)
      if (latest === null) {
        return fail('no-version', '이 문서의 기록된 버전이 없습니다. 문서를 다시 등록해 주세요.')
      }
      const paragraph = latest.paragraphs.find((candidate) => candidate.uuid === item.paragraphId)
      if (paragraph === undefined) {
        return fail(
          'unknown-target',
          '이 피드백이 가리키던 문단을 지금 문서에서 찾지 못했습니다. 문서를 저장한 뒤 다시 요청해 주세요.',
        )
      }
      if (!hasContent(paragraph)) return fail('no-content', NO_CONTENT_MESSAGE)

      const reaction = deps.userReaction?.(item.itemId) ?? null
      // 예시 단계는 설명 단계로 낮춘다. 재검토가 예시를 만들어 내지 않게 한다 (PRD 4.2).
      const stage: ReviewStage = item.stage === 'example' ? 'explanation' : item.stage

      return review.requestReview({
        documentId: input.documentId,
        depth: 'deep',
        paragraphIds: [paragraph.uuid],
        scope: 'paragraph',
        perspectives: [item.perspective],
        stage,
        priorFeedback: [
          {
            paragraphId: paragraph.uuid,
            perspective: item.perspective,
            stage: item.stage,
            body: item.body,
            rationale: item.rationale,
            reaction: reaction?.kind ?? '',
            reactionReason: reaction?.reason ?? '',
          },
        ],
      })
    },

    saveSections(documentId, overrides): SaveSectionsResult | StagedFailure {
      if (documents.getDocument(documentId) === null) {
        return fail('unknown-document', '등록되지 않은 문서입니다.')
      }
      const latest = paragraphsOfLatest(documentId)
      const paragraphs = latest?.paragraphs ?? []

      // 빈 목록은 "사용자 수정을 지우고 추정으로 돌아가겠다" 는 뜻이다.
      if (overrides.length === 0) {
        anchors.replaceSections(documentId, [])
        return { ok: true, sections: sectionsOf(documentId, paragraphs).sections }
      }

      const problems = sectionOverrideProblems(paragraphs, overrides)
      if (problems.length > 0) return fail('invalid-request', problems.join('\n'))

      const updatedAt = now()
      anchors.replaceSections(
        documentId,
        overrides.map((override) => ({
          ordinal: override.ordinal,
          title: override.title,
          startParagraphUuid: override.startParagraphUuid,
          endParagraphUuid: override.endParagraphUuid,
          updatedAt,
        })),
      )
      return { ok: true, sections: sectionsOf(documentId, paragraphs).sections }
    },

    deleteFeedback(documentId, feedbackId): { ok: true; deletedCount: number } | StagedFailure {
      const stored = reviews.listReviews(documentId)
      const textsCache = new Map<string, Map<string, string>>()
      const before = (review: StoredReview, paragraphId: string): string | null => {
        let texts = textsCache.get(review.versionId)
        if (texts === undefined) {
          texts = new Map(documents.listParagraphs(review.versionId).map((e) => [e.paragraph.uuid, e.paragraph.text]))
          textsCache.set(review.versionId, texts)
        }
        return texts.get(paragraphId) ?? null
      }
      const all = stored.flatMap((review) => review.status === 'succeeded'
        ? review.items.map((item) => ({ review, item })) : [])
      const target = all.find(({ item }) => item.itemId === feedbackId)
      if (target === undefined) return fail('unknown-target', '지울 피드백을 찾지 못했습니다.')
      const identity = feedbackIdentity(target.review, target.item, before(target.review, target.item.paragraphId))
      const ids = all
        .filter(({ review, item }) => item.itemId === feedbackId || (
          !(deps.preserveFeedback?.(item.itemId) ?? false)
          && feedbackIdentity(review, item, before(review, item.paragraphId)) === identity))
        .map(({ item }) => item.itemId)
      reviews.deleteFeedbackItems(ids)
      return { ok: true, deletedCount: ids.length }
    },

    decideAnchor(anchorId, decision): AnchorDecisionResult | StagedFailure {
      const anchor = anchors.getAnchor(anchorId)
      if (anchor === null) return fail('unknown-target', '이 피드백의 문장 기록을 찾지 못했습니다.')

      const latest = paragraphsOfLatest(anchor.documentId)
      const paragraphs = latest?.paragraphs ?? []

      if (decision.choice === 'keep-lost') {
        anchors.updateAnchor(
          anchorId,
          {
            sentenceIndex: anchor.sentenceIndex,
            offset: anchor.offset,
            text: anchor.text,
            hash: anchor.hash,
            status: 'confirmed-lost',
          },
          now(),
        )
        const updated = anchors.getAnchor(anchorId)
        if (updated === null) return fail('unknown-target', '이 피드백의 문장 기록을 찾지 못했습니다.')
        return { ok: true, anchor: anchorState(updated, paragraphs) }
      }

      // 다시 연결은 사용자가 고른 문장에만 한다. 프로그램이 비슷한 문장을 찾아 붙이지 않는다.
      const paragraph = paragraphs.find((p) => p.uuid === anchor.paragraphUuid)
      if (paragraph === undefined) {
        return fail('unknown-target', '이 피드백이 가리키던 문단이 지금 문서에 없어 다시 연결할 수 없습니다.')
      }
      const chosen = createSentenceAnchor({
        paragraphUuid: paragraph.uuid,
        paragraphText: paragraph.text,
        sentenceIndex: decision.sentenceIndex,
      })
      if (chosen === null) return fail('unknown-target', '고르신 문장을 찾지 못했습니다.')

      anchors.updateAnchor(
        anchorId,
        {
          sentenceIndex: chosen.sentenceIndex,
          offset: chosen.offset,
          text: chosen.text,
          hash: chosen.hash,
          status: 'linked',
        },
        now(),
      )
      const updated = anchors.getAnchor(anchorId)
      if (updated === null) return fail('unknown-target', '이 피드백의 문장 기록을 찾지 못했습니다.')
      return { ok: true, anchor: anchorState(updated, paragraphs) }
    },
  }
}
