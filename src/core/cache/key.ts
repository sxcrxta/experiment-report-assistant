/** AI 검토 결과 캐시 키 (PRD 4.5). */
import type { ReviewPerspective, ReviewScope, ReviewStage } from '../../shared/review.js'

/**
 * 최소 키는 문단 해시·지침판·프롬프트판·모델·관점·단계다.
 * 문장/문단/항목 범위 결과를 서로 재사용하지 않도록 scope·문장 해시도 더한다.
 */
export interface CacheKeyParts {
  documentId: string
  paragraphId: string
  paragraphHash: string
  rubricVersion: string
  promptVersion: string
  modelId: string
  perspective: ReviewPerspective
  stage: ReviewStage
  scope: ReviewScope
  /** 문장 검토일 때만. 같은 문단의 다른 문장을 섞지 않는다. */
  sentenceHash: string | null
  /** 해당 문서에 적용되는 승인 개인화의 내용/수정판. 없으면 빈 목록. */
  personalizationVersion?: string
  /**
   * 재심 요청에 함께 실은 기존 피드백과 사용자 판단의 지문. 재심이 아니면 null.
   * 같은 문단·관점·단계라도 **무엇을 다시 보라고 했는지가 다르면 다른 결과**이므로 키에 넣는다.
   */
  priorFeedbackHash?: string | null
  /**
   * 함께 보낸 그림의 지문. 그림을 보내지 않았으면 null ([Q-38]).
   *
   * 문단이 그대로여도 **그림이 달라지면 다른 결과**다. 그림은 문단이 아니라 문서 버전에 딸려
   * 오므로 문단 해시만으로는 무효화되지 않는다. 그래서 키에 따로 넣는다.
   */
  imagesHash?: string | null
}

function required(value: string, label: string): string {
  if (value === '') throw new Error(`캐시 키의 ${label}이 비어 있습니다.`)
  return value
}

/**
 * JSON 배열로 직렬화해 각 필드의 경계를 보존한다. 해시값을 다시 해시하지 않아도 SQLite의 UNIQUE 키로 안전하다.
 */
export function createCacheKey(parts: CacheKeyParts): string {
  return JSON.stringify([
    'review-cache.v5',
    required(parts.documentId, '문서 식별자'),
    required(parts.paragraphId, '문단 식별자'),
    required(parts.paragraphHash, '문단 해시'),
    required(parts.rubricVersion, '지침 버전'),
    required(parts.promptVersion, '프롬프트 버전'),
    required(parts.modelId, '모델 식별자'),
    parts.perspective,
    parts.stage,
    parts.scope,
    parts.sentenceHash,
    parts.personalizationVersion ?? '[]',
    parts.priorFeedbackHash ?? null,
    parts.imagesHash ?? null,
  ])
}
