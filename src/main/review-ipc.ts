/**
 * 선택적 피드백의 메인 프로세스 쪽 처리 (PRD 3절 5~6번, 4.2).
 *
 * 렌더러가 보낸 값은 믿지 않는다. 형태를 확인한 뒤 유스케이스로 넘긴다.
 * 범위·관점·단계 판정과 단계 순서 강제는 `app/review-stage.ts` 가 한다. 여기서는 형태만 본다.
 *
 * **예시 단계는 `exampleRequested === true` 일 때만 통과한다.** 렌더러가 다른 값을 보내면
 * 그대로 false 로 읽는다. 예시가 새는 길은 여기에도 없다.
 *
 * electron 을 import 하지 않는다. 그래야 Electron 없이 테스트할 수 있다.
 */
import type { StagedReviewService } from '../app/review-stage.js'
import type { AnchorDecision, SectionOverride, StagedReviewInput } from '../shared/feedback.js'
import type {
  DecideSentenceAnchorResult,
  DeleteResult,
  AnalyzeOutlineResult,
  SetDocumentKindResult,
  ReReviewResultView,
  ReviewPanelResult,
  SaveSectionBoundariesResult,
  StagedReviewResultView,
} from '../shared/ipc.js'
import {
  REVIEW_DEPTHS,
  REVIEW_PERSPECTIVES,
  REVIEW_SCOPES,
  REVIEW_STAGES,
  type ReviewPerspective,
} from '../shared/review.js'

export interface ReviewIpcDeps {
  staged: StagedReviewService
  /** 목차 나누기 ([Q-47]). 없으면 화면은 번호 규칙 목차만 쓴다 */
  outline?: { analyze(documentId: string): Promise<{ ok: true; count: number; modelId: string } | { ok: false; message: string }> }
  /** 문서 종류를 고친다 ([Q-48]) */
  setDocumentKind?: (documentId: string, kind: string) => { ok: true } | { ok: false; message: string }
  /** 되돌릴 수 없는 일(피드백 삭제) 전에 묻는다. @returns 확인을 눌렀으면 true */
  confirm?: (request: { message: string; detail: string; confirmLabel: string }) => Promise<boolean>
}

/** 렌더러에서 온 값을 그대로 받는다. 형태 확인은 여기서 한다. */
export interface ReviewHandlers {
  getReviewPanel(documentId: unknown, includeAll: unknown): Promise<ReviewPanelResult>
  requestStagedReview(input: unknown): Promise<StagedReviewResultView>
  /** 이미 받은 피드백 하나를 심층으로 다시 본다 (PRD 4.3·4.4) */
  requestReReview(documentId: unknown, feedbackId: unknown): Promise<ReReviewResultView>
  saveSectionBoundaries(documentId: unknown, overrides: unknown): Promise<SaveSectionBoundariesResult>
  decideSentenceAnchor(anchorId: unknown, decision: unknown): Promise<DecideSentenceAnchorResult>
  /** 확인을 받은 뒤 피드백 하나를 지운다 */
  deleteFeedback(documentId: unknown, feedbackId: unknown): Promise<DeleteResult>
  analyzeOutline(documentId: unknown): Promise<AnalyzeOutlineResult>
  setDocumentKind(documentId: unknown, kind: unknown): SetDocumentKindResult
}

const UNKNOWN_DOCUMENT = { status: 'failed', message: '검토할 문서를 알 수 없습니다.' } as const
const MALFORMED_INPUT = { status: 'failed', message: '검토 요청을 읽지 못했습니다.' } as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** 렌더러가 보낸 검토 요청의 형태를 확인한다. 형태가 틀리면 null. */
export function parseStagedReviewInput(value: unknown): StagedReviewInput | null {
  if (!isRecord(value)) return null

  const { documentId, scope, perspectives, stage } = value
  if (typeof documentId !== 'string' || documentId === '') return null
  if (!isOneOf(REVIEW_SCOPES, scope)) return null
  if (!isOneOf(REVIEW_STAGES, stage)) return null
  // 관점은 새 요청에 없다 (프로그램이 정한다, [Q-41]). 카드에서 단계를 이어 갈 때만 온다.
  if (perspectives !== undefined && !Array.isArray(perspectives)) return null

  const chosen: ReviewPerspective[] = []
  for (const perspective of (perspectives ?? []) as unknown[]) {
    if (!isOneOf(REVIEW_PERSPECTIVES, perspective)) return null
    chosen.push(perspective)
  }

  // 깊이를 고르지 않았거나 모르는 값이면 빠른 검토다. 심층이 기본이 되는 길은 없다 (PRD 4.3).
  const depth = value['depth']

  const input: StagedReviewInput = {
    documentId,
    scope,
    ...(perspectives === undefined ? {} : { perspectives: chosen }),
    stage,
    ...(isOneOf(REVIEW_DEPTHS, depth) ? { depth } : {}),
    // 예시는 사용자가 직접 요청했을 때만 열린다. true 가 아닌 값은 전부 false 다 (PRD 4.2).
    exampleRequested: value['exampleRequested'] === true,
  }

  const paragraphIds = value['paragraphIds']
  if (paragraphIds !== undefined) {
    if (!Array.isArray(paragraphIds)) return null
    const ids: string[] = []
    for (const id of paragraphIds as unknown[]) {
      if (typeof id !== 'string' || id === '') return null
      ids.push(id)
    }
    input.paragraphIds = ids
  }

  const sectionOrdinal = value['sectionOrdinal']
  if (sectionOrdinal !== undefined) {
    if (typeof sectionOrdinal !== 'number' || !Number.isInteger(sectionOrdinal)) return null
    input.sectionOrdinal = sectionOrdinal
  }

  const sentence = value['sentence']
  if (sentence !== undefined) {
    if (!isRecord(sentence)) return null
    const { paragraphId, sentenceIndex } = sentence
    if (typeof paragraphId !== 'string' || paragraphId === '') return null
    if (typeof sentenceIndex !== 'number' || !Number.isInteger(sentenceIndex) || sentenceIndex < 0) {
      return null
    }
    input.sentence = { paragraphId, sentenceIndex }
  }

  return input
}

/** 렌더러가 보낸 항목 경계의 형태를 확인한다. 내용 검사(겹침·순서)는 코어가 한다. */
export function parseSectionOverridesInput(value: unknown): SectionOverride[] | null {
  if (!Array.isArray(value)) return null

  const overrides: SectionOverride[] = []
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return null
    const { ordinal, title, startParagraphUuid, endParagraphUuid } = entry
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal)) return null
    if (typeof title !== 'string') return null
    if (typeof startParagraphUuid !== 'string' || startParagraphUuid === '') return null
    if (typeof endParagraphUuid !== 'string' || endParagraphUuid === '') return null
    overrides.push({ ordinal, title, startParagraphUuid, endParagraphUuid })
  }
  return overrides
}

/** 앵커에 대한 사용자 결정의 형태를 확인한다. */
export function parseAnchorDecisionInput(value: unknown): AnchorDecision | null {
  if (!isRecord(value)) return null
  if (value['choice'] === 'keep-lost') return { choice: 'keep-lost' }
  if (value['choice'] !== 'relink') return null

  const sentenceIndex = value['sentenceIndex']
  if (typeof sentenceIndex !== 'number' || !Number.isInteger(sentenceIndex) || sentenceIndex < 0) {
    return null
  }
  return { choice: 'relink', sentenceIndex }
}

export function createReviewHandlers(deps: ReviewIpcDeps): ReviewHandlers {
  const { staged } = deps

  return {
    async getReviewPanel(documentId, includeAll): Promise<ReviewPanelResult> {
      if (typeof documentId !== 'string') return UNKNOWN_DOCUMENT
      const panel = await staged.getPanel(documentId, { includeAll: includeAll === true })
      if ('ok' in panel) return { status: 'failed', message: panel.message }
      return { status: 'ok', panel }
    },

    async requestStagedReview(input): Promise<StagedReviewResultView> {
      const parsed = parseStagedReviewInput(input)
      if (parsed === null) return MALFORMED_INPUT

      const result = await staged.requestStagedReview(parsed)
      if (!result.ok) return { status: 'failed', message: result.message }

      // 결과는 저장된 기록에서 다시 그린다. 화면이 모델 응답을 직접 받지 않는다.
      const panel = await staged.getPanel(parsed.documentId)
      if ('ok' in panel) return { status: 'failed', message: panel.message }
      return {
        status: 'reviewed',
        itemCount: result.response.items.length,
        droppedCount: result.droppedCount,
        panel,
      }
    },

    async requestReReview(documentId, feedbackId): Promise<ReReviewResultView> {
      if (typeof documentId !== 'string' || documentId === '') return UNKNOWN_DOCUMENT
      if (typeof feedbackId !== 'string' || feedbackId === '') {
        return { status: 'failed', message: '다시 볼 피드백을 알 수 없습니다.' }
      }

      const result = await staged.requestReReview({ documentId, feedbackId })
      if (!result.ok) return { status: 'failed', message: result.message }

      // 결과는 저장된 기록에서 다시 그린다. 화면이 모델 응답을 직접 받지 않는다.
      const panel = await staged.getPanel(documentId)
      if ('ok' in panel) return { status: 'failed', message: panel.message }
      return {
        status: 'reviewed',
        itemCount: result.response.items.length,
        droppedCount: result.droppedCount,
        panel,
      }
    },

    saveSectionBoundaries(documentId, overrides): Promise<SaveSectionBoundariesResult> {
      if (typeof documentId !== 'string') return Promise.resolve(UNKNOWN_DOCUMENT)
      const parsed = parseSectionOverridesInput(overrides)
      if (parsed === null) {
        return Promise.resolve({ status: 'failed', message: '항목 경계를 읽지 못했습니다.' })
      }

      const result = staged.saveSections(documentId, parsed)
      return Promise.resolve(
        result.ok
          ? { status: 'saved', sections: result.sections }
          : { status: 'failed', message: result.message },
      )
    },

    setDocumentKind(documentId, kind): SetDocumentKindResult {
      if (typeof documentId !== 'string' || documentId === '') return UNKNOWN_DOCUMENT
      if (typeof kind !== 'string') return { status: 'failed', message: '문서 종류를 읽지 못했습니다.' }
      if (deps.setDocumentKind === undefined) return { status: 'failed', message: '문서 종류를 고칠 수 없습니다.' }
      const result = deps.setDocumentKind(documentId, kind)
      return result.ok ? { status: 'saved' } : { status: 'failed', message: result.message }
    },

    async analyzeOutline(documentId): Promise<AnalyzeOutlineResult> {
      if (typeof documentId !== 'string' || documentId === '') return UNKNOWN_DOCUMENT
      if (deps.outline === undefined) return { status: 'failed', message: '목차 나누기를 쓸 수 없습니다.' }
      const result = await deps.outline.analyze(documentId)
      return result.ok ? { status: 'analyzed', count: result.count, modelId: result.modelId }
        : { status: 'failed', message: result.message }
    },

    async deleteFeedback(documentId, feedbackId): Promise<DeleteResult> {
      if (typeof documentId !== 'string' || documentId === '') return UNKNOWN_DOCUMENT
      if (typeof feedbackId !== 'string' || feedbackId === '') {
        return { status: 'failed', message: '지울 피드백을 알 수 없습니다.' }
      }
      // 확인 창이 없으면 지우지 않는다 (`CLAUDE.md` §3).
      const confirmed = await (deps.confirm?.({
        message: '이 피드백을 지울까요?',
        detail: '여기에 남긴 내 판단과 성장 기록의 관찰 근거도 함께 지워지며 되돌릴 수 없습니다.',
        confirmLabel: '삭제',
      }) ?? Promise.resolve(false))
      if (!confirmed) return { status: 'canceled' }
      const result = staged.deleteFeedback(documentId, feedbackId)
      return result.ok ? { status: 'deleted' } : { status: 'failed', message: result.message }
    },

    decideSentenceAnchor(anchorId, decision): Promise<DecideSentenceAnchorResult> {
      if (typeof anchorId !== 'string') {
        return Promise.resolve({ status: 'failed', message: '확인할 문장 기록을 알 수 없습니다.' })
      }
      const parsed = parseAnchorDecisionInput(decision)
      if (parsed === null) {
        return Promise.resolve({ status: 'failed', message: '문장 확인 결과를 읽지 못했습니다.' })
      }

      const result = staged.decideAnchor(anchorId, parsed)
      return Promise.resolve(
        result.ok
          ? { status: 'decided', anchor: result.anchor }
          : { status: 'failed', message: result.message },
      )
    },
  }
}
