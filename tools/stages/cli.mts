/**
 * 단계 실행 자동화 진입점.
 *
 *   npm run stages                 다음 미완료 단계부터 이어서 실행
 *   npm run stage -- 3             3단계만 실행
 *   npm run stages -- --dry-run    무엇을 할지만 보여 주고 세션은 부르지 않는다
 *   npm run stage -- 2 --gate-ok   사람이 해야 할 일을 끝냈다고 알리고 진행
 *   npm run stage -- 2 --review-only 구현을 건너뛰고 작업 트리의 변경을 검토부터 (이어서 하기)
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { createEffects } from './effects.mts'
import { nextPendingStage, parseStages } from './parse-stages.mts'
import { createRunLog, say } from './runlog.mts'
import { runStage, runStages } from './runner.mts'
import type { Stage, StageOutcome } from './types.mts'

export interface CliOptions {
  stage: number | null
  gateAcknowledged: boolean
  dryRun: boolean
  maxFixes: number
  all: boolean
  reviewOnly: boolean
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    stage: null,
    gateAcknowledged: false,
    dryRun: false,
    maxFixes: 2,
    all: true,
    reviewOnly: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    if (arg === '--gate-ok') options.gateAcknowledged = true
    else if (arg === '--review-only') options.reviewOnly = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--max-fixes') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max-fixes 에는 0 이상의 정수를 주세요')
      }
      options.maxFixes = value
      i += 1
    } else if (arg === '--stage') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--stage 에는 단계 번호를 주세요 (예: npm run stage -- 3)')
      }
      options.stage = value
      options.all = false
      i += 1
    } else if (/^\d+$/.test(arg) && options.stage === null) {
      options.stage = Number(arg)
      options.all = false
    } else {
      throw new Error(`모르는 인자입니다: ${arg}`)
    }
  }

  return options
}

/** 결과에 따른 종료 코드. 0 통과, 2 사람 확인 필요, 3 중단 조건, 1 실패 */
export function exitCodeFor(outcomes: readonly StageOutcome[]): number {
  const last = outcomes[outcomes.length - 1]
  if (last === undefined) return 0
  switch (last.kind) {
    case 'committed':
    case 'skipped':
      return 0
    case 'human-gate':
      return 2
    case 'guard-abort':
      return 3
    case 'failed':
      return 1
  }
}

function findProjectRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 10; i += 1) {
    try {
      readFileSync(join(dir, 'STAGE_TASKS.md'), 'utf8')
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error('STAGE_TASKS.md 를 찾지 못했습니다. 프로젝트 폴더에서 실행해 주세요.')
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv)
  const projectRoot = findProjectRoot(resolve(process.cwd()))
  const markdown = readFileSync(join(projectRoot, 'STAGE_TASKS.md'), 'utf8')
  const stages = parseStages(markdown)

  let targets: Stage[]
  if (options.stage !== null) {
    const found = stages.find((s) => s.number === options.stage)
    if (found === undefined) {
      say(`${options.stage}단계를 STAGE_TASKS.md 에서 찾지 못했습니다.`)
      return 1
    }
    targets = [found]
  } else {
    const next = nextPendingStage(stages)
    if (next === null) {
      say('모든 단계가 완료 상태입니다.')
      return 0
    }
    targets = stages.filter((s) => s.number >= next.number).sort((a, b) => a.number - b.number)
  }

  const runLog = createRunLog(projectRoot)
  say(`실행 기록: ${runLog.path}`)

  const effects = createEffects({
    projectRoot,
    runLog,
    say,
    sessionTimeoutMs: 60 * 60 * 1000,
  })

  if (options.reviewOnly && options.stage === null) {
    say('--review-only 는 단계를 지정해야 합니다 (예: npm run stage -- 2 --review-only)')
    return 1
  }

  const runOptions = {
    projectRoot,
    maxFixes: options.maxFixes,
    gateAcknowledged: options.gateAcknowledged,
    dryRun: options.dryRun,
    reviewOnly: options.reviewOnly,
  }

  const outcomes =
    targets.length === 1
      ? [await runStage(targets[0] as Stage, effects, runOptions)]
      : await runStages(targets, effects, runOptions)

  say('')
  say('=== 요약 ===')
  for (const outcome of outcomes) {
    say(`  ${outcome.stage}단계: ${describe(outcome)}`)
  }
  say(`실행 기록: ${runLog.path}`)

  return exitCodeFor(outcomes)
}

function describe(outcome: StageOutcome): string {
  switch (outcome.kind) {
    case 'committed':
      return `통과 · 커밋 ${outcome.commit}`
    case 'human-gate':
      return `사람 확인 필요 (${outcome.gates.length}건)`
    case 'guard-abort':
      return `중단 조건 (${outcome.violations.map((v) => v.rule).join(', ')})`
    case 'failed':
      return `실패 · ${outcome.reason.slice(0, 120)}`
    case 'skipped':
      return `건너뜀 · ${outcome.reason}`
  }
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].endsWith('cli.mts')
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      say(`오류: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
