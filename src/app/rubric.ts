/**
 * 평가 지침 유스케이스.
 *
 * IMPLEMENTATION_PLAN.md §2.1 을 그대로 옮긴다.
 *
 * ```
 * 사용자가 HWPX 선택 (+ 과목 입력)
 *   └→ 지침 편집기: 사용자가 평가 지침을 입력·확정   ← 분기 없음 [Q-3]
 *        (문서 구조를 근거로 한 초안 제안은 보조 기능이며,
 *         사용자가 확인·수정하기 전에는 어떤 AI 호출에도 쓰이지 않는다)
 *        └→ Rubric 확정 (rubricVersion 부여) → 저장
 * ```
 *
 * - 문서 상태(양식이 있는지, 비었는지)를 보지 않는다. 모든 문서가 같은 편집 경로를 지난다.
 * - 초안은 저장해 두고 언제든 고칠 수 있다. 확정하면 새 버전이 생기고 이전 버전은 그대로 남는다.
 * - **AI 요청이 지침을 얻는 길은 `withConfirmedRubric` 하나뿐이다.** 확정한 지침이 없으면 AI 호출을
 *   부르지 않고 실패로 알린다. 확정하지 않은 변경이 있어도 AI 에는 마지막으로 확정한 버전만 간다.
 *
 * 이 파일은 조합만 한다. 정규화·검증·버전 계산은 `core/rubric`, 영속화는 저장소가 맡는다.
 */
import type { DocumentRepository } from '../adapters/repo/documents.js'
import type { RubricRepository } from '../adapters/repo/rubric.js'
import type { Paragraph } from '../core/document/model.js'
import { documentOutline } from '../core/rubric/outline.js'
import { rubricSkeleton } from '../core/rubric/skeleton.js'
import {
  assertConfirmedRubric,
  confirmRubric,
  prepareRubricItems,
  sameRubricContent,
  type ConfirmedRubric,
  type RubricDraft,
  type RubricItemContent,
  type RubricItemInput,
} from '../core/rubric/model.js'

/**
 * 문서 구조(제목·목차·표·안내 문구)를 읽어 지침 초안을 제안하는 보조 기능 (PRD 4.1).
 *
 * 구현은 `app/rubric-suggest.ts` 가 모델 어댑터로 채운다 (PRD 4.3 표의 "평가 지침 초안").
 * 모델에 나가는 것은 `core/rubric/outline.ts` 가 뽑은 문서 뼈대뿐이고 본문은 보내지 않는다.
 * 제안은 편집기로만 돌아간다. 사용자가 확인·수정해 확정하기 전에는 어떤 AI 요청에도 지침으로 쓰이지 않는다.
 */
export interface RubricDraftSuggester {
  suggest(input: { documentId: string; paragraphs: readonly Paragraph[] }): Promise<RubricSuggestion>
}

export type RubricSuggestion =
  | { ok: true; items: RubricItemContent[] }
  | { ok: false; message: string }

/**
 * 제안하지 않는 제안기. 그 사실을 그대로 알린다.
 *
 * 실제 제안은 `app/rubric-suggest.ts` 의 `createModelRubricSuggester` 가 한다.
 * 이것은 제안 없이도 나머지 지침 기능이 온전히 도는지 보는 자리에 쓴다(주로 테스트).
 */
export const UNAVAILABLE_SUGGESTER: RubricDraftSuggester = {
  suggest: () =>
    Promise.resolve({
      ok: false,
      message:
        '문서 구조로 지침 초안을 제안하는 기능은 아직 준비 중입니다. 지침 항목을 직접 입력해 주세요.',
    }),
}

export interface RubricServiceDeps {
  documents: DocumentRepository
  rubrics: RubricRepository
  suggester: RubricDraftSuggester
  now: () => string
  newId: () => string
}

export type RubricFailureReason =
  | 'unknown-document'
  | 'invalid-rubric'
  | 'rubric-not-confirmed'
  | 'rubric-unreadable'
  | 'suggestion-unavailable'

export interface RubricFailure {
  ok: false
  reason: RubricFailureReason
  /** 사용자에게 그대로 보여 줄 한국어 안내 */
  message: string
}

export interface RubricEditorState {
  documentId: string
  /** 확정 전 초안. 확정하지 않은 변경이 없으면 null */
  draft: RubricDraft | null
  /** 지금 적용되는(가장 최근에 확정한) 지침. 확정한 적이 없으면 null */
  current: ConfirmedRubric | null
  /** 확정한 모든 버전. 버전 1 이 맨 앞이다 */
  history: ConfirmedRubric[]
}

export interface EditorSuccess {
  ok: true
  state: RubricEditorState
}

export interface ConfirmSuccess {
  ok: true
  rubric: ConfirmedRubric
  /** 새 버전을 만들었으면 true. 마지막 확정 버전과 내용이 같으면 그 버전을 그대로 쓰고 false */
  created: boolean
  state: RubricEditorState
}

export interface SuggestSuccess {
  ok: true
  /** 편집기에 보여 줄 제안 항목. 저장되지 않았다 */
  items: RubricItemContent[]
}

export interface GateSuccess<T> {
  ok: true
  value: T
  /** AI 요청에 실린 지침 */
  rubric: ConfirmedRubric
  /** 확정하지 않은 변경이 따로 있는가. 있어도 AI 에는 `rubric` 만 갔다 */
  pendingDraft: boolean
}

export interface RubricService {
  getEditor(documentId: string): EditorSuccess | RubricFailure
  /** 편집기 내용을 초안으로 저장한다. 확정하지 않는다 */
  saveDraft(documentId: string, inputs: readonly RubricItemInput[]): EditorSuccess | RubricFailure
  /** 편집기 내용을 확정한다. 사용자가 보고 있는 내용이 그대로 확정된다 */
  confirm(documentId: string, inputs: readonly RubricItemInput[]): ConfirmSuccess | RubricFailure
  /** 초안을 버린다. 확정한 버전은 건드리지 않는다. 사용자 확인은 부르는 쪽이 받는다 */
  discardDraft(documentId: string): EditorSuccess | RubricFailure
  suggestDraft(documentId: string): Promise<SuggestSuccess | RubricFailure>
  /**
   * 문서를 등록할 때 **초안을 미리 채워 둔다** ([Q-37]).
   *
   * 빈칸부터 쓰게 하지 않는 것이 목적이다. 확정은 여전히 사용자가 한다 (PRD 4.1).
   * 1. 이미 확정한 지침이나 사용자가 쓴 초안이 있으면 **건드리지 않는다.**
   * 2. 문서 구조로 뼈대를 만들어 초안으로 저장한다 (결정론. 키·연결 없이도 된다).
   * 3. AI 를 쓸 수 있으면 그 뼈대를 다듬어 바꿔 넣는다. **그 사이 사용자가 고쳤으면 그만둔다.**
   */
  prepareDraft(documentId: string, paragraphs: readonly Paragraph[]): Promise<void>
  /**
   * AI 요청이 지침을 얻는 유일한 관문.
   * 확정한 지침이 있을 때만 `call` 을 부르고, 그 지침(마지막 확정 버전)만 넘긴다.
   * 확정한 지침이 없거나 확정 지침으로 인정할 수 없으면 `call` 을 부르지 않는다.
   */
  withConfirmedRubric<T>(
    documentId: string,
    call: (rubric: ConfirmedRubric) => Promise<T>,
  ): Promise<GateSuccess<T> | RubricFailure>
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const UNKNOWN_DOCUMENT: RubricFailure = {
  ok: false,
  reason: 'unknown-document',
  message: '등록되지 않은 문서입니다.',
}

function unreadable(cause: unknown): RubricFailure {
  return {
    ok: false,
    reason: 'rubric-unreadable',
    message: `저장된 평가 지침을 읽지 못했습니다: ${messageOf(cause)}`,
  }
}

function invalid(problems: readonly string[]): RubricFailure {
  return { ok: false, reason: 'invalid-rubric', message: problems.join('\n') }
}

export function createRubricService(deps: RubricServiceDeps): RubricService {
  const { documents, rubrics, suggester, now, newId } = deps

  function hasDocument(documentId: string): boolean {
    return documents.getDocument(documentId) !== null
  }

  /** 확정 지침은 읽을 때 검증된다. 저장된 값이 확정할 때와 다르면 예외가 난다. */
  function readState(documentId: string): EditorSuccess | RubricFailure {
    try {
      const history = rubrics.listConfirmed(documentId)
      return {
        ok: true,
        state: {
          documentId,
          draft: rubrics.getDraft(documentId),
          current: history[history.length - 1] ?? null,
          history,
        },
      }
    } catch (cause) {
      return unreadable(cause)
    }
  }

  function latestConfirmed(documentId: string): ConfirmedRubric | null | RubricFailure {
    try {
      return rubrics.latestConfirmed(documentId)
    } catch (cause) {
      return unreadable(cause)
    }
  }

  return {
    getEditor(documentId): EditorSuccess | RubricFailure {
      if (!hasDocument(documentId)) return UNKNOWN_DOCUMENT
      return readState(documentId)
    },

    async prepareDraft(documentId, paragraphs): Promise<void> {
      if (!hasDocument(documentId)) return
      const before = readState(documentId)
      if (!before.ok) return
      // 사용자가 이미 확정했거나 뭔가 써 둔 초안이 있으면 손대지 않는다.
      if (before.state.current !== null) return
      if ((before.state.draft?.items.length ?? 0) > 0) return

      // 새 항목이므로 itemId 는 없다. 저장할 때 `prepareRubricItems` 가 붙여 준다.
      const skeleton = rubricSkeleton(documentOutline(paragraphs))
        .map(item => ({ ...item, itemId: null }))
      if (skeleton.length === 0) return
      const saved = this.saveDraft(documentId, skeleton)
      if (!saved.ok) return

      // 여기까지는 연결이 없어도 된다. 아래 다듬기는 쓸 수 있을 때만 한다.
      const suggestion = await suggester.suggest({ documentId, paragraphs })
      if (!suggestion.ok) return
      const after = readState(documentId)
      // 다듬는 동안 사용자가 고쳤으면 그 내용을 덮지 않는다.
      if (!after.ok || after.state.current !== null) return
      const current = after.state.draft?.items ?? []
      const untouched = current.length === skeleton.length
        && current.every((item, at) => item.title === skeleton[at]!.title
          && item.description === skeleton[at]!.description
          && item.importance === skeleton[at]!.importance)
      if (!untouched) return
      this.saveDraft(documentId, suggestion.items.map(item => ({ ...item, itemId: null })))
    },

    saveDraft(documentId, inputs): EditorSuccess | RubricFailure {
      if (!hasDocument(documentId)) return UNKNOWN_DOCUMENT

      const prepared = prepareRubricItems(inputs, newId)
      if (!prepared.ok) return invalid(prepared.problems)

      const latest = latestConfirmed(documentId)
      if (latest !== null && 'ok' in latest) return latest

      const unchanged =
        latest === null ? prepared.items.length === 0 : sameRubricContent(prepared.items, latest.items)
      if (unchanged) {
        // 확정한 내용과 같다. 확정하지 않은 변경이 없으므로 초안을 남기지 않는다.
        rubrics.deleteDraft(documentId)
      } else {
        rubrics.saveDraft({ status: 'draft', documentId, items: prepared.items, updatedAt: now() })
      }
      return readState(documentId)
    },

    confirm(documentId, inputs): ConfirmSuccess | RubricFailure {
      if (!hasDocument(documentId)) return UNKNOWN_DOCUMENT

      const prepared = prepareRubricItems(inputs, newId)
      if (!prepared.ok) return invalid(prepared.problems)

      const latest = latestConfirmed(documentId)
      if (latest !== null && 'ok' in latest) return latest

      let rubric: ConfirmedRubric
      let created: boolean
      if (latest !== null && sameRubricContent(prepared.items, latest.items)) {
        // 바뀐 것이 없다. 새 버전을 만들지 않고 마지막 확정 버전을 그대로 쓴다.
        rubrics.deleteDraft(documentId)
        rubric = latest
        created = false
      } else {
        const confirmed = confirmRubric({
          documentId,
          ordinal: (latest?.ordinal ?? 0) + 1,
          items: prepared.items,
          confirmedAt: now(),
        })
        if (!confirmed.ok) return invalid(confirmed.problems)
        rubrics.appendConfirmed(confirmed.rubric)
        rubric = confirmed.rubric
        created = true
      }

      const state = readState(documentId)
      if (!state.ok) return state
      return { ok: true, rubric, created, state: state.state }
    },

    discardDraft(documentId): EditorSuccess | RubricFailure {
      if (!hasDocument(documentId)) return UNKNOWN_DOCUMENT
      rubrics.deleteDraft(documentId)
      return readState(documentId)
    },

    async suggestDraft(documentId): Promise<SuggestSuccess | RubricFailure> {
      if (!hasDocument(documentId)) return UNKNOWN_DOCUMENT

      const version = documents.latestVersion(documentId)
      const paragraphs =
        version === null ? [] : documents.listParagraphs(version.id).map((entry) => entry.paragraph)

      const suggestion = await suggester.suggest({ documentId, paragraphs })
      if (!suggestion.ok) {
        return { ok: false, reason: 'suggestion-unavailable', message: suggestion.message }
      }

      // 제안도 사용자 입력과 같은 규칙으로 정규화·검증한다. 형식을 어긴 제안은 보여 주지 않는다.
      // 식별자는 검증에만 쓰는 임시 값이다. 제안은 저장되지 않으므로 사용자가 저장할 때 새로 받는다.
      let counter = 0
      const prepared = prepareRubricItems(
        suggestion.items.map((item) => ({ ...item, itemId: null })),
        () => `suggested-${(counter += 1)}`,
      )
      if (!prepared.ok) {
        return {
          ok: false,
          reason: 'suggestion-unavailable',
          message: `제안된 초안이 형식에 맞지 않아 보여 드리지 않습니다.\n${prepared.problems.join('\n')}`,
        }
      }
      return {
        ok: true,
        items: prepared.items.map(({ title, description, importance }) => ({
          title,
          description,
          importance,
        })),
      }
    },

    async withConfirmedRubric<T>(
      documentId: string,
      call: (rubric: ConfirmedRubric) => Promise<T>,
    ): Promise<GateSuccess<T> | RubricFailure> {
      if (!hasDocument(documentId)) return UNKNOWN_DOCUMENT

      const latest = latestConfirmed(documentId)
      if (latest !== null && 'ok' in latest) return latest
      if (latest === null) {
        return {
          ok: false,
          reason: 'rubric-not-confirmed',
          message:
            '평가 지침을 먼저 입력하고 확정해 주세요. 확정하기 전의 지침으로는 AI 검토를 요청하지 않습니다.',
        }
      }

      // 타입 표식은 런타임에 없다. AI 에 넘기기 직전에 확정 지침인지 다시 확인한다.
      try {
        assertConfirmedRubric(latest)
        if (latest.documentId !== documentId) throw new Error('다른 문서의 지침입니다.')
      } catch (cause) {
        return unreadable(cause)
      }

      const pendingDraft = rubrics.getDraft(documentId) !== null
      const value = await call(latest)
      return { ok: true, value, rubric: latest, pendingDraft }
    },
  }
}
