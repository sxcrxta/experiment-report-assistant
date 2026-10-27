/**
 * 평가 지침 모음 ([Q-40], PRD 3절 2번·4.1).
 *
 * 지침을 보고서와 따로 만들어 두고, 사용자가 고른 보고서에 **적용**한다.
 *
 * 지키는 것
 * - 적용은 모음의 내용을 보고서의 **확정 지침으로 복사**하는 일이다. AI 가 보는 것은 언제나
 *   보고서의 확정 지침뿐이고, 확정은 `RubricService.confirm` 한 곳을 지난다 (`CLAUDE.md` §1).
 * - 모음 지침을 고쳐 **저장하는 것이 사용자의 확정**이다. 저장하는 순간, 그 지침을 따르는 보고서마다
 *   새 확정 버전을 만든다 (사용자 결정: 자동으로 따라감). 한 트랜잭션이라 일부만 바뀌지 않는다.
 * - 보고서에서 따로 고쳐 확정하면 그 보고서는 **따라가기를 멈춘다** ("보고서에서 고침").
 *   고친 내용이 모음 지침과 다시 같아지면 따라가기로 돌아간다.
 * - 모음 지침을 지워도 보고서의 확정 지침은 남는다. 따라가기만 끊긴다.
 *
 * 판단은 여기서 하고 저장소는 받아 적기만 한다. 파일·네트워크에 닿지 않는다 (`CLAUDE.md` §2·§7).
 */
import {
  confirmationProblems,
  prepareRubricItems,
  sameRubricContent,
  type RubricItem,
} from '../core/rubric/model.js'
import { normalizeText } from '../core/document/normalize.js'
import type { DocumentRepository } from '../adapters/repo/documents.js'
import type { RubricLibraryRepository, RubricTemplateRow } from '../adapters/repo/rubric-library.js'
import type { RubricItemInput } from '../shared/rubric.js'
import { RUBRIC_TEMPLATE_NAME_MAX_LENGTH } from '../shared/ipc.js'
import type { RubricFailure, RubricService } from './rubric.js'

export interface RubricLibraryDeps {
  library: RubricLibraryRepository
  rubric: RubricService
  documents: DocumentRepository
  now: () => string
  newId: () => string
}

export interface TemplateSummary {
  id: string
  name: string
  items: RubricItem[]
  updatedAt: string
  /** 지금 이 지침을 따라가는 보고서 */
  followingDocumentIds: string[]
  /** 이 지침을 적용했다가 보고서에서 고친 보고서 */
  detachedDocumentIds: string[]
}

/** 보고서 하나가 어느 모음 지침과 이어져 있는가 */
export interface DocumentRubricLink {
  templateId: string
  templateName: string
  following: boolean
}

export type LibraryFailure = { ok: false; message: string }
export type LibraryResult<T> = ({ ok: true } & T) | LibraryFailure

export interface RubricLibraryService {
  list(): TemplateSummary[]
  /** 새 지침을 모음에 만든다. 어느 보고서에도 적용하지 않는다 */
  create(name: string, inputs: readonly RubricItemInput[]): LibraryResult<{ template: TemplateSummary }>
  /**
   * 모음 지침을 고쳐 저장한다. **따라가는 보고서마다 새 확정 버전이 생긴다.**
   * @returns updatedDocuments 새 버전이 생긴 보고서 수 (내용이 같아 그대로인 보고서는 세지 않는다)
   */
  update(id: string, name: string, inputs: readonly RubricItemInput[]):
    LibraryResult<{ template: TemplateSummary; updatedDocuments: number }>
  /** 모음에서 지운다. 보고서의 확정 지침은 남는다. 사용자 확인은 부르는 쪽이 받는다 */
  remove(id: string): LibraryResult<{ unlinkedDocuments: number }>
  /** 보고서에 적용한다 (= 그 내용으로 확정하고 따라가기 시작) */
  apply(documentId: string, templateId: string): LibraryResult<{ ordinal: number }>
  /**
   * 보고서 쪽에서 지침을 확정한다. 편집기와 검토 자리의 확정은 모두 여기를 지난다.
   * 이어진 모음 지침과 내용이 다르면 따라가기를 멈추고, 같으면 따라간다.
   */
  confirmForDocument(documentId: string, inputs: readonly RubricItemInput[]):
    ReturnType<RubricService['confirm']>
  /** 보고서의 지금 확정 지침을 모음에 새 지침으로 저장하고, 그 지침을 따라가게 한다 */
  saveDocumentRubric(documentId: string, name: string): LibraryResult<{ template: TemplateSummary }>
  linkOf(documentId: string): DocumentRubricLink | null
  /**
   * 새 보고서에 먼저 골라 둘 지침. **적용하지는 않는다.**
   * 같은 과목에 마지막으로 적용한 지침 → 가장 최근에 고친 지침 순이다.
   */
  suggestedFor(subject: string | null): string | null
}

function fail(message: string): LibraryFailure {
  return { ok: false, message }
}

function checkName(name: string): { ok: true; name: string } | LibraryFailure {
  const normalized = normalizeText(name)
  if (normalized === '') return fail('지침 이름을 적어 주세요.')
  if (normalized.length > RUBRIC_TEMPLATE_NAME_MAX_LENGTH) {
    return fail(`지침 이름은 ${RUBRIC_TEMPLATE_NAME_MAX_LENGTH}자까지 쓸 수 있습니다.`)
  }
  return { ok: true, name: normalized }
}

/** 보고서 확정과 같은 규칙으로 검사한다. 모음에 들어간 지침은 그대로 확정할 수 있어야 한다 */
function checkItems(inputs: readonly RubricItemInput[], newId: () => string):
  { ok: true; items: RubricItem[] } | LibraryFailure {
  const prepared = prepareRubricItems(inputs, newId)
  if (!prepared.ok) return fail(prepared.problems.join('\n'))
  const problems = confirmationProblems(prepared.items)
  if (problems.length > 0) return fail(problems.join('\n'))
  return { ok: true, items: prepared.items }
}

/** 트랜잭션을 되돌리기 위해 던지는 실패. 밖으로 새어 나가지 않는다 */
class Rollback extends Error {
  readonly failure: RubricFailure | LibraryFailure
  constructor(failure: RubricFailure | LibraryFailure) {
    super(failure.message)
    this.failure = failure
  }
}

export function createRubricLibraryService(deps: RubricLibraryDeps): RubricLibraryService {
  const { library, rubric, documents, now, newId } = deps

  function summarize(row: RubricTemplateRow): TemplateSummary {
    const links = library.listLinks().filter((link) => link.templateId === row.id)
    return {
      id: row.id,
      name: row.name,
      items: row.items,
      updatedAt: row.updatedAt,
      followingDocumentIds: links.filter((link) => link.following).map((link) => link.documentId),
      detachedDocumentIds: links.filter((link) => !link.following).map((link) => link.documentId),
    }
  }

  /** 모음 지침의 항목을 보고서 확정에 넘길 입력으로 바꾼다. 식별자를 그대로 쓴다 */
  function asInputs(items: readonly RubricItem[]): RubricItemInput[] {
    return items.map((item) => ({ ...item }))
  }

  return {
    list: () => library.listTemplates().map(summarize),

    create(name, inputs) {
      const checkedName = checkName(name)
      if (!checkedName.ok) return checkedName
      const checked = checkItems(inputs, newId)
      if (!checked.ok) return checked
      const at = now()
      const row = { id: newId(), name: checkedName.name, items: checked.items, createdAt: at, updatedAt: at }
      library.saveTemplate(row)
      return { ok: true, template: summarize(row) }
    },

    update(id, name, inputs) {
      const existing = library.getTemplate(id)
      if (existing === null) return fail('모음에서 이 지침을 찾지 못했습니다. 이미 지웠을 수 있습니다.')
      const checkedName = checkName(name)
      if (!checkedName.ok) return checkedName
      const checked = checkItems(inputs, newId)
      if (!checked.ok) return checked
      const row = { ...existing, name: checkedName.name, items: checked.items, updatedAt: now() }

      try {
        const updatedDocuments = library.transaction(() => {
          library.saveTemplate(row)
          let count = 0
          for (const link of library.listLinks()) {
            if (link.templateId !== id || !link.following) continue
            // 모음 지침을 저장하는 것이 확정이다. 따라가는 보고서에 같은 내용을 확정한다.
            // 확정은 그 보고서의 초안을 치우므로, 보고서에서 쓰던 초안이 있으면 되살려 둔다.
            const before = rubric.getEditor(link.documentId)
            const draft = before.ok ? before.state.draft : null
            const confirmed = rubric.confirm(link.documentId, asInputs(row.items))
            if (!confirmed.ok) throw new Rollback(confirmed)
            if (draft !== null) rubric.saveDraft(link.documentId, asInputs(draft.items))
            if (confirmed.created) count += 1
          }
          return count
        })
        return { ok: true, template: summarize(row), updatedDocuments }
      } catch (cause) {
        if (cause instanceof Rollback) {
          return fail(`따라가는 보고서에 적용하지 못해 저장하지 않았습니다. ${cause.failure.message}`)
        }
        throw cause
      }
    },

    remove(id) {
      if (library.getTemplate(id) === null) return fail('모음에서 이 지침을 찾지 못했습니다.')
      const linked = library.listLinks().filter((link) => link.templateId === id).length
      // 연결은 FK 로 함께 지워진다. 보고서의 확정 지침(rubric_version)은 건드리지 않는다.
      library.deleteTemplate(id)
      return { ok: true, unlinkedDocuments: linked }
    },

    apply(documentId, templateId) {
      if (documents.getDocument(documentId) === null) return fail('등록되지 않은 문서입니다.')
      const template = library.getTemplate(templateId)
      if (template === null) return fail('모음에서 이 지침을 찾지 못했습니다.')
      try {
        return library.transaction(() => {
          const confirmed = rubric.confirm(documentId, asInputs(template.items))
          if (!confirmed.ok) throw new Rollback(confirmed)
          library.setLink({ documentId, templateId, following: true, appliedAt: now() })
          return { ok: true as const, ordinal: confirmed.rubric.ordinal }
        })
      } catch (cause) {
        if (cause instanceof Rollback) return fail(cause.failure.message)
        throw cause
      }
    },

    confirmForDocument(documentId, inputs) {
      const link = library.getLink(documentId)
      const confirmed = rubric.confirm(documentId, inputs)
      if (!confirmed.ok || link === null) return confirmed
      const template = library.getTemplate(link.templateId)
      if (template === null) return confirmed
      // 확정한 내용이 모음 지침과 같으면 따라가고, 다르면 "보고서에서 고침" 이다.
      const following = sameRubricContent(confirmed.rubric.items, template.items)
      if (following !== link.following) library.setLink({ ...link, following })
      return confirmed
    },

    saveDocumentRubric(documentId, name) {
      const editor = rubric.getEditor(documentId)
      if (!editor.ok) return fail(editor.message)
      const current = editor.state.current
      if (current === null) return fail('이 보고서에는 아직 확정한 지침이 없습니다.')
      const checkedName = checkName(name)
      if (!checkedName.ok) return checkedName
      const at = now()
      // 식별자를 그대로 가져간다. 그래야 보고서가 곧바로 이 지침을 "따라가는" 상태가 된다.
      const row = { id: newId(), name: checkedName.name, items: [...current.items], createdAt: at, updatedAt: at }
      library.transaction(() => {
        library.saveTemplate(row)
        library.setLink({ documentId, templateId: row.id, following: true, appliedAt: at })
      })
      return { ok: true, template: summarize(row) }
    },

    linkOf(documentId) {
      const link = library.getLink(documentId)
      if (link === null) return null
      const template = library.getTemplate(link.templateId)
      if (template === null) return null
      return { templateId: link.templateId, templateName: template.name, following: link.following }
    },

    suggestedFor(subject) {
      const templates = library.listTemplates()
      if (templates.length === 0) return null
      if (subject !== null && subject.trim() !== '') {
        // 링크는 최근에 적용한 것이 앞에 온다.
        for (const link of library.listLinks()) {
          if (documents.getDocument(link.documentId)?.subject === subject) return link.templateId
        }
      }
      return templates[0]!.id
    },
  }
}
