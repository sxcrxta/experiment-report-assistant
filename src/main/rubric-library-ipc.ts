/**
 * 평가 지침 모음의 메인 프로세스 쪽 처리 ([Q-40]).
 *
 * 렌더러가 보낸 값은 믿지 않는다. 형태를 확인한 뒤 유스케이스로 넘긴다.
 * 모음 지침을 지우는 일은 되돌릴 수 없으므로 확인 창을 거친다 (`CLAUDE.md` §3).
 *
 * electron 을 import 하지 않는다. 확인 창은 인자로 받는다.
 */
import type { RubricLibraryService, TemplateSummary } from '../app/rubric-library.js'
import type {
  ApplyRubricTemplateResult,
  DeleteRubricTemplateResult,
  RubricLibraryResult,
  RubricTemplateView,
  SaveRubricTemplateResult,
} from '../shared/ipc.js'

import type { ConfirmRequest } from './document-ipc.js'
import { parseRubricItemsInput } from './rubric-ipc.js'

export interface RubricLibraryIpcDeps {
  library: RubricLibraryService
  /** @returns 사용자가 확인을 눌렀으면 true */
  confirm: (request: ConfirmRequest) => Promise<boolean>
}

export interface RubricLibraryHandlers {
  listRubricTemplates(query: unknown): RubricLibraryResult
  createRubricTemplate(name: unknown, items: unknown): SaveRubricTemplateResult
  updateRubricTemplate(id: unknown, name: unknown, items: unknown): SaveRubricTemplateResult
  deleteRubricTemplate(id: unknown): Promise<DeleteRubricTemplateResult>
  applyRubricTemplate(documentId: unknown, templateId: unknown): ApplyRubricTemplateResult
  saveDocumentRubricToLibrary(documentId: unknown, name: unknown): SaveRubricTemplateResult
}

const MALFORMED = { status: 'failed', message: '평가 지침 요청을 읽지 못했습니다.' } as const

function templateView(template: TemplateSummary): RubricTemplateView {
  return {
    id: template.id,
    name: template.name,
    items: template.items.map((item) => ({ ...item })),
    updatedAt: template.updatedAt,
    followingDocumentIds: [...template.followingDocumentIds],
    detachedDocumentIds: [...template.detachedDocumentIds],
  }
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

export function createRubricLibraryHandlers(deps: RubricLibraryIpcDeps): RubricLibraryHandlers {
  const { library } = deps

  return {
    listRubricTemplates(query) {
      if (typeof query !== 'object' || query === null) return MALFORMED
      const { documentId, subject } = query as Record<string, unknown>
      const document = optionalString(documentId)
      const subjectText = optionalString(subject)
      if (document === null || subjectText === null) return MALFORMED
      return {
        status: 'ok',
        templates: library.list().map(templateView),
        link: document === undefined ? null : library.linkOf(document),
        suggestedId: library.suggestedFor(subjectText ?? null),
      }
    },

    createRubricTemplate(name, items) {
      const parsed = parseRubricItemsInput(items)
      if (typeof name !== 'string' || parsed === null) return MALFORMED
      const result = library.create(name, parsed)
      if (!result.ok) return { status: 'failed', message: result.message }
      return { status: 'saved', template: templateView(result.template), updatedDocuments: 0 }
    },

    updateRubricTemplate(id, name, items) {
      const parsed = parseRubricItemsInput(items)
      if (typeof id !== 'string' || typeof name !== 'string' || parsed === null) return MALFORMED
      const result = library.update(id, name, parsed)
      if (!result.ok) return { status: 'failed', message: result.message }
      return { status: 'saved', template: templateView(result.template), updatedDocuments: result.updatedDocuments }
    },

    async deleteRubricTemplate(id) {
      if (typeof id !== 'string') return MALFORMED
      const template = library.list().find((entry) => entry.id === id)
      if (template === undefined) return { status: 'failed', message: '모음에서 이 지침을 찾지 못했습니다.' }
      const linked = template.followingDocumentIds.length + template.detachedDocumentIds.length
      const confirmed = await deps.confirm({
        message: `'${template.name}' 지침을 모음에서 지울까요?`,
        detail: linked === 0
          ? '지운 지침은 되살릴 수 없습니다.'
          : `지운 지침은 되살릴 수 없습니다. 적용한 보고서 ${linked}개의 지침은 그대로 남고, 앞으로 따라가지만 않습니다.`,
        confirmLabel: '지침 지우기',
      })
      if (!confirmed) return { status: 'canceled' }
      const result = library.remove(id)
      if (!result.ok) return { status: 'failed', message: result.message }
      return { status: 'deleted', unlinkedDocuments: result.unlinkedDocuments }
    },

    applyRubricTemplate(documentId, templateId) {
      if (typeof documentId !== 'string' || typeof templateId !== 'string') return MALFORMED
      const result = library.apply(documentId, templateId)
      if (!result.ok) return { status: 'failed', message: result.message }
      return { status: 'applied', ordinal: result.ordinal }
    },

    saveDocumentRubricToLibrary(documentId, name) {
      if (typeof documentId !== 'string' || typeof name !== 'string') return MALFORMED
      const result = library.saveDocumentRubric(documentId, name)
      if (!result.ok) return { status: 'failed', message: result.message }
      return { status: 'saved', template: templateView(result.template), updatedDocuments: 0 }
    },
  }
}
