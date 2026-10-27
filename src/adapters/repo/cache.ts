/** SQLite 검토 캐시. 캐시에는 검증을 통과한 피드백 템플릿만 들어간다. */
import type Database from 'better-sqlite3'

import type { FeedbackItem } from '../model/schema.js'
import type { CacheKeyParts } from '../../core/cache/key.js'

/** 요청·응답 식별자는 재사용하지 않는다. 새 검토 기록에 맞춰 다시 발급한다. */
export type CachedFeedbackItem = Omit<FeedbackItem, 'itemId'>

export interface CachedReview {
  key: string
  summary: string
  items: CachedFeedbackItem[]
}

export interface ReviewCacheRepository {
  get(key: string): CachedReview | null
  put(entry: CachedReview & { parts: CacheKeyParts; createdAt: string }): void
}

interface CacheRow {
  cache_key: string
  summary: string
  items_json: string
}

function restore(row: CacheRow): CachedReview | null {
  try {
    const items = JSON.parse(row.items_json) as unknown
    if (!Array.isArray(items) || typeof row.summary !== 'string') return null
    return { key: row.cache_key, summary: row.summary, items: items as CachedFeedbackItem[] }
  } catch {
    // 캐시는 최적화일 뿐이다. 손상된 행은 재사용하지 않고 모델 검증 경로로 다시 간다.
    return null
  }
}

export function createReviewCacheRepository(db: Database.Database): ReviewCacheRepository {
  const select = db.prepare('SELECT cache_key, summary, items_json FROM review_cache WHERE cache_key = ?')
  const upsert = db.prepare(
    `INSERT INTO review_cache
       (cache_key, paragraph_hash, rubric_version, prompt_version, model_id, perspective, stage, scope,
        sentence_hash, summary, items_json, created_at)
     VALUES
       (@cache_key, @paragraph_hash, @rubric_version, @prompt_version, @model_id, @perspective, @stage, @scope,
        @sentence_hash, @summary, @items_json, @created_at)
     ON CONFLICT(cache_key) DO UPDATE SET summary = excluded.summary,
       items_json = excluded.items_json, created_at = excluded.created_at`,
  )

  return {
    get(key): CachedReview | null {
      const row = select.get(key) as CacheRow | undefined
      return row === undefined ? null : restore(row)
    },
    put(entry): void {
      upsert.run({
        cache_key: entry.key,
        paragraph_hash: entry.parts.paragraphHash,
        rubric_version: entry.parts.rubricVersion,
        prompt_version: entry.parts.promptVersion,
        model_id: entry.parts.modelId,
        perspective: entry.parts.perspective,
        stage: entry.parts.stage,
        scope: entry.parts.scope,
        sentence_hash: entry.parts.sentenceHash,
        summary: entry.summary,
        items_json: JSON.stringify(entry.items),
        created_at: entry.createdAt,
      })
    },
  }
}
