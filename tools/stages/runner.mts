/**
 * 단계 실행 오케스트레이션.
 *
 * 흐름: 사전 점검 -> 사람 확인 필요 여부 -> 구현 -> 변경 검사 -> npm run check
 *       -> 별도 세션 검토 -> 둘 다 통과해야 상태 갱신 + 커밋
 * 실패하면 최대 maxFixes 회 고치고, 그래도 안 되면 멈춘다.
 *
 * 외부 작용은 전부 Effects 로 주입받는다. 그래서 실제 세션이나 git 없이 테스트할 수 있다.
 */
import { detectHumanGates, formatGates } from './gates.mts'
import { checkDiff, checkPreflight } from './guards.mts'
import type {
  CommandResult,
  FileChange,
  GuardViolation,
  ReviewVerdict,
  SessionResult,
  Stage,
  StageOutcome,
} from './types.mts'

export interface Effects {
  gitRoot(): Promise<string>
  branch(): Promise<string>
  workingTreeClean(): Promise<boolean>
  changedFiles(): Promise<FileChange[]>
  diff(): Promise<string>
  readFileAtHead(path: string): Promise<string | null>
  readFile(path: string): Promise<string | null>
  commit(message: string): Promise<string>
  runCheck(): Promise<CommandResult>
  implement(stage: Stage, attempt: number, problems: string[]): Promise<SessionResult>
  review(stage: Stage, diff: string, checkOutput: string): Promise<ReviewVerdict>
  updateStageStatus(stage: Stage, statusCell: string): Promise<void>
  log(event: string, stage: number | null, detail?: unknown): void
  say(message: string): void
}

export interface RunOptions {
  projectRoot: string
  maxFixes: number
  /**
   * 구현을 건너뛰고 검토부터 한다.
   * 구현 세션이 끝난 뒤 검토나 커밋 단계에서 멈췄을 때 이어서 하기 위한 것이다.
   * 작업 트리에 변경이 남아 있는 상태를 전제하므로 깨끗한 트리를 요구하지 않는다.
   */
  reviewOnly?: boolean
  /** 사람이 해야 할 일을 끝냈다고 알린 경우 true */
  gateAcknowledged: boolean
  /** 세션을 부르지 않고 계획만 보여 준다 */
  dryRun: boolean
}

function formatViolations(violations: readonly GuardViolation[]): string {
  return violations.map((v) => `  - [${v.rule}] ${v.detail}`).join('\n')
}

export async function runStage(
  stage: Stage,
  effects: Effects,
  options: RunOptions,
): Promise<StageOutcome> {
  effects.say('')
  effects.say(`=== ${stage.number}단계 — ${stage.title} ===`)
  effects.log('stage-start', stage.number, { title: stage.title })

  if (stage.status === 'done') {
    effects.say('이미 완료된 단계입니다. 건너뜁니다.')
    return { kind: 'skipped', stage: stage.number, reason: '이미 완료' }
  }

  if (stage.status === 'deferred') {
    effects.say('이번 개발 범위 밖으로 보류된 단계입니다. 실행하지 않습니다.')
    effects.say('살리려면 STAGE_TASKS.md 의 상태 표에서 이 단계를 대기로 바꾸세요.')
    effects.log('deferred-skip', stage.number)
    return { kind: 'skipped', stage: stage.number, reason: '보류' }
  }

  // 1. 사전 점검
  const reviewOnly = options.reviewOnly === true
  const preflight = checkPreflight({
    gitRoot: await effects.gitRoot(),
    projectRoot: options.projectRoot,
    workingTreeClean: await effects.workingTreeClean(),
    branch: await effects.branch(),
    requireCleanTree: !reviewOnly,
  })
  if (preflight.length > 0) {
    effects.say('사전 점검에서 걸렸습니다. 진행하지 않습니다.')
    effects.say(formatViolations(preflight))
    effects.log('preflight-abort', stage.number, preflight)
    return { kind: 'guard-abort', stage: stage.number, violations: preflight }
  }

  // 2. 사람이 해야 하는 일
  // 이어서 하기는 구현이 이미 끝난 상태다. 거기 도달하려면 게이트를 이미 지났으므로 다시 묻지 않는다.
  const gateAcknowledged = options.gateAcknowledged || reviewOnly
  const gates = detectHumanGates(stage)
  if (gates.length > 0 && !gateAcknowledged) {
    effects.say(formatGates(stage, gates, reviewOnly ? ['--review-only'] : []))
    effects.log('human-gate', stage.number, gates)
    return { kind: 'human-gate', stage: stage.number, gates }
  }
  if (gates.length > 0) {
    effects.say(`사람 확인 ${gates.length}건을 끝냈다고 하셨으므로 이어서 진행합니다.`)
    effects.log('human-gate-acknowledged', stage.number, gates)
  }

  if (options.dryRun) {
    effects.say('[모의 실행] 여기서 구현 세션을 시작했을 것입니다. 실제로는 부르지 않습니다.')
    effects.log('dry-run', stage.number)
    return { kind: 'skipped', stage: stage.number, reason: '모의 실행' }
  }

  const packageJsonBefore = (await effects.readFileAtHead('package.json')) ?? undefined
  let problems: string[] = []

  // 3. 구현 -> 검사 -> 검토, 실패하면 maxFixes 회까지 수정
  for (let attempt = 0; attempt <= options.maxFixes; attempt += 1) {
    const skipImplement = reviewOnly && attempt === 0

    if (skipImplement) {
      effects.say('[이어서 하기] 구현을 건너뛰고 작업 트리에 있는 변경을 검토합니다.')
      effects.log('resume-review-only', stage.number)
    } else {
      const label = attempt === 0 ? '구현' : `수정 ${attempt}회차`
      effects.say(`[${label}] 세션을 시작합니다...`)

      const session = await effects.implement(stage, attempt, problems)
      effects.log('implement-session', stage.number, {
        attempt,
        ok: session.ok,
        sessionId: session.sessionId,
        costUsd: session.costUsd,
        numTurns: session.numTurns,
        permissionDenials: session.permissionDenials,
      })

      if (Array.isArray(session.permissionDenials) && session.permissionDenials.length > 0) {
        effects.say(
          `  거부된 도구 호출 ${session.permissionDenials.length}건이 있었습니다 (기록에 남김).`,
        )
      }
      if (!session.ok) {
        effects.say('구현 세션이 정상적으로 끝나지 않았습니다.')
        effects.log('implement-failed', stage.number, { attempt, text: session.text.slice(0, 2000) })
        return {
          kind: 'failed',
          stage: stage.number,
          reason: `구현 세션 실패: ${session.text.slice(0, 300)}`,
          attempts: attempt + 1,
        }
      }
    }

    // 4. 변경 검사 (중단 조건)
    const changes = await effects.changedFiles()
    if (changes.length === 0) {
      effects.say('변경된 파일이 없습니다. 진행하지 않습니다.')
      effects.log('no-changes', stage.number, { attempt })
      return { kind: 'failed', stage: stage.number, reason: '변경 없음', attempts: attempt + 1 }
    }

    // 실제 키 리터럴이 들어갔는지 보려면 내용이 필요하다. 텍스트 소스만 읽는다.
    const fileContents = new Map<string, string>()
    for (const change of changes) {
      if (!/\.(ts|mts|tsx|js|mjs|cjs|json|sql|html|css|md|ya?ml|sh|env)$/i.test(change.path)) continue
      if (change.status.startsWith('D')) continue
      const content = await effects.readFile(change.path)
      if (content !== null) fileContents.set(change.path, content)
    }

    const violations = checkDiff({
      changes,
      fileContents,
      ...(packageJsonBefore === undefined ? {} : { packageJsonBefore }),
      ...((await effects.readFile('package.json')) === null
        ? {}
        : { packageJsonAfter: (await effects.readFile('package.json')) as string }),
    })
    if (violations.length > 0) {
      effects.say('변경 내용이 중단 조건에 걸렸습니다. 커밋하지 않고 멈춥니다.')
      effects.say(formatViolations(violations))
      effects.say('변경은 작업 트리에 그대로 있습니다. 직접 확인한 뒤 정리해 주세요.')
      effects.log('guard-abort', stage.number, violations)
      return { kind: 'guard-abort', stage: stage.number, violations }
    }

    // 5. npm run check
    effects.say('  npm run check 실행 중...')
    const check = await effects.runCheck()
    effects.log('check', stage.number, { attempt, ok: check.ok, code: check.code })

    if (!check.ok) {
      effects.say('  check 실패.')
      problems = [
        'npm run check 가 실패했습니다. 아래 출력을 보고 고치세요.',
        check.stdout.slice(-3000),
        check.stderr.slice(-2000),
      ]
      if (attempt === options.maxFixes) break
      continue
    }
    effects.say('  check 통과.')

    // 6. 검토 (별도 세션)
    effects.say('  검토 세션을 시작합니다...')
    const diff = await effects.diff()
    const verdict = await effects.review(stage, diff, check.stdout)
    effects.log('review', stage.number, {
      attempt,
      verdict: verdict.verdict,
      summary: verdict.summary,
    })

    if (verdict.verdict === 'pass') {
      effects.say(`  검토 통과: ${verdict.summary}`)

      const note = `**완료** (자동 실행 ${new Date().toISOString().slice(0, 10)})`
      await effects.updateStageStatus(stage, note)

      // 상태를 고친 뒤 한 번 더 검사한다. STAGE_TASKS.md 를 읽는 테스트가 있어서
      // 상태 갱신 자체가 검사를 깨뜨릴 수 있다. 그대로 커밋하면 저장소가 빨간 채로 남는다.
      effects.say('  상태 갱신 후 다시 검사합니다...')
      const recheck = await effects.runCheck()
      effects.log('recheck-after-status', stage.number, { ok: recheck.ok, code: recheck.code })

      if (!recheck.ok) {
        effects.say('  상태를 갱신하니 검사가 깨졌습니다. 커밋하지 않습니다.')
        effects.say('  STAGE_TASKS.md 의 상태 표를 읽는 테스트를 확인해 주세요.')
        effects.log('recheck-failed', stage.number, {
          stdout: recheck.stdout.slice(-2000),
        })
        return {
          kind: 'failed',
          stage: stage.number,
          reason: '상태 갱신 후 검사 실패 (커밋하지 않음)',
          attempts: attempt + 1,
        }
      }

      const commit = await effects.commit(commitMessage(stage, verdict.summary))
      effects.say(`  커밋했습니다: ${commit}`)
      effects.log('committed', stage.number, { commit })
      return { kind: 'committed', stage: stage.number, commit }
    }

    if (verdict.verdict === 'unparsed') {
      effects.say('  검토 응답에서 판정을 읽지 못했습니다. 통과로 보지 않습니다.')
      problems = ['검토 판정을 읽지 못했습니다. 요구사항을 다시 확인하고 근거를 분명히 남기세요.']
    } else {
      effects.say(`  검토 실패: ${verdict.summary}`)
      verdict.problems.forEach((p) => effects.say(`    - ${p}`))
      problems = verdict.problems.length > 0 ? verdict.problems : [verdict.summary]
    }

    if (attempt === options.maxFixes) break
  }

  effects.say(`수정을 ${options.maxFixes}회 시도했지만 통과하지 못했습니다. 여기서 멈춥니다.`)
  effects.say('변경은 작업 트리에 그대로 있습니다. 직접 확인해 주세요.')
  effects.log('exhausted', stage.number, { problems })
  return {
    kind: 'failed',
    stage: stage.number,
    reason: problems.join(' / ').slice(0, 500),
    attempts: options.maxFixes + 1,
  }
}

export function commitMessage(stage: Stage, summary: string): string {
  return [
    `${stage.number}단계: ${stage.title}`,
    '',
    'STAGE_TASKS.md 의 단계 정의에 따라 구현했다.',
    'npm run check 를 통과했고, 별도 검토 세션이 요구사항 충족을 확인했다.',
    '',
    `검토 요약: ${summary}`,
    '',
    'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
  ].join('\n')
}

/** 여러 단계를 이어서 실행한다. 하나라도 통과하지 못하면 거기서 멈춘다. */
export async function runStages(
  stages: readonly Stage[],
  effects: Effects,
  options: RunOptions,
): Promise<StageOutcome[]> {
  const outcomes: StageOutcome[] = []

  for (const stage of stages) {
    const outcome = await runStage(stage, effects, options)
    outcomes.push(outcome)
    if (outcome.kind !== 'committed') {
      // 이미 끝났거나 보류된 단계는 멈출 이유가 아니다. 다음으로 넘어간다.
      if (outcome.kind === 'skipped' && (outcome.reason === '이미 완료' || outcome.reason === '보류')) {
        continue
      }
      break
    }
    // 사람 확인 승인은 그 단계에만 적용한다.
    options = { ...options, gateAcknowledged: false }
  }

  return outcomes
}
