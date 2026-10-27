/**
 * 평가 지침 모음 저장소 (SQLite, [Q-40]).
 *
 * 모음의 지침과, 보고서가 어느 모음 지침을 따르는지만 둔다. 보고서에 실제로 적용되는 확정 지침은
 * `rubric.ts` 의 `rubric_version` 에 있다. 적용·따라가기의 판단은 앱 계층이 한다 (`CLAUDE.md` §2).
 */
import type Database from 'better-sqlite3'

import type { RubricItem } from '../../core/rubric/model.js'
import type { RubricImportance } from '../../shared/rubric.js'

export interface RubricTemplateRow {
  id: string
  name: string
  items: RubricItem[]
  createdAt: string
  updatedAt: string
}

export interface RubricLinkRow {
  documentId: string
  templateId: string
  /** false 면 "보고서에서 고침". 모음을 고쳐도 이 보고서는 따라가지 않는다 */
  following: boolean
  appliedAt: string
}

export interface RubricLibraryRepository {
  /** 최근에 고친 것이 앞에 온다 */
  listTemplates(): RubricTemplateRow[]
  getTemplate(id: string): RubricTemplateRow | null
  /** 없으면 만들고, 있으면 이름과 항목을 통째로 바꾼다 */
  saveTemplate(row: RubricTemplateRow): void
  /** 지우면 그 지침을 따르던 연결도 함께 지워진다. 보고서의 확정 지침은 남는다 */
  deleteTemplate(id: string): void
  getLink(documentId: string): RubricLinkRow | null
  listLinks(): RubricLinkRow[]
  setLink(row: RubricLinkRow): void
  deleteLink(documentId: string): void
  /** 여러 저장을 한 번에 한다. 도중에 예외가 나면 모두 되돌린다 */
  transaction<T>(work: () => T): T
}

interface TemplateRecord { id: string; name: string; created_at: string; updated_at: string }
interface ItemRecord { item_id: string; title: string; description: string; importance: number }
interface LinkRecord { document_id: string; template_id: string; following: number; applied_at: string }

function toLink(record: LinkRecord): RubricLinkRow {
  return {
    documentId: record.document_id,
    templateId: record.template_id,
    following: record.following === 1,
    appliedAt: record.applied_at,
  }
}

export function createRubricLibraryRepository(db: Database.Database): RubricLibraryRepository {
  const selectTemplates = db.prepare('SELECT * FROM rubric_template ORDER BY updated_at DESC, id')
  const selectTemplate = db.prepare('SELECT * FROM rubric_template WHERE id = ?')
  const selectItems = db.prepare(
    `SELECT item_id, title, description, importance FROM rubric_template_item
     WHERE template_id = ? ORDER BY position`,
  )
  const upsertTemplate = db.prepare(
    `INSERT INTO rubric_template (id, name, created_at, updated_at) VALUES (@id, @name, @created_at, @updated_at)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  )
  const deleteItems = db.prepare('DELETE FROM rubric_template_item WHERE template_id = ?')
  const insertItem = db.prepare(
    `INSERT INTO rubric_template_item (template_id, position, item_id, title, description, importance)
     VALUES (@template_id, @position, @item_id, @title, @description, @importance)`,
  )
  const removeTemplate = db.prepare('DELETE FROM rubric_template WHERE id = ?')
  const selectLink = db.prepare('SELECT * FROM document_rubric_link WHERE document_id = ?')
  const selectLinks = db.prepare('SELECT * FROM document_rubric_link ORDER BY applied_at DESC, document_id')
  const upsertLink = db.prepare(
    `INSERT INTO document_rubric_link (document_id, template_id, following, applied_at)
     VALUES (@document_id, @template_id, @following, @applied_at)
     ON CONFLICT (document_id) DO UPDATE SET template_id = excluded.template_id,
       following = excluded.following, applied_at = excluded.applied_at`,
  )
  const removeLink = db.prepare('DELETE FROM document_rubric_link WHERE document_id = ?')

  function restore(record: TemplateRecord): RubricTemplateRow {
    return {
      id: record.id,
      name: record.name,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
      items: (selectItems.all(record.id) as ItemRecord[]).map((item) => ({
        itemId: item.item_id,
        title: item.title,
        description: item.description,
        // 스키마의 CHECK 가 1~5 만 받는다.
        importance: item.importance as RubricImportance,
      })),
    }
  }

  const saveTx = db.transaction((row: RubricTemplateRow) => {
    upsertTemplate.run({ id: row.id, name: row.name, created_at: row.createdAt, updated_at: row.updatedAt })
    deleteItems.run(row.id)
    row.items.forEach((item, position) => {
      insertItem.run({
        template_id: row.id,
        position,
        item_id: item.itemId,
        title: item.title,
        description: item.description,
        importance: item.importance,
      })
    })
  })

  return {
    listTemplates: () => (selectTemplates.all() as TemplateRecord[]).map(restore),
    getTemplate(id) {
      const record = selectTemplate.get(id) as TemplateRecord | undefined
      return record === undefined ? null : restore(record)
    },
    saveTemplate: (row) => { saveTx(row) },
    deleteTemplate: (id) => { removeTemplate.run(id) },
    getLink(documentId) {
      const record = selectLink.get(documentId) as LinkRecord | undefined
      return record === undefined ? null : toLink(record)
    },
    listLinks: () => (selectLinks.all() as LinkRecord[]).map(toLink),
    setLink(row) {
      upsertLink.run({
        document_id: row.documentId,
        template_id: row.templateId,
        following: row.following ? 1 : 0,
        applied_at: row.appliedAt,
      })
    },
    deleteLink: (documentId) => { removeLink.run(documentId) },
    transaction: <T>(work: () => T): T => db.transaction(work)(),
  }
}
