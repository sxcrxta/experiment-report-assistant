/**
 * 평가 지침 저장소 (SQLite).
 *
 * 초안과 확정 지침을 다른 테이블에 둔다. 확정 지침은 읽을 때마다 `restoreConfirmedRubric` 로 검증해
 * 되살린다. 확정할 때와 내용이 달라졌으면 확정 지침으로 돌려주지 않고 예외를 던진다.
 *
 * 여기에는 판단이 없다. 무엇을 확정할지, 버전을 새로 만들지는 앱 계층과 코어가 정한다 (`CLAUDE.md` §2).
 */
import type Database from 'better-sqlite3'

import { CONTEXT_ORDINAL } from './review-context.js'

import {
  assertConfirmedRubric,
  restoreConfirmedRubric,
  type ConfirmedRubric,
  type RubricDraft,
  type RubricItem,
} from '../../core/rubric/model.js'
import type { RubricImportance } from '../../shared/rubric.js'

export interface RubricRepository {
  getDraft(documentId: string): RubricDraft | null
  /** 문서의 초안을 통째로 바꾼다 */
  saveDraft(draft: RubricDraft): void
  deleteDraft(documentId: string): void

  /** 가장 최근에 확정한 지침. 확정한 적이 없으면 null */
  latestConfirmed(documentId: string): ConfirmedRubric | null
  /** 확정한 순서대로 (버전 1 이 맨 앞) */
  listConfirmed(documentId: string): ConfirmedRubric[]
  getConfirmed(rubricVersion: string): ConfirmedRubric | null
  /** 확정 지침을 넣고, 같은 트랜잭션에서 그 문서의 초안을 지운다 */
  appendConfirmed(rubric: ConfirmedRubric): void
}

interface DraftRecord {
  document_id: string
  updated_at: string
}

interface ItemRecord {
  item_id: string
  title: string
  description: string
  importance: number
}

interface VersionRecord {
  rubric_version: string
  document_id: string
  ordinal: number
  content_hash: string
  confirmed_at: string
}

function toItem(record: ItemRecord): RubricItem {
  return {
    itemId: record.item_id,
    title: record.title,
    description: record.description,
    // 스키마의 CHECK 가 1~5 만 받는다. 확정 지침은 되살릴 때 코어가 한 번 더 검사한다.
    importance: record.importance as RubricImportance,
  }
}

export function createRubricRepository(db: Database.Database): RubricRepository {
  const selectDraft = db.prepare('SELECT * FROM rubric_draft WHERE document_id = ?')
  const selectDraftItems = db.prepare(
    `SELECT item_id, title, description, importance FROM rubric_draft_item
     WHERE document_id = ? ORDER BY position`,
  )
  const upsertDraft = db.prepare(
    `INSERT INTO rubric_draft (document_id, updated_at) VALUES (?, ?)
     ON CONFLICT (document_id) DO UPDATE SET updated_at = excluded.updated_at`,
  )
  const deleteDraftItems = db.prepare('DELETE FROM rubric_draft_item WHERE document_id = ?')
  const insertDraftItem = db.prepare(
    `INSERT INTO rubric_draft_item (document_id, position, item_id, title, description, importance)
     VALUES (@document_id, @position, @item_id, @title, @description, @importance)`,
  )
  const deleteDraftRow = db.prepare('DELETE FROM rubric_draft WHERE document_id = ?')

  const selectLatest = db.prepare(
    `SELECT * FROM rubric_version WHERE document_id = ? AND ordinal < ${CONTEXT_ORDINAL} ORDER BY ordinal DESC LIMIT 1`,
  )
  const selectVersions = db.prepare(
    `SELECT * FROM rubric_version WHERE document_id = ? AND ordinal < ${CONTEXT_ORDINAL} ORDER BY ordinal`,
  )
  // 검토 맥락 행([Q-48])은 지침이 아니다. 이력·최신·버전 조회 어디에도 나오지 않게 뺀다.
  const selectVersion = db.prepare(`SELECT * FROM rubric_version WHERE rubric_version = ? AND ordinal < ${CONTEXT_ORDINAL}`)
  const selectVersionItems = db.prepare(
    `SELECT item_id, title, description, importance FROM rubric_item
     WHERE rubric_version = ? ORDER BY position`,
  )
  const insertVersion = db.prepare(
    `INSERT INTO rubric_version (rubric_version, document_id, ordinal, content_hash, confirmed_at)
     VALUES (@rubric_version, @document_id, @ordinal, @content_hash, @confirmed_at)`,
  )
  const insertVersionItem = db.prepare(
    `INSERT INTO rubric_item (rubric_version, position, item_id, title, description, importance)
     VALUES (@rubric_version, @position, @item_id, @title, @description, @importance)`,
  )

  function restore(record: VersionRecord): ConfirmedRubric {
    const items = (selectVersionItems.all(record.rubric_version) as ItemRecord[]).map(toItem)
    return restoreConfirmedRubric({
      documentId: record.document_id,
      ordinal: record.ordinal,
      rubricVersion: record.rubric_version,
      contentHash: record.content_hash,
      items,
      confirmedAt: record.confirmed_at,
    })
  }

  const saveDraftTx = db.transaction((draft: RubricDraft) => {
    upsertDraft.run(draft.documentId, draft.updatedAt)
    deleteDraftItems.run(draft.documentId)
    draft.items.forEach((item, position) => {
      insertDraftItem.run({
        document_id: draft.documentId,
        position,
        item_id: item.itemId,
        title: item.title,
        description: item.description,
        importance: item.importance,
      })
    })
  })

  const deleteDraftTx = db.transaction((documentId: string) => {
    deleteDraftItems.run(documentId)
    deleteDraftRow.run(documentId)
  })

  const appendConfirmedTx = db.transaction((rubric: ConfirmedRubric) => {
    insertVersion.run({
      rubric_version: rubric.rubricVersion,
      document_id: rubric.documentId,
      ordinal: rubric.ordinal,
      content_hash: rubric.contentHash,
      confirmed_at: rubric.confirmedAt,
    })
    rubric.items.forEach((item, position) => {
      insertVersionItem.run({
        rubric_version: rubric.rubricVersion,
        position,
        item_id: item.itemId,
        title: item.title,
        description: item.description,
        importance: item.importance,
      })
    })
    deleteDraftTx(rubric.documentId)
  })

  return {
    getDraft(documentId): RubricDraft | null {
      const record = selectDraft.get(documentId) as DraftRecord | undefined
      if (record === undefined) return null
      return {
        status: 'draft',
        documentId: record.document_id,
        items: (selectDraftItems.all(documentId) as ItemRecord[]).map(toItem),
        updatedAt: record.updated_at,
      }
    },

    saveDraft(draft): void {
      saveDraftTx(draft)
    },

    deleteDraft(documentId): void {
      deleteDraftTx(documentId)
    },

    latestConfirmed(documentId): ConfirmedRubric | null {
      const record = selectLatest.get(documentId) as VersionRecord | undefined
      return record === undefined ? null : restore(record)
    },

    listConfirmed(documentId): ConfirmedRubric[] {
      return (selectVersions.all(documentId) as VersionRecord[]).map(restore)
    },

    getConfirmed(rubricVersion): ConfirmedRubric | null {
      const record = selectVersion.get(rubricVersion) as VersionRecord | undefined
      return record === undefined ? null : restore(record)
    },

    appendConfirmed(rubric): void {
      // 확정 지침 자리에 초안이 들어오면 저장하지 않는다. 타입을 속였어도 여기서 멈춘다.
      assertConfirmedRubric(rubric)
      appendConfirmedTx(rubric)
    },
  }
}
