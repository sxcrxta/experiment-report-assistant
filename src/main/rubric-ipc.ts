/**
 * 평가 지침 편집의 메인 프로세스 쪽 처리 (PRD 3절 2번, 4.1).
 *
 * 렌더러가 보낸 값은 믿지 않는다. 형태를 확인한 뒤 유스케이스로 넘기고, 결과를 화면용 형태로 바꾼다.
 * 확정하지 않은 초안을 버리는 일은 되돌릴 수 없으므로 확인 창을 거친다 (`CLAUDE.md` §3).
 *
 * 화면으로 보내는 것은 편집에 필요한 내용뿐이다. 확정 지침 객체 자체는 메인 프로세스 밖으로 나가지 않는다.
 *
 * electron 을 import 하지 않는다. 확인 창은 인자로 받는다. 그래야 Electron 없이 테스트할 수 있다.
 */
import type { RubricEditorState, RubricService } from '../app/rubric.js'
import type { RubricLibraryService } from '../app/rubric-library.js'
import type { ConfirmedRubric, RubricItem } from '../core/rubric/model.js'
import type {
  ConfirmRubricResult,
  DiscardRubricDraftResult,
  RubricEditorResult,
  RubricEditorView,
  RubricItemInput,
  RubricItemView,
  RubricVersionView,
  SuggestRubricDraftResult,
} from '../shared/ipc.js'

import type { ConfirmRequest } from './document-ipc.js'

export interface RubricIpcDeps {
  rubric: RubricService
  /**
   * 지침 모음 ([Q-40]). 있으면 보고서 쪽 확정이 이것을 지나, 모음 지침을 따라가는지가 함께 갱신된다.
   */
  library?: Pick<RubricLibraryService, 'confirmForDocument'>
  /** @returns 사용자가 확인을 눌렀으면 true */
  confirm: (request: ConfirmRequest) => Promise<boolean>
}

/** 렌더러에서 온 값을 그대로 받는다. 형태 확인은 여기서 한다. */
export interface RubricHandlers {
  getRubric(documentId: unknown): RubricEditorResult
  saveRubricDraft(documentId: unknown, items: unknown): RubricEditorResult
  confirmRubric(documentId: unknown, items: unknown): ConfirmRubricResult
  discardRubricDraft(documentId: unknown): Promise<DiscardRubricDraftResult>
  suggestRubricDraft(documentId: unknown): Promise<SuggestRubricDraftResult>
}

const UNKNOWN_DOCUMENT = { status: 'failed', message: '지침을 편집할 문서를 알 수 없습니다.' } as const
const MALFORMED_ITEMS = { status: 'failed', message: '지침 항목을 읽지 못했습니다.' } as const

/**
 * 렌더러가 보낸 항목 목록의 형태를 확인한다. 형태가 틀리면 null.
 * 내용(길이·중요도·빈 이름)의 검사는 코어가 한다.
 */
export function parseRubricItemsInput(value: unknown): RubricItemInput[] | null {
  if (!Array.isArray(value)) return null

  const items: RubricItemInput[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null
    const { itemId, title, description, importance } = entry as Record<string, unknown>
    if (itemId !== null && typeof itemId !== 'string') return null
    if (typeof title !== 'string' || typeof description !== 'string') return null
    if (typeof importance !== 'number') return null
    items.push({ itemId, title, description, importance })
  }
  return items
}

function itemView(item: Readonly<RubricItem>): RubricItemView {
  return {
    itemId: item.itemId,
    title: item.title,
    description: item.description,
    importance: item.importance,
  }
}

function versionView(rubric: ConfirmedRubric): RubricVersionView {
  return {
    ordinal: rubric.ordinal,
    rubricVersion: rubric.rubricVersion,
    confirmedAt: rubric.confirmedAt,
    items: rubric.items.map(itemView),
  }
}

export function editorView(state: RubricEditorState): RubricEditorView {
  return {
    documentId: state.documentId,
    draft:
      state.draft === null
        ? null
        : { items: state.draft.items.map(itemView), updatedAt: state.draft.updatedAt },
    current: state.current === null ? null : versionView(state.current),
    history: [...state.history].reverse().map(versionView),
  }
}

export function createRubricHandlers(deps: RubricIpcDeps): RubricHandlers {
  const { rubric } = deps

  return {
    getRubric(documentId): RubricEditorResult {
      if (typeof documentId !== 'string') return UNKNOWN_DOCUMENT
      const result = rubric.getEditor(documentId)
      if (!result.ok) return { status: 'failed', message: result.message }
      return { status: 'ok', editor: editorView(result.state) }
    },

    saveRubricDraft(documentId, items): RubricEditorResult {
      if (typeof documentId !== 'string') return UNKNOWN_DOCUMENT
      const parsed = parseRubricItemsInput(items)
      if (parsed === null) return MALFORMED_ITEMS

      const result = rubric.saveDraft(documentId, parsed)
      if (!result.ok) return { status: 'failed', message: result.message }
      return { status: 'ok', editor: editorView(result.state) }
    },

    confirmRubric(documentId, items): ConfirmRubricResult {
      if (typeof documentId !== 'string') return UNKNOWN_DOCUMENT
      const parsed = parseRubricItemsInput(items)
      if (parsed === null) return MALFORMED_ITEMS

      const result = deps.library === undefined
        ? rubric.confirm(documentId, parsed)
        : deps.library.confirmForDocument(documentId, parsed)
      if (!result.ok) return { status: 'failed', message: result.message }
      return {
        status: 'confirmed',
        created: result.created,
        ordinal: result.rubric.ordinal,
        editor: editorView(result.state),
      }
    },

    async discardRubricDraft(documentId): Promise<DiscardRubricDraftResult> {
      if (typeof documentId !== 'string') return UNKNOWN_DOCUMENT

      const current = rubric.getEditor(documentId)
      if (!current.ok) return { status: 'failed', message: current.message }
      if (current.state.draft === null) {
        // 버릴 초안이 없다. 묻지 않고 지금 상태를 돌려준다.
        return { status: 'discarded', editor: editorView(current.state) }
      }

      const fallback =
        current.state.current === null
          ? '확정한 지침이 아직 없으므로 편집기가 비워집니다.'
          : `편집기는 마지막으로 확정한 버전 ${current.state.current.ordinal} 의 내용으로 돌아갑니다.`
      const confirmed = await deps.confirm({
        message: '확정하지 않은 지침 초안을 버릴까요?',
        detail: `버린 초안은 되살릴 수 없습니다. 확정한 버전은 그대로 남습니다.\n${fallback}`,
        confirmLabel: '초안 버리기',
      })
      if (!confirmed) return { status: 'canceled' }

      const result = rubric.discardDraft(documentId)
      if (!result.ok) return { status: 'failed', message: result.message }
      return { status: 'discarded', editor: editorView(result.state) }
    },

    async suggestRubricDraft(documentId): Promise<SuggestRubricDraftResult> {
      if (typeof documentId !== 'string') return UNKNOWN_DOCUMENT

      const result = await rubric.suggestDraft(documentId)
      if (!result.ok) {
        return result.reason === 'suggestion-unavailable'
          ? { status: 'unavailable', message: result.message }
          : { status: 'failed', message: result.message }
      }
      return {
        status: 'suggested',
        items: result.items.map((item) => ({ itemId: null, ...item })),
      }
    },
  }
}
