/**
 * 단계 실행 상태 기계 테스트.
 * 실제 claude 세션과 git 은 부르지 않고 가짜를 주입한다.
 */
import { describe, expect, it } from 'vitest'

import { parseArgs, exitCodeFor } from '../tools/stages/cli.mts'
import { runStage, runStages, type Effects } from '../tools/stages/runner.mts'
import type { CommandResult, ReviewVerdict, SessionResult, Stage } from '../tools/stages/types.mts'

function stage(overrides: Partial<Stage> = {}): Stage {
  return {
    number: 6,
    title: '메모이제이션 · 캐시 · 우선순위 큐',
    status: 'pending',
    body: '**작업**\n- [ ] 캐시 키\n\n**완료 조건**\n- [ ] 캐시가 무효화된다',
    prerequisites: '',
    tasks: '- [ ] 캐시 키',
    completion: '- [ ] 캐시가 무효화된다',
    outOfScope: '',
    ...overrides,
  }
}

interface FakeConfig {
  gitRoot?: string
  clean?: boolean
  branch?: string
  changes?: { status: string; path: string }[]
  checkResults?: boolean[]
  verdicts?: ReviewVerdict[]
  sessionOk?: boolean
  packageJsonAfter?: string
}

function makeEffects(config: FakeConfig = {}) {
  const calls = {
    implement: [] as { attempt: number; problems: string[] }[],
    review: 0,
    commits: [] as string[],
    statusUpdates: [] as string[],
    checks: 0,
    log: [] as { event: string; stage: number | null }[],
    said: [] as string[],
  }

  const checkResults = config.checkResults ?? [true]
  const verdicts = config.verdicts ?? [{ verdict: 'pass', summary: '좋다', raw: '' }]

  const effects: Effects = {
    gitRoot: () => Promise.resolve(config.gitRoot ?? '/proj'),
    branch: () => Promise.resolve(config.branch ?? 'main'),
    workingTreeClean: () => Promise.resolve(config.clean ?? true),
    changedFiles: () =>
      Promise.resolve(config.changes ?? [{ status: 'M', path: 'src/core/cache/key.ts' }]),
    diff: () => Promise.resolve('diff --git a/x b/x'),
    readFileAtHead: () => Promise.resolve('{"dependencies":{}}'),
    readFile: () => Promise.resolve(config.packageJsonAfter ?? '{"dependencies":{}}'),
    commit: (message) => {
      calls.commits.push(message)
      return Promise.resolve('abc1234')
    },
    runCheck: () => {
      const ok = checkResults[Math.min(calls.checks, checkResults.length - 1)] ?? true
      calls.checks += 1
      return Promise.resolve({
        ok,
        code: ok ? 0 : 1,
        stdout: ok ? 'all good' : 'FAIL: 테스트 2개 실패',
        stderr: '',
      } satisfies CommandResult)
    },
    implement: (_stage, attempt, problems) => {
      calls.implement.push({ attempt, problems })
      return Promise.resolve({
        ok: config.sessionOk ?? true,
        text: '했다',
        sessionId: 's',
        costUsd: 0,
        numTurns: 1,
        permissionDenials: [],
        raw: '{}',
      } satisfies SessionResult)
    },
    review: () => {
      const verdict = verdicts[Math.min(calls.review, verdicts.length - 1)] as ReviewVerdict
      calls.review += 1
      return Promise.resolve(verdict)
    },
    updateStageStatus: (_stage, statusCell) => {
      calls.statusUpdates.push(statusCell)
      return Promise.resolve()
    },
    log: (event, stageNumber) => calls.log.push({ event, stage: stageNumber }),
    say: (message) => calls.said.push(message),
  }

  return { effects, calls }
}

const options = { projectRoot: '/proj', maxFixes: 2, gateAcknowledged: false, dryRun: false }

describe('한 단계 실행', () => {
  it('검사와 검토가 모두 통과하면 상태를 갱신하고 커밋한다', async () => {
    const { effects, calls } = makeEffects()
    const outcome = await runStage(stage(), effects, options)

    expect(outcome).toMatchObject({ kind: 'committed', stage: 6, commit: 'abc1234' })
    expect(calls.statusUpdates).toHaveLength(1)
    expect(calls.statusUpdates[0]).toContain('완료')
    expect(calls.commits[0]).toContain('6단계')
    expect(calls.implement).toHaveLength(1)
  })

  it('상태 갱신 후 다시 검사하고, 깨지면 커밋하지 않는다', async () => {
    // 1회차 check 통과 -> 검토 통과 -> 상태 갱신 -> 재검사에서 실패
    const { effects, calls } = makeEffects({ checkResults: [true, false] })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(outcome.kind === 'failed' && outcome.reason).toContain('상태 갱신 후 검사 실패')
    expect(calls.statusUpdates).toHaveLength(1) // 상태는 고쳤지만
    expect(calls.commits).toEqual([]) // 커밋하지 않는다
  })

  it('재검사도 통과해야 커밋한다', async () => {
    const { effects, calls } = makeEffects({ checkResults: [true, true] })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome.kind).toBe('committed')
    expect(calls.checks).toBe(2) // 본검사 + 상태 갱신 후 재검사
    expect(calls.commits).toHaveLength(1)
  })

  it('검토가 실패하면 커밋하지 않는다', async () => {
    const { effects, calls } = makeEffects({
      verdicts: [{ verdict: 'fail', summary: '부족', problems: ['테스트가 비었다'], raw: '' }],
    })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome.kind).toBe('failed')
    expect(calls.commits).toEqual([])
    expect(calls.statusUpdates).toEqual([])
  })

  it('검사가 통과해도 검토가 실패하면 커밋하지 않는다 (둘 다 필요)', async () => {
    const { effects, calls } = makeEffects({
      checkResults: [true],
      verdicts: [{ verdict: 'fail', summary: 'x', problems: [], raw: '' }],
    })
    await runStage(stage(), effects, options)
    expect(calls.checks).toBeGreaterThan(0)
    expect(calls.commits).toEqual([])
  })

  it('판정을 읽지 못하면 통과로 보지 않는다', async () => {
    const { effects, calls } = makeEffects({
      verdicts: [{ verdict: 'unparsed', summary: '못 읽음', raw: '' }],
    })
    expect((await runStage(stage(), effects, options)).kind).toBe('failed')
    expect(calls.commits).toEqual([])
  })

  it('check 가 실패하면 고치고 다시 시도한다', async () => {
    const { effects, calls } = makeEffects({ checkResults: [false, true] })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome.kind).toBe('committed')
    expect(calls.implement).toHaveLength(2)
    expect(calls.implement[1]?.attempt).toBe(1)
    expect(calls.implement[1]?.problems.join(' ')).toContain('npm run check')
  })

  it('검토 지적을 다음 수정 세션에 넘긴다', async () => {
    const { effects, calls } = makeEffects({
      verdicts: [
        { verdict: 'fail', summary: 'x', problems: ['캐시 키에 지침 버전이 빠졌다'], raw: '' },
        { verdict: 'pass', summary: '고쳐졌다', raw: '' },
      ],
    })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome.kind).toBe('committed')
    expect(calls.implement[1]?.problems).toEqual(['캐시 키에 지침 버전이 빠졌다'])
  })

  it('수정을 2회 하고도 안 되면 멈춘다', async () => {
    const { effects, calls } = makeEffects({
      checkResults: [false, false, false],
    })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome).toMatchObject({ kind: 'failed', attempts: 3 })
    expect(calls.implement).toHaveLength(3) // 최초 1 + 수정 2
    expect(calls.commits).toEqual([])
  })
})

describe('중단 조건', () => {
  it('Git 루트가 프로젝트가 아니면 세션을 부르지 않는다', async () => {
    const { effects, calls } = makeEffects({ gitRoot: '/Users/me' })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome.kind).toBe('guard-abort')
    expect(calls.implement).toEqual([])
    expect(calls.commits).toEqual([])
  })

  it('작업 트리가 더러우면 시작하지 않는다', async () => {
    const { effects, calls } = makeEffects({ clean: false })
    expect((await runStage(stage(), effects, options)).kind).toBe('guard-abort')
    expect(calls.implement).toEqual([])
  })

  it('보호 문서를 고치면 커밋하지 않고 멈춘다', async () => {
    const { effects, calls } = makeEffects({
      changes: [{ status: 'M', path: 'experiment-report-assistant-prd.md' }],
    })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome.kind).toBe('guard-abort')
    expect(calls.checks).toBe(0)
    expect(calls.commits).toEqual([])
  })

  it('패키지를 몰래 설치하면 멈춘다', async () => {
    const { effects, calls } = makeEffects({
      changes: [{ status: 'M', path: 'package.json' }],
      packageJsonAfter: '{"dependencies":{"lodash":"^4.0.0"}}',
    })
    const outcome = await runStage(stage(), effects, options)

    expect(outcome.kind).toBe('guard-abort')
    expect(calls.commits).toEqual([])
  })

  it('변경이 하나도 없으면 실패로 본다', async () => {
    const { effects, calls } = makeEffects({ changes: [] })
    expect((await runStage(stage(), effects, options)).kind).toBe('failed')
    expect(calls.commits).toEqual([])
  })

  it('구현 세션 자체가 실패하면 멈춘다', async () => {
    const { effects, calls } = makeEffects({ sessionOk: false })
    expect((await runStage(stage(), effects, options)).kind).toBe('failed')
    expect(calls.commits).toEqual([])
  })
})

describe('사람 확인이 필요한 단계', () => {
  const gated = stage({
    number: 4,
    title: '모델 어댑터와 빠른 검토',
    body: '**선행 조건**\n- OpenRouter 계정과 API 키',
    prerequisites: '- OpenRouter 계정과 API 키',
  })

  it('안내를 출력하고 세션 없이 멈춘다', async () => {
    const { effects, calls } = makeEffects()
    const outcome = await runStage(gated, effects, options)

    expect(outcome.kind).toBe('human-gate')
    expect(calls.implement).toEqual([])
    expect(calls.said.join('\n')).toContain('npm run stage -- 4 --gate-ok')
  })

  it('--gate-ok 를 주면 진행한다', async () => {
    const { effects, calls } = makeEffects()
    const outcome = await runStage(gated, effects, { ...options, gateAcknowledged: true })

    expect(outcome.kind).toBe('committed')
    expect(calls.implement).toHaveLength(1)
  })
})

describe('보류 단계', () => {
  const deferred = stage({ number: 7, title: '심층 검토', status: 'deferred' })

  it('명시적으로 지정해도 실행하지 않는다', async () => {
    const { effects, calls } = makeEffects()
    const outcome = await runStage(deferred, effects, options)

    expect(outcome).toMatchObject({ kind: 'skipped', reason: '보류' })
    expect(calls.implement).toEqual([])
    expect(calls.commits).toEqual([])
    expect(calls.said.join('\n')).toContain('보류된 단계')
  })

  it('이어서 실행할 때 멈추지 않고 다음으로 넘어간다', async () => {
    const { effects, calls } = makeEffects()
    const outcomes = await runStages(
      [deferred, stage({ number: 8, title: '개인화' })],
      effects,
      options,
    )

    expect(outcomes.map((o) => o.kind)).toEqual(['skipped', 'committed'])
    expect(calls.commits).toHaveLength(1)
  })
})

describe('여러 단계 이어서 실행', () => {
  it('통과하는 동안 계속 가고, 막히면 거기서 멈춘다', async () => {
    const { effects, calls } = makeEffects({
      verdicts: [
        { verdict: 'pass', summary: 'ok', raw: '' },
        { verdict: 'fail', summary: '부족', problems: ['x'], raw: '' },
        { verdict: 'fail', summary: '부족', problems: ['x'], raw: '' },
        { verdict: 'fail', summary: '부족', problems: ['x'], raw: '' },
      ],
    })
    const outcomes = await runStages(
      [stage({ number: 6 }), stage({ number: 8, title: '개인화' })],
      effects,
      options,
    )

    expect(outcomes.map((o) => o.kind)).toEqual(['committed', 'failed'])
    expect(calls.commits).toHaveLength(1)
  })

  it('이미 완료된 단계는 건너뛰고 다음으로 간다', async () => {
    const { effects, calls } = makeEffects()
    const outcomes = await runStages(
      [stage({ number: 0, status: 'done' }), stage({ number: 6 })],
      effects,
      options,
    )

    expect(outcomes.map((o) => o.kind)).toEqual(['skipped', 'committed'])
    expect(calls.implement).toHaveLength(1)
  })

  it('사람 확인 승인은 그 단계에만 적용된다', async () => {
    const { effects, calls } = makeEffects()
    const gatedNext = stage({
      number: 7,
      title: '심층 검토',
      body: '**선행 조건**\n- V-2 확인',
      prerequisites: '- V-2 확인',
    })
    const outcomes = await runStages([stage({ number: 6 }), gatedNext], effects, {
      ...options,
      gateAcknowledged: true,
    })

    expect(outcomes.map((o) => o.kind)).toEqual(['committed', 'human-gate'])
    expect(calls.commits).toHaveLength(1)
  })
})

describe('이어서 하기 (--review-only)', () => {
  it('구현을 건너뛰고 검토부터 해서 커밋한다', async () => {
    const { effects, calls } = makeEffects()
    const outcome = await runStage(stage(), effects, { ...options, reviewOnly: true })

    expect(outcome.kind).toBe('committed')
    expect(calls.implement).toEqual([]) // 구현 세션을 부르지 않는다
    expect(calls.checks).toBe(2) // 본검사 + 상태 갱신 후 재검사
    expect(calls.review).toBe(1)
    expect(calls.commits).toHaveLength(1)
  })

  it('작업 트리가 더러워도 진행한다 (변경이 남아 있는 상태가 전제다)', async () => {
    const { effects, calls } = makeEffects({ clean: false })
    const outcome = await runStage(stage(), effects, { ...options, reviewOnly: true })

    expect(outcome.kind).toBe('committed')
    expect(calls.commits).toHaveLength(1)
  })

  it('사람 확인 게이트를 다시 묻지 않는다 (구현이 이미 끝난 상태이므로)', async () => {
    const gated = stage({
      number: 2,
      title: '저장 감지',
      body: '**작업**\n- [ ] V-1 관찰\n\n**완료 조건**\n- [ ] 감지된다',
      tasks: '- [ ] V-1 관찰',
    })
    const { effects, calls } = makeEffects({ clean: false })
    const outcome = await runStage(gated, effects, { ...options, reviewOnly: true })

    expect(outcome.kind).toBe('committed')
    expect(calls.commits).toHaveLength(1)
  })

  it('그래도 Git 루트가 다르면 막는다', async () => {
    const { effects, calls } = makeEffects({ gitRoot: '/elsewhere', clean: false })
    const outcome = await runStage(stage(), effects, { ...options, reviewOnly: true })

    expect(outcome.kind).toBe('guard-abort')
    expect(calls.commits).toEqual([])
  })

  it('중단 조건은 그대로 적용된다', async () => {
    const { effects, calls } = makeEffects({
      clean: false,
      changes: [{ status: 'M', path: 'experiment-report-assistant-prd.md' }],
    })
    const outcome = await runStage(stage(), effects, { ...options, reviewOnly: true })

    expect(outcome.kind).toBe('guard-abort')
    expect(calls.commits).toEqual([])
  })

  it('검토가 실패하면 그때부터는 수정 세션을 부른다', async () => {
    const { effects, calls } = makeEffects({
      clean: false,
      verdicts: [
        { verdict: 'fail', summary: '부족', problems: ['테스트가 얕다'], raw: '' },
        { verdict: 'pass', summary: '고쳐졌다', raw: '' },
      ],
    })
    const outcome = await runStage(stage(), effects, { ...options, reviewOnly: true })

    expect(outcome.kind).toBe('committed')
    expect(calls.implement).toHaveLength(1) // 첫 회차만 건너뛰고, 수정은 세션을 쓴다
    expect(calls.implement[0]?.attempt).toBe(1)
    expect(calls.implement[0]?.problems).toEqual(['테스트가 얕다'])
  })
})

describe('모의 실행', () => {
  it('세션을 부르지 않고 계획만 보여 준다', async () => {
    const { effects, calls } = makeEffects()
    const outcome = await runStage(stage(), effects, { ...options, dryRun: true })

    expect(outcome.kind).toBe('skipped')
    expect(calls.implement).toEqual([])
    expect(calls.commits).toEqual([])
  })
})

describe('명령줄 인자', () => {
  it('npm run stage -- 3 을 읽는다', () => {
    expect(parseArgs(['--stage', '3'])).toMatchObject({ stage: 3, all: false })
  })

  it('번호만 줘도 읽는다', () => {
    expect(parseArgs(['3']).stage).toBe(3)
  })

  it('기본값은 다음 미완료 단계부터 전부다', () => {
    expect(parseArgs([])).toMatchObject({ stage: null, all: true, maxFixes: 2, dryRun: false })
  })

  it('--review-only 를 읽는다', () => {
    expect(parseArgs(['--stage', '2', '--review-only']).reviewOnly).toBe(true)
    expect(parseArgs(['2']).reviewOnly).toBe(false)
  })

  it('--gate-ok, --dry-run, --max-fixes 를 읽는다', () => {
    expect(parseArgs(['--stage', '2', '--gate-ok', '--dry-run', '--max-fixes', '1'])).toMatchObject({
      stage: 2,
      gateAcknowledged: true,
      dryRun: true,
      maxFixes: 1,
    })
  })

  it('모르는 인자는 거절한다', () => {
    expect(() => parseArgs(['--wat'])).toThrow('모르는 인자')
    expect(() => parseArgs(['--stage', 'abc'])).toThrow('단계 번호')
  })

  it('결과에 따라 종료 코드를 정한다', () => {
    expect(exitCodeFor([{ kind: 'committed', stage: 1, commit: 'a' }])).toBe(0)
    expect(exitCodeFor([{ kind: 'human-gate', stage: 2, gates: [] }])).toBe(2)
    expect(exitCodeFor([{ kind: 'guard-abort', stage: 2, violations: [] }])).toBe(3)
    expect(exitCodeFor([{ kind: 'failed', stage: 2, reason: 'x', attempts: 3 }])).toBe(1)
  })
})
