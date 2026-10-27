import type { ReviewPerspective } from './review.js'

export const REACTIONS = ['agree', 'partial', 'rebuttal', 'unclear', 'completed'] as const
export type ReactionKind = (typeof REACTIONS)[number]
export const REACTION_LABELS: Record<ReactionKind, string> = {
  agree: '동의', partial: '부분 동의', rebuttal: '반박', unclear: '이해되지 않음', completed: '수정 완료',
}
export const PERSONAL_TEXT_MAX = 2000
export type GuidelineScope = 'document' | 'subject' | 'global'
export interface UserReaction {
  feedbackId: string; documentId: string; kind: ReactionKind; reason: string; updatedAt: string
}
export interface SelfAssessment {
  id: string; documentId: string; versionId: string; versionOrdinal: number
  phase: 'before' | 'after'; text: string; updatedAt: string
}
export interface PersonalGuideline {
  id: string; text: string; scope: GuidelineScope; documentId: string | null; subject: string | null
  approvedAt: string; revision: number
}
export interface WeaknessObservation {
  id: string; documentId: string; documentName: string; versionId: string; versionOrdinal: number
  paragraphId: string; perspective: ReviewPerspective; rubricItemIds: string[]
  problem: string; aiJudgment: string; reaction: UserReaction | null; note: string
  /** 실제 모델이 이 버전의 대상을 검토했는가. 캐시 복제는 반복 관찰에 더하지 않는다. */
  fresh: boolean
  before: string; after: string | null; afterVersionOrdinal: number
  changed: boolean; improvement: 'confirmed-change' | 'changed' | 'unconfirmed' | 'unresolved'
}
/** 관찰이 나온 문서 버전 하나. 취약점 후보에 붙는 근거다 (PRD 4.4, `CLAUDE.md` §1). */
export interface ObservedVersion { documentId: string; documentName: string; versionOrdinal: number }
/**
 * 같은 분류(관점 + 적용된 지침 항목)가 관찰된 문서 버전 근거.
 * 프로그램이 저장된 관찰에서 결정론적으로 센다. 모델은 이 값에 관여하지 않는다.
 * 근거 없이 능력을 단정하지 않기 위해 **취약점 후보에는 항상 이 값이 함께 붙는다.**
 */
export interface RepeatedObservation { count: number; versions: ObservedVersion[] }
/** 근거가 아직 없는 상태. 여러 카드가 함께 쓰므로 얼려 둔다. */
export const NO_REPEATED_OBSERVATION: RepeatedObservation = Object.freeze({ count: 0, versions: [] })
export interface GrowthGroup {
  key: string; perspective: ReviewPerspective; repeatCount: number; evidenceIds: string[]
  /** 반복 관찰의 근거가 된 문서 버전. `repeatCount` 와 길이가 같다 */
  versions: ObservedVersion[]
  changedCount: number; improvedCount: number; rebuttalCount: number
}
/** 외부에는 식별자 별칭과 프로그램 집계만 전달한다. 본문·경로·반박 원문은 보내지 않는다. */
export interface GrowthPayload {
  groups: { evidence: string[]; perspective: ReviewPerspective; repeatCount: number
    changedCount: number; improvedCount: number; rebuttalCount: number }[]
}
export interface GrowthSentence { text: string; evidenceIds: string[] }
export interface GrowthSummary {
  id: string; createdAt: string; modelId: string; promptVersion: string
  fingerprint: string; sentences: GrowthSentence[]
}
export interface GrowthView {
  observations: WeaknessObservation[]; groups: GrowthGroup[]; assessments: SelfAssessment[]
  guidelines: PersonalGuideline[]; summary: GrowthSummary | null
  summaryAvailable: boolean; unavailableMessage: string
  /** 심층 분석을 지금 요청할 수 있는가 (PRD 4.6). Claude 모드가 없으면 false */
  deepSummaryAvailable: boolean; deepUnavailableMessage: string
}
export type PersonalResult<T> = { status: 'ok'; value: T } | { status: 'failed'; message: string } | { status: 'canceled' }
export type PersonalMutation =
  | { kind: 'reaction'; documentId: string; feedbackId: string; reaction: ReactionKind; reason: string }
  | { kind: 'assessment'; id?: string; documentId: string; phase: 'before' | 'after'; text: string }
  | { kind: 'guideline'; id?: string; documentId: string; scope: GuidelineScope; text: string }
  | { kind: 'observation'; id: string; note: string }
export type PersonalDelete = { kind: 'reaction' | 'assessment' | 'guideline' | 'observation' | 'summary'; id: string }
