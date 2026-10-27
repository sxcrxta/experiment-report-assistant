/**
 * 문서·버전·문단·계보·변경·체크포인트 저장소 (SQLite).
 *
 * IMPLEMENTATION_PLAN.md §1.8 의 저장 모델 중 2단계 부분이다.
 * 여기에는 판단이 없다. 해시 비교·Diff·문단 추적은 코어가 끝낸 뒤 결과만 들어온다
 * (`CLAUDE.md` §2).
 */
import type Database from 'better-sqlite3'

import type { LineageRecord, ParagraphChange, PreviousParagraph } from '../../core/diff/track.js'
import type { Paragraph, ParagraphRole } from '../../core/document/model.js'

export interface DocumentRow {
  id: string
  /** NFC 로 정규화된 절대 경로 */
  path: string
  displayName: string
  subject: string | null
  createdAt: string
  pathLost: boolean
}

export interface DocumentVersionRow {
  id: string
  documentId: string
  ordinal: number
  detectedAt: string
  sourcePath: string
  byteSize: number
  contentHash: string
  paragraphCount: number
}

export interface DiffEntryRow {
  change: ParagraphChange | 'deleted'
  paragraphUuid: string
  previousParagraphUuid: string | null
  paraIndex: number | null
}

export interface CheckpointRow {
  id: string
  documentId: string
  versionId: string
  kind: 'initial' | 'user'
  filePath: string
  byteSize: number
  contentHash: string
  label: string | null
  createdAt: string
}

/** 저장할 문단. uuid 는 문단 추적이 정한 값이고, 나머지는 읽어 온 문단 그대로다. */
export interface ParagraphInput {
  uuid: string
  paragraph: Paragraph
}

export interface AppendVersionInput {
  id: string
  documentId: string
  detectedAt: string
  sourcePath: string
  byteSize: number
  contentHash: string
  paragraphs: readonly ParagraphInput[]
  lineage: readonly LineageRecord[]
  diffEntries: readonly DiffEntryRow[]
  /** 이 버전이 비교한 이전 버전. 최초본이면 null */
  previousVersionId: string | null
}

export interface DocumentRepository {
  createDocument(input: Omit<DocumentRow, 'pathLost'>): DocumentRow
  getDocument(id: string): DocumentRow | null
  findDocumentByPath(path: string): DocumentRow | null
  listDocuments(): DocumentRow[]
  updateDocumentPath(id: string, path: string, displayName: string): void
  setPathLost(id: string, lost: boolean): void
  setSubject(id: string, subject: string | null): void

  /** 보고서 목록에 보여 줄 한 문단 요약. 없으면 null ([Q-36]) */
  getSummary(documentId: string): DocumentSummaryRow | null
  saveSummary(row: DocumentSummaryRow): void

  appendVersion(input: AppendVersionInput): DocumentVersionRow
  latestVersion(documentId: string): DocumentVersionRow | null
  getVersion(id: string): DocumentVersionRow | null
  listVersions(documentId: string): DocumentVersionRow[]

  listParagraphs(versionId: string): ParagraphInput[]
  /** 문단 추적에 필요한 최소 정보만 */
  listPreviousParagraphs(versionId: string): PreviousParagraph[]
  listLineage(versionId: string): LineageRecord[]
  listDiffEntries(versionId: string): DiffEntryRow[]

  addCheckpoint(row: CheckpointRow): CheckpointRow
  listCheckpoints(documentId: string): CheckpointRow[]
  getCheckpoint(id: string): CheckpointRow | null
  /** 사용자가 남긴 체크포인트 하나를 지운다. 최초본은 지우지 않는다 */
  deleteCheckpoint(id: string): void

  /** 보고서와 이 앱에 쌓인 그 보고서의 기록 전부를 지운다 (연결된 표는 ON DELETE CASCADE) */
  deleteDocument(id: string): void
}

interface DocumentRecord {
  id: string
  path: string
  display_name: string
  subject: string | null
  created_at: string
  path_lost: number
}

interface VersionRecord {
  id: string
  document_id: string
  ordinal: number
  detected_at: string
  source_path: string
  byte_size: number
  content_hash: string
  paragraph_count: number
}

interface ParagraphRecord {
  uuid: string
  para_index: number
  section_index: number
  role: string
  heading_level: number | null
  style_name: string | null
  table_index: number | null
  table_row: number | null
  table_col: number | null
  text: string
  equations: string
  hash: string
}

interface LineageRecordRow {
  child_uuid: string
  parent_uuid: string
  relation: 'split' | 'merge'
}

interface DiffRecord {
  change: string
  paragraph_uuid: string
  previous_paragraph_uuid: string | null
  para_index: number | null
}

/** 한 문단 요약. 어느 버전을 보고 어느 모델이 썼는지 함께 남긴다. */
export interface DocumentSummaryRow {
  documentId: string
  versionId: string
  text: string
  modelId: string
  promptVersion: string
  createdAt: string
}

interface SummaryRecord {
  version_id: string
  text: string
  model_id: string
  prompt_version: string
  created_at: string
}

interface CheckpointRecord {
  id: string
  document_id: string
  version_id: string
  kind: 'initial' | 'user'
  file_path: string
  byte_size: number
  content_hash: string
  label: string | null
  created_at: string
}

function toDocument(record: DocumentRecord): DocumentRow {
  return {
    id: record.id,
    path: record.path,
    displayName: record.display_name,
    subject: record.subject,
    createdAt: record.created_at,
    pathLost: record.path_lost === 1,
  }
}

function toVersion(record: VersionRecord): DocumentVersionRow {
  return {
    id: record.id,
    documentId: record.document_id,
    ordinal: record.ordinal,
    detectedAt: record.detected_at,
    sourcePath: record.source_path,
    byteSize: record.byte_size,
    contentHash: record.content_hash,
    paragraphCount: record.paragraph_count,
  }
}

function toParagraph(record: ParagraphRecord): ParagraphInput {
  const equations = JSON.parse(record.equations) as string[]
  return {
    uuid: record.uuid,
    paragraph: {
      // 읽기 시점의 파생 uuid 가 아니라 추적된 uuid 를 그대로 쓴다.
      uuid: record.uuid,
      index: record.para_index,
      sectionIndex: record.section_index,
      role: record.role as ParagraphRole,
      headingLevel: record.heading_level,
      styleName: record.style_name,
      table:
        record.table_index === null || record.table_row === null || record.table_col === null
          ? null
          : { tableIndex: record.table_index, row: record.table_row, col: record.table_col },
      // 원문은 다시 만들 수 없다. 비교와 표시의 기준은 정규화된 text 다.
      rawText: record.text,
      text: record.text,
      equations,
      hash: record.hash,
    },
  }
}

export function createDocumentRepository(db: Database.Database): DocumentRepository {
  const insertDocument = db.prepare(
    `INSERT INTO document (id, path, display_name, subject, created_at, path_lost)
     VALUES (@id, @path, @display_name, @subject, @created_at, 0)`,
  )
  const selectDocumentById = db.prepare('SELECT * FROM document WHERE id = ?')
  const selectDocumentByPath = db.prepare('SELECT * FROM document WHERE path = ?')
  const selectDocuments = db.prepare('SELECT * FROM document ORDER BY created_at, id')
  const updatePath = db.prepare(
    'UPDATE document SET path = ?, display_name = ?, path_lost = 0 WHERE id = ?',
  )
  const updatePathLost = db.prepare('UPDATE document SET path_lost = ? WHERE id = ?')
  const updateSubject = db.prepare('UPDATE document SET subject = ? WHERE id = ?')
  const selectSummary = db.prepare(
    'SELECT version_id, text, model_id, prompt_version, created_at FROM document_summary WHERE document_id = ?',
  )
  const upsertSummary = db.prepare(
    `INSERT INTO document_summary (document_id, version_id, text, model_id, prompt_version, created_at)
     VALUES (@documentId, @versionId, @text, @modelId, @promptVersion, @createdAt)
     ON CONFLICT(document_id) DO UPDATE SET
       version_id = excluded.version_id, text = excluded.text, model_id = excluded.model_id,
       prompt_version = excluded.prompt_version, created_at = excluded.created_at`,
  )

  const nextOrdinal = db.prepare(
    'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM document_version WHERE document_id = ?',
  )
  const insertVersion = db.prepare(
    `INSERT INTO document_version
       (id, document_id, ordinal, detected_at, source_path, byte_size, content_hash, paragraph_count)
     VALUES (@id, @document_id, @ordinal, @detected_at, @source_path, @byte_size, @content_hash,
             @paragraph_count)`,
  )
  const selectVersionById = db.prepare('SELECT * FROM document_version WHERE id = ?')
  const selectLatestVersion = db.prepare(
    'SELECT * FROM document_version WHERE document_id = ? ORDER BY ordinal DESC LIMIT 1',
  )
  const selectVersions = db.prepare(
    'SELECT * FROM document_version WHERE document_id = ? ORDER BY ordinal',
  )

  const insertParagraph = db.prepare(
    `INSERT INTO paragraph
       (version_id, uuid, para_index, section_index, role, heading_level, style_name,
        table_index, table_row, table_col, text, equations, hash)
     VALUES (@version_id, @uuid, @para_index, @section_index, @role, @heading_level, @style_name,
             @table_index, @table_row, @table_col, @text, @equations, @hash)`,
  )
  const selectParagraphs = db.prepare(
    'SELECT * FROM paragraph WHERE version_id = ? ORDER BY para_index',
  )
  const selectPreviousParagraphs = db.prepare(
    'SELECT uuid, hash, text FROM paragraph WHERE version_id = ? ORDER BY para_index',
  )

  const insertLineage = db.prepare(
    `INSERT INTO paragraph_lineage (version_id, child_uuid, parent_uuid, relation)
     VALUES (@version_id, @child_uuid, @parent_uuid, @relation)`,
  )
  const selectLineage = db.prepare(
    'SELECT child_uuid, parent_uuid, relation FROM paragraph_lineage WHERE version_id = ? ORDER BY id',
  )

  const insertDiff = db.prepare(
    `INSERT INTO diff_entry
       (version_id, previous_version_id, change, paragraph_uuid, previous_paragraph_uuid, para_index)
     VALUES (@version_id, @previous_version_id, @change, @paragraph_uuid, @previous_paragraph_uuid,
             @para_index)`,
  )
  const selectDiff = db.prepare(
    `SELECT change, paragraph_uuid, previous_paragraph_uuid, para_index
     FROM diff_entry WHERE version_id = ? ORDER BY id`,
  )

  const insertCheckpoint = db.prepare(
    `INSERT INTO checkpoint
       (id, document_id, version_id, kind, file_path, byte_size, content_hash, label, created_at)
     VALUES (@id, @document_id, @version_id, @kind, @file_path, @byte_size, @content_hash, @label,
             @created_at)`,
  )
  const selectCheckpoints = db.prepare(
    'SELECT * FROM checkpoint WHERE document_id = ? ORDER BY created_at, id',
  )
  const selectCheckpointById = db.prepare('SELECT * FROM checkpoint WHERE id = ?')
  const deleteUserCheckpoint = db.prepare("DELETE FROM checkpoint WHERE id = ? AND kind = 'user'")
  const deleteDocumentRow = db.prepare('DELETE FROM document WHERE id = ?')

  /** 버전 하나를 통째로 넣는다. 도중에 실패하면 아무것도 남지 않는다. */
  const appendVersionTx = db.transaction((input: AppendVersionInput): DocumentVersionRow => {
    const { next } = nextOrdinal.get(input.documentId) as { next: number }

    insertVersion.run({
      id: input.id,
      document_id: input.documentId,
      ordinal: next,
      detected_at: input.detectedAt,
      source_path: input.sourcePath,
      byte_size: input.byteSize,
      content_hash: input.contentHash,
      paragraph_count: input.paragraphs.length,
    })

    for (const { uuid, paragraph } of input.paragraphs) {
      insertParagraph.run({
        version_id: input.id,
        uuid,
        para_index: paragraph.index,
        section_index: paragraph.sectionIndex,
        role: paragraph.role,
        heading_level: paragraph.headingLevel,
        style_name: paragraph.styleName,
        table_index: paragraph.table?.tableIndex ?? null,
        table_row: paragraph.table?.row ?? null,
        table_col: paragraph.table?.col ?? null,
        text: paragraph.text,
        equations: JSON.stringify(paragraph.equations),
        hash: paragraph.hash,
      })
    }

    for (const record of input.lineage) {
      insertLineage.run({
        version_id: input.id,
        child_uuid: record.childUuid,
        parent_uuid: record.parentUuid,
        relation: record.relation,
      })
    }

    for (const entry of input.diffEntries) {
      insertDiff.run({
        version_id: input.id,
        previous_version_id: input.previousVersionId,
        change: entry.change,
        paragraph_uuid: entry.paragraphUuid,
        previous_paragraph_uuid: entry.previousParagraphUuid,
        para_index: entry.paraIndex,
      })
    }

    return toVersion(selectVersionById.get(input.id) as VersionRecord)
  })

  return {
    createDocument(input): DocumentRow {
      insertDocument.run({
        id: input.id,
        path: input.path,
        display_name: input.displayName,
        subject: input.subject,
        created_at: input.createdAt,
      })
      return toDocument(selectDocumentById.get(input.id) as DocumentRecord)
    },

    getDocument(id): DocumentRow | null {
      const record = selectDocumentById.get(id) as DocumentRecord | undefined
      return record === undefined ? null : toDocument(record)
    },

    findDocumentByPath(path): DocumentRow | null {
      const record = selectDocumentByPath.get(path) as DocumentRecord | undefined
      return record === undefined ? null : toDocument(record)
    },

    listDocuments(): DocumentRow[] {
      return (selectDocuments.all() as DocumentRecord[]).map(toDocument)
    },

    updateDocumentPath(id, path, displayName): void {
      updatePath.run(path, displayName, id)
    },

    setPathLost(id, lost): void {
      updatePathLost.run(lost ? 1 : 0, id)
    },

    setSubject(id, subject): void {
      updateSubject.run(subject, id)
    },

    getSummary(documentId): DocumentSummaryRow | null {
      const record = selectSummary.get(documentId) as SummaryRecord | undefined
      if (record === undefined) return null
      return {
        documentId, versionId: record.version_id, text: record.text,
        modelId: record.model_id, promptVersion: record.prompt_version, createdAt: record.created_at,
      }
    },

    saveSummary(row): void {
      upsertSummary.run(row)
    },

    appendVersion(input): DocumentVersionRow {
      return appendVersionTx(input)
    },

    latestVersion(documentId): DocumentVersionRow | null {
      const record = selectLatestVersion.get(documentId) as VersionRecord | undefined
      return record === undefined ? null : toVersion(record)
    },

    getVersion(id): DocumentVersionRow | null {
      const record = selectVersionById.get(id) as VersionRecord | undefined
      return record === undefined ? null : toVersion(record)
    },

    listVersions(documentId): DocumentVersionRow[] {
      return (selectVersions.all(documentId) as VersionRecord[]).map(toVersion)
    },

    listParagraphs(versionId): ParagraphInput[] {
      return (selectParagraphs.all(versionId) as ParagraphRecord[]).map(toParagraph)
    },

    listPreviousParagraphs(versionId): PreviousParagraph[] {
      return selectPreviousParagraphs.all(versionId) as PreviousParagraph[]
    },

    listLineage(versionId): LineageRecord[] {
      return (selectLineage.all(versionId) as LineageRecordRow[]).map((row) => ({
        childUuid: row.child_uuid,
        parentUuid: row.parent_uuid,
        relation: row.relation,
      }))
    },

    listDiffEntries(versionId): DiffEntryRow[] {
      return (selectDiff.all(versionId) as DiffRecord[]).map((row) => ({
        change: row.change as DiffEntryRow['change'],
        paragraphUuid: row.paragraph_uuid,
        previousParagraphUuid: row.previous_paragraph_uuid,
        paraIndex: row.para_index,
      }))
    },

    addCheckpoint(row): CheckpointRow {
      insertCheckpoint.run({
        id: row.id,
        document_id: row.documentId,
        version_id: row.versionId,
        kind: row.kind,
        file_path: row.filePath,
        byte_size: row.byteSize,
        content_hash: row.contentHash,
        label: row.label,
        created_at: row.createdAt,
      })
      return row
    },

    listCheckpoints(documentId): CheckpointRow[] {
      return (selectCheckpoints.all(documentId) as CheckpointRecord[]).map(toCheckpoint)
    },

    getCheckpoint(id): CheckpointRow | null {
      const record = selectCheckpointById.get(id) as CheckpointRecord | undefined
      return record === undefined ? null : toCheckpoint(record)
    },

    deleteCheckpoint(id): void {
      deleteUserCheckpoint.run(id)
    },

    deleteDocument(id): void {
      deleteDocumentRow.run(id)
    },
  }
}

function toCheckpoint(record: CheckpointRecord): CheckpointRow {
  return {
    id: record.id,
    documentId: record.document_id,
    versionId: record.version_id,
    kind: record.kind,
    filePath: record.file_path,
    byteSize: record.byte_size,
    contentHash: record.content_hash,
    label: record.label,
    createdAt: record.created_at,
  }
}
