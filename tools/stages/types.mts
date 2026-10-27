/** 단계 실행 자동화가 주고받는 타입. */

/**
 * 단계 상태.
 * - done     끝났다
 * - pending  다음에 할 수 있다
 * - deferred 이번 개발 범위 밖이다. 자동 실행이 건너뛴다. 번호를 지우지 않는 이유는
 *            나중에 그 단계를 살릴 때 정의를 그대로 쓰기 위해서다
 */
export type StageStatus = 'done' | 'pending' | 'deferred'

export interface Stage {
  number: number
  title: string
  status: StageStatus
  /** STAGE_TASKS.md 의 해당 단계 본문 전체 */
  body: string
  /** "선행 조건" 절 */
  prerequisites: string
  /** "작업" 절 */
  tasks: string
  /** "완료 조건" 절 */
  completion: string
  /** "이 단계에서 하지 않는 것" 절 */
  outOfScope: string
}

export interface CommandResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

export interface SessionResult {
  ok: boolean
  /** claude -p --output-format json 의 result 필드 */
  text: string
  sessionId: string | null
  costUsd: number | null
  numTurns: number | null
  /** 세션이 시도했다가 거부된 도구 호출. 비어 있지 않으면 기록해 둔다. */
  permissionDenials: unknown[]
  raw: string
}

export type ReviewVerdict =
  | { verdict: 'pass'; summary: string; raw: string }
  | { verdict: 'fail'; summary: string; problems: string[]; raw: string }
  | { verdict: 'unparsed'; summary: string; raw: string }

export interface FileChange {
  /** git status --porcelain 의 상태 코드 (예: 'M', 'A', 'D', '??') */
  status: string
  path: string
}

export interface GuardViolation {
  rule: string
  detail: string
}

export interface HumanGate {
  reason: string
  /** 사람이 해야 할 일 */
  action: string
}

export type StageOutcome =
  | { kind: 'committed'; stage: number; commit: string }
  | { kind: 'human-gate'; stage: number; gates: HumanGate[] }
  | { kind: 'guard-abort'; stage: number; violations: GuardViolation[] }
  | { kind: 'failed'; stage: number; reason: string; attempts: number }
  | { kind: 'skipped'; stage: number; reason: string }
