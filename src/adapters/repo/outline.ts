/**
 * 보고서 목차 저장소 ([Q-47]). 검사를 통과한 제목 목록만 받는다 (`app/document-outline.ts`).
 */
import type Database from 'better-sqlite3'

export interface StoredOutlineItem {
  paragraphUuid: string
  level: number
  title: string
}

export interface StoredOutline {
  documentId: string
  signature: string
  modelId: string
  promptVersion: string
  items: StoredOutlineItem[]
  createdAt: string
}

export interface OutlineRepository {
  get(documentId: string): StoredOutline | null
  save(outline: StoredOutline): void
}

function isItem(value: unknown): value is StoredOutlineItem {
  if (typeof value !== 'object' || value === null) return false
  const { paragraphUuid, level, title } = value as Record<string, unknown>
  return typeof paragraphUuid === 'string' && typeof level === 'number' && typeof title === 'string'
}

export function createOutlineRepository(db: Database.Database): OutlineRepository {
  const select = db.prepare('SELECT * FROM document_outline WHERE document_id = ?')
  const upsert = db.prepare(`INSERT INTO document_outline
    (document_id, signature, model_id, prompt_version, items_json, created_at)
    VALUES (@documentId, @signature, @modelId, @promptVersion, @itemsJson, @createdAt)
    ON CONFLICT(document_id) DO UPDATE SET signature = excluded.signature, model_id = excluded.model_id,
      prompt_version = excluded.prompt_version, items_json = excluded.items_json, created_at = excluded.created_at`)
  return {
    get(documentId): StoredOutline | null {
      const row = select.get(documentId) as {
        document_id: string; signature: string; model_id: string; prompt_version: string
        items_json: string; created_at: string
      } | undefined
      if (row === undefined) return null
      let items: unknown
      try { items = JSON.parse(row.items_json) } catch { return null }
      if (!Array.isArray(items) || !items.every(isItem)) return null
      return { documentId: row.document_id, signature: row.signature, modelId: row.model_id,
        promptVersion: row.prompt_version, items, createdAt: row.created_at }
    },
    save(outline): void {
      upsert.run({ ...outline, itemsJson: JSON.stringify(outline.items) })
    },
  }
}
