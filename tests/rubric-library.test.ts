/**
 * 평가 지침 모음 ([Q-40]).
 *
 * 여기서 지키는 것
 * - 적용 = 모음의 내용으로 보고서의 확정 지침을 만든다. AI 는 보고서의 확정 지침만 본다.
 * - 모음 지침을 고쳐 저장하면 **따라가는 보고서마다** 새 확정 버전이 생긴다 (사용자 결정).
 * - 보고서에서 따로 고치면 따라가기를 멈추고, 모음을 고쳐도 그 보고서는 바뀌지 않는다.
 * - 모음 지침을 지워도 보고서의 확정 지침은 남는다.
 * - 따라가는 보고서 하나라도 확정하지 못하면 아무것도 바뀌지 않는다 (한 트랜잭션).
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDocumentRepository, type DocumentRepository } from '../src/adapters/repo/documents.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createRubricRepository } from '../src/adapters/repo/rubric.js'
import { createRubricLibraryRepository } from '../src/adapters/repo/rubric-library.js'
import { createRubricService, UNAVAILABLE_SUGGESTER, type RubricService } from '../src/app/rubric.js'
import { createRubricLibraryService, type RubricLibraryService } from '../src/app/rubric-library.js'
import type { RubricItemInput } from '../src/shared/rubric.js'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'src', 'adapters', 'repo', 'migrations')

function input(title: string, importance = 3, itemId: string | null = null): RubricItemInput {
  return { itemId, title, description: '', importance }
}

describe('평가 지침 모음', () => {
  let db: ReturnType<typeof openDatabase>['db']
  let documents: DocumentRepository
  let rubric: RubricService
  let library: RubricLibraryService
  let clock = 0

  function addDocument(id: string, subject: string | null = '일반화학실험'): void {
    documents.createDocument({ id, path: `/tmp/${id}.hwpx`, displayName: `${id}.hwpx`, subject,
      createdAt: '2026-09-22T00:00:00.000Z' })
  }

  function current(documentId: string) {
    const editor = rubric.getEditor(documentId)
    if (!editor.ok) throw new Error(editor.message)
    return editor.state.current
  }

  function create(name = '화학 기본', items = [input('실험 목적', 4), input('고찰', 5)]) {
    const created = library.create(name, items)
    if (!created.ok) throw new Error(created.message)
    return created.template
  }

  beforeEach(() => {
    ;({ db } = openDatabase({ file: ':memory:', migrationsDir: MIGRATIONS_DIR }))
    documents = createDocumentRepository(db)
    // 최근 순서를 가리기 위해 시계는 한 번 부를 때마다 1초씩 간다.
    const now = (): string => new Date(Date.UTC(2026, 8, 22, 0, 0, clock++)).toISOString()
    rubric = createRubricService({ documents, rubrics: createRubricRepository(db),
      suggester: UNAVAILABLE_SUGGESTER, now, newId: randomUUID })
    library = createRubricLibraryService({ library: createRubricLibraryRepository(db), rubric, documents,
      now, newId: randomUUID })
    addDocument('doc-1')
    addDocument('doc-2')
  })
  afterEach(() => db.close())

  it('모음에 만들기만 해서는 어느 보고서에도 적용되지 않는다', () => {
    create()
    expect(current('doc-1')).toBeNull()
    expect(library.list()[0]?.followingDocumentIds).toEqual([])
  })

  it('이름이 비었거나 항목이 없으면 만들지 않는다', () => {
    expect(library.create('  ', [input('고찰')]).ok).toBe(false)
    expect(library.create('빈 지침', []).ok).toBe(false)
    expect(library.list()).toEqual([])
  })

  it('적용하면 같은 내용·같은 항목 식별자로 보고서의 확정 지침이 생긴다', () => {
    const template = create()
    const applied = library.apply('doc-1', template.id)
    expect(applied).toMatchObject({ ok: true, ordinal: 1 })

    const confirmed = current('doc-1')!
    expect(confirmed.items.map((item) => item.title)).toEqual(['실험 목적', '고찰'])
    expect(confirmed.items.map((item) => item.itemId)).toEqual(template.items.map((item) => item.itemId))
    expect(library.linkOf('doc-1')).toEqual({ templateId: template.id, templateName: '화학 기본', following: true })
  })

  it('모음 지침을 고쳐 저장하면 따라가는 보고서마다 새 확정 버전이 생긴다', () => {
    const template = create()
    library.apply('doc-1', template.id)
    library.apply('doc-2', template.id)

    const items = template.items.map((item) => ({ ...item }))
    items[1] = { ...items[1]!, importance: 3 }
    const updated = library.update(template.id, '화학 기본', items)
    expect(updated).toMatchObject({ ok: true, updatedDocuments: 2 })

    for (const documentId of ['doc-1', 'doc-2']) {
      const confirmed = current(documentId)!
      expect(confirmed.ordinal).toBe(2)
      expect(confirmed.items[1]?.importance).toBe(3)
    }
  })

  it('보고서에서 따로 고치면 따라가기를 멈추고, 모음을 고쳐도 그 보고서는 그대로다', () => {
    const template = create()
    library.apply('doc-1', template.id)
    library.apply('doc-2', template.id)

    const local = [...template.items.map((item) => ({ ...item })), input('참고문헌', 2)]
    const confirmed = library.confirmForDocument('doc-1', local)
    expect(confirmed.ok).toBe(true)
    expect(library.linkOf('doc-1')?.following).toBe(false)

    const renamed = template.items.map((item) => ({ ...item, title: `${item.title}(개정)` }))
    const updated = library.update(template.id, '화학 기본', renamed)
    expect(updated).toMatchObject({ ok: true, updatedDocuments: 1 })

    expect(current('doc-1')!.items.map((item) => item.title)).toEqual(['실험 목적', '고찰', '참고문헌'])
    expect(current('doc-2')!.items.map((item) => item.title)).toEqual(['실험 목적(개정)', '고찰(개정)'])
  })

  it('보고서에서 고친 내용을 모음 지침과 같게 되돌리면 다시 따라간다', () => {
    const template = create()
    library.apply('doc-1', template.id)
    library.confirmForDocument('doc-1', [input('다른 것')])
    expect(library.linkOf('doc-1')?.following).toBe(false)

    library.confirmForDocument('doc-1', template.items.map((item) => ({ ...item })))
    expect(library.linkOf('doc-1')?.following).toBe(true)
  })

  it('따라가는 보고서에서 쓰던 초안은 모음을 고쳐도 지워지지 않는다', () => {
    const template = create()
    library.apply('doc-1', template.id)
    rubric.saveDraft('doc-1', [input('쓰는 중인 항목')])

    library.update(template.id, '화학 기본', [input('새 항목', 3)])

    const editor = rubric.getEditor('doc-1')
    if (!editor.ok) throw new Error(editor.message)
    expect(editor.state.draft?.items.map((item) => item.title)).toEqual(['쓰는 중인 항목'])
    expect(editor.state.current?.items.map((item) => item.title)).toEqual(['새 항목'])
  })

  it('모음 지침을 지워도 보고서의 확정 지침은 남고 따라가기만 끊긴다', () => {
    const template = create()
    library.apply('doc-1', template.id)

    expect(library.remove(template.id)).toEqual({ ok: true, unlinkedDocuments: 1 })
    expect(library.list()).toEqual([])
    expect(library.linkOf('doc-1')).toBeNull()
    expect(current('doc-1')!.items.map((item) => item.title)).toEqual(['실험 목적', '고찰'])
  })

  it('보고서의 확정 지침을 모음에 저장하면 그 지침을 따라가게 된다', () => {
    rubric.confirm('doc-1', [input('결과 해석', 5)])
    const saved = library.saveDocumentRubric('doc-1', '내가 만든 지침')
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.template.items.map((item) => item.title)).toEqual(['결과 해석'])
    expect(library.linkOf('doc-1')).toMatchObject({ templateName: '내가 만든 지침', following: true })
    // 저장만 했을 뿐 새 확정 버전이 생기지 않는다.
    expect(current('doc-1')!.ordinal).toBe(1)
  })

  it('확정한 지침이 없는 보고서는 모음에 저장하지 않는다', () => {
    expect(library.saveDocumentRubric('doc-1', '빈 것').ok).toBe(false)
  })

  it('새 보고서에는 같은 과목에 마지막으로 적용한 지침을 먼저 골라 둔다 (적용은 하지 않는다)', () => {
    const chemistry = create('화학 기본')
    create('물리 기본')
    library.apply('doc-1', chemistry.id)
    addDocument('doc-3', '일반화학실험')

    expect(library.suggestedFor('일반화학실험')).toBe(chemistry.id)
    expect(current('doc-3')).toBeNull()
    // 과목이 맞는 기록이 없으면 가장 최근에 고친 지침이다.
    expect(library.suggestedFor('물리학실험')).toBe(library.list()[0]!.id)
  })

  it('모음이 비어 있으면 골라 둘 지침이 없다', () => {
    expect(library.suggestedFor('일반화학실험')).toBeNull()
  })
})
