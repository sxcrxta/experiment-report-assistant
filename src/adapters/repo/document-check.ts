/**
 * 제출 점검 결과 저장소 ([Q-48]). 보고서마다 마지막 한 번만 둔다. 검사를 통과한 결과만 받는다.
 */
import type Database from 'better-sqlite3'

export interface StoredCheckResult {
  itemId: string
  title: string
  /** 충족도 0~100 ([Q-49]). 1판으로 점검한 예전 결과에는 없다 */
  score?: number
  /** 1판의 구분. 2판부터는 퍼센트에서 계산한 값을 함께 남긴다 */
  status: 'met' | 'partial' | 'missing'
  evidence: string
  /** 근거가 된 문단 번호 (1부터) */
  paragraphNumbers: number[]
}

export interface StoredCheck {
  documentId: string
  versionId: string
  /** 어느 점검표(확정 지침 버전)로 점검했는가 */
  rubricVersion: string
  modelId: string
  promptVersion: string
  results: StoredCheckResult[]
  createdAt: string
}

export interface DocumentCheckRepository {
  get(documentId: string): StoredCheck | null
  save(check: StoredCheck): void
}

export function createDocumentCheckRepository(db: Database.Database): DocumentCheckRepository {
  const select = db.prepare('SELECT * FROM document_check WHERE document_id = ?')
  const upsert = db.prepare(`INSERT INTO document_check
    (document_id, version_id, rubric_version, model_id, prompt_version, results_json, created_at)
    VALUES (@documentId, @versionId, @rubricVersion, @modelId, @promptVersion, @resultsJson, @createdAt)
    ON CONFLICT(document_id) DO UPDATE SET version_id = excluded.version_id, rubric_version = excluded.rubric_version,
      model_id = excluded.model_id, prompt_version = excluded.prompt_version, results_json = excluded.results_json,
      created_at = excluded.created_at`)
  return {
    get(documentId): StoredCheck | null {
      const row = select.get(documentId) as {
        document_id: string; version_id: string; rubric_version: string; model_id: string
        prompt_version: string; results_json: string; created_at: string
      } | undefined
      if (row === undefined) return null
      let results: unknown
      try { results = JSON.parse(row.results_json) } catch { return null }
      if (!Array.isArray(results)) return null
      return { documentId: row.document_id, versionId: row.version_id, rubricVersion: row.rubric_version,
        modelId: row.model_id, promptVersion: row.prompt_version, results: results as StoredCheckResult[],
        createdAt: row.created_at }
    },
    save(check): void {
      upsert.run({ ...check, resultsJson: JSON.stringify(check.results) })
    },
  }
}
