import type Database from 'better-sqlite3'
import type { GrowthSummary, PersonalGuideline, SelfAssessment, UserReaction } from '../../shared/personalization.js'

export function createPersonalizationRepository(db: Database.Database) {
  return {
    /** 같은 SQLite 연결의 쓰기를 감지해 파생 집계 캐시를 무효화한다. */
    revision(): number {
      return (db.prepare('SELECT total_changes() AS revision').get() as {revision:number}).revision
    },
    reactions: (): UserReaction[] => db.prepare(`SELECT feedback_id AS feedbackId, document_id AS documentId,
      kind, reason, updated_at AS updatedAt FROM user_reaction ORDER BY updated_at, feedback_id`).all() as UserReaction[],
    assessments: (): SelfAssessment[] => db.prepare(`SELECT a.id, a.document_id AS documentId, a.version_id AS versionId,
      v.ordinal AS versionOrdinal, a.phase, a.text, a.updated_at AS updatedAt FROM self_assessment a
      JOIN document_version v ON v.id=a.version_id ORDER BY a.updated_at DESC, a.id`).all() as SelfAssessment[],
    guidelines: (): PersonalGuideline[] => db.prepare(`SELECT id,text,scope,document_id AS documentId,subject,
      approved_at AS approvedAt,revision FROM personal_guideline ORDER BY id`).all() as PersonalGuideline[],
    annotations: () => db.prepare('SELECT feedback_id AS id, note, excluded FROM observation_annotation').all() as
      { id: string; note: string; excluded: number }[],
    summary(): GrowthSummary | null {
      const row = db.prepare('SELECT payload FROM growth_summary LIMIT 1').get() as { payload: string } | undefined
      return row === undefined ? null : JSON.parse(row.payload) as GrowthSummary
    },
    saveReaction(row: UserReaction): void {
      db.prepare(`INSERT INTO user_reaction VALUES (@feedbackId,@documentId,@kind,@reason,@updatedAt)
        ON CONFLICT(feedback_id) DO UPDATE SET kind=excluded.kind,reason=excluded.reason,updated_at=excluded.updated_at`).run(row)
    },
    saveAssessment(row: SelfAssessment): void {
      db.prepare(`INSERT INTO self_assessment VALUES (@id,@documentId,@versionId,@phase,@text,@updatedAt)
        ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,text=excluded.text,updated_at=excluded.updated_at`).run(row)
    },
    saveGuideline(row: PersonalGuideline): void {
      db.prepare(`INSERT INTO personal_guideline VALUES (@id,@text,@scope,@documentId,@subject,@approvedAt,@revision)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text,scope=excluded.scope,document_id=excluded.document_id,
        subject=excluded.subject,approved_at=excluded.approved_at,revision=excluded.revision`).run(row)
    },
    annotate(id: string, note: string, excluded = false): void {
      db.prepare(`INSERT INTO observation_annotation VALUES (?,?,?) ON CONFLICT(feedback_id)
        DO UPDATE SET note=excluded.note,excluded=excluded.excluded`).run(id, note, excluded ? 1 : 0)
    },
    remove(kind: 'reaction' | 'assessment' | 'guideline' | 'summary', id: string): void {
      const tables = { reaction: ['user_reaction','feedback_id'], assessment: ['self_assessment','id'],
        guideline: ['personal_guideline','id'], summary: ['growth_summary','id'] } as const
      const [table, column] = tables[kind]
      db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(id)
    },
    invalidateSummary(): void { db.prepare('DELETE FROM growth_summary').run() },
    saveSummary(summary: GrowthSummary): void {
      db.transaction(() => {
        db.prepare('DELETE FROM growth_summary').run()
        db.prepare('INSERT INTO growth_summary VALUES (?,?)').run(summary.id, JSON.stringify(summary))
      })()
    },
    transaction(action: () => void): void { db.transaction(action)() },
  }
}
export type PersonalizationRepository = ReturnType<typeof createPersonalizationRepository>
