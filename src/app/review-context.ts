/**
 * 검토 맥락 ([Q-48]) — 검토·다듬기가 참고하는 "문서 종류".
 *
 * 검토·다듬기는 평가 지침을 쓰지 않는다. 대신 AI 가 목차를 나누며 함께 짐작한 문서 종류
 * (예: "실험 보고서 — 기체의 몰질량 측정")를 참고한다. 사용자가 고칠 수 있고, 고친 값은 AI 가
 * 다시 짐작해도 덮지 않는다 (사용자 판단 보존, `CLAUDE.md` §1).
 */
import type { DocumentProfile, ReviewContextRepository } from '../adapters/repo/review-context.js'

/** 문서 종류의 최대 길이. 입력칸과 메인 프로세스 검증이 같은 값을 쓴다 */
export const DOCUMENT_KIND_MAX_LENGTH = 80

export interface ReviewContextService {
  /** 검토 기록을 잇는 보고서별 식별자. 없으면 만든다 */
  versionOf(documentId: string): string
  /** 문서 종류. 모르면 빈 문자열 */
  kindOf(documentId: string): string
  profile(documentId: string): DocumentProfile | null
  /** 사용자가 고친다. 빈 값이면 AI 가 짐작한 것으로 돌아갈 수 있게 지운 셈으로 둔다 */
  setKind(documentId: string, kind: string): { ok: true } | { ok: false; message: string }
  /** AI 가 짐작한 종류. 사용자가 고친 값이 있으면 덮지 않는다 */
  saveGuess(documentId: string, kind: string, modelId: string): void
}

export function createReviewContextService(deps: { repo: ReviewContextRepository; now: () => string }):
  ReviewContextService {
  const { repo, now } = deps
  return {
    versionOf: (documentId) => repo.ensureContext(documentId, now()),
    kindOf: (documentId) => repo.getProfile(documentId)?.kind ?? '',
    profile: (documentId) => repo.getProfile(documentId),
    setKind(documentId, kind) {
      const trimmed = kind.replace(/\s+/g, ' ').trim()
      if (trimmed === '') return { ok: false, message: '문서 종류를 적어 주세요.' }
      if (trimmed.length > DOCUMENT_KIND_MAX_LENGTH) {
        return { ok: false, message: `문서 종류는 ${DOCUMENT_KIND_MAX_LENGTH}자까지 적을 수 있습니다.` }
      }
      repo.saveProfile(documentId, { kind: trimmed, source: 'user', modelId: null, updatedAt: now() })
      return { ok: true }
    },
    saveGuess(documentId, kind, modelId) {
      const trimmed = kind.replace(/\s+/g, ' ').trim().slice(0, DOCUMENT_KIND_MAX_LENGTH)
      if (trimmed === '' || repo.getProfile(documentId)?.source === 'user') return
      repo.saveProfile(documentId, { kind: trimmed, source: 'ai', modelId, updatedAt: now() })
    },
  }
}
