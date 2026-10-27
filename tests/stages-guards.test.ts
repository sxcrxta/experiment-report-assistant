import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildArgs, parseVerdict, parseSessionOutput } from '../tools/stages/claude-session.mts'
import { parsePorcelain } from '../tools/stages/effects.mts'
import { detectHumanGates, formatGates } from '../tools/stages/gates.mts'
import { checkDiff, checkPreflight } from '../tools/stages/guards.mts'
import { parseStages } from '../tools/stages/parse-stages.mts'

const REAL = readFileSync(join(import.meta.dirname, '..', 'STAGE_TASKS.md'), 'utf8')
const stages = parseStages(REAL)
const stageOf = (n: number) => stages.find((s) => s.number === n) as (typeof stages)[number]

describe('사전 점검', () => {
  const base = {
    gitRoot: '/proj',
    projectRoot: '/proj',
    workingTreeClean: true,
    branch: 'main',
  }

  it('정상이면 통과한다', () => {
    expect(checkPreflight(base)).toEqual([])
  })

  it('Git 루트가 프로젝트가 아니면 막는다', () => {
    const violations = checkPreflight({ ...base, gitRoot: '/Users/me' })
    expect(violations.map((v) => v.rule)).toContain('Git 루트 불일치')
  })

  it('작업 트리가 더러우면 막는다', () => {
    expect(checkPreflight({ ...base, workingTreeClean: false }).map((v) => v.rule)).toContain(
      '작업 트리 더러움',
    )
  })

  it('분리된 HEAD 에서는 막는다', () => {
    expect(checkPreflight({ ...base, branch: '' }).map((v) => v.rule)).toContain('분리된 HEAD')
  })
})

describe('변경 검사 (중단 조건)', () => {
  it('평범한 소스 변경은 통과한다', () => {
    expect(
      checkDiff({
        changes: [
          { status: 'M', path: 'src/core/diff/myers.ts' },
          { status: '??', path: 'tests/myers.test.ts' },
        ],
      }),
    ).toEqual([])
  })

  it('PRD 등 보호 문서를 고치면 막는다', () => {
    const rules = checkDiff({
      changes: [{ status: 'M', path: 'experiment-report-assistant-prd.md' }],
    }).map((v) => v.rule)
    expect(rules).toContain('보호 문서 변경')
  })

  it('STAGE_TASKS.md 는 자동화만 고친다', () => {
    expect(checkDiff({ changes: [{ status: 'M', path: 'STAGE_TASKS.md' }] })).not.toEqual([])
    expect(
      checkDiff({
        changes: [{ status: 'M', path: 'STAGE_TASKS.md' }],
        allowedProtectedPaths: ['STAGE_TASKS.md'],
      }),
    ).toEqual([])
  })

  it('자동화 자체를 고치면 막는다 (세션이 자기 권한을 넓히지 못하게)', () => {
    for (const path of [
      'tools/stages/claude-session.mts',
      'tools/stages/guards.mts',
      'tests/stages-runner.test.ts',
    ]) {
      expect(checkDiff({ changes: [{ status: 'M', path }] }).map((v) => v.rule)).toContain(
        '자동화 자체 변경',
      )
    }
  })

  it('자동화가 아닌 tools 파일은 통과한다', () => {
    expect(checkDiff({ changes: [{ status: 'M', path: 'tools/boundaries.ts' }] })).toEqual([])
  })

  it('이름에 secret 이 들어간 소스 디렉터리는 막지 않는다', () => {
    // src/adapters/secret/ 은 키체인 어댑터다. 그 코드의 일이 키를 저장소 밖에 두는 것이다.
    for (const path of [
      'src/adapters/secret/index.ts',
      'src/adapters/secret/keychain.ts',
      'tests/keychain.test.ts',
    ]) {
      expect(checkDiff({ changes: [{ status: 'M', path }] })).toEqual([])
    }
  })

  it('파일 내용에 진짜 키가 들어가면 막는다', () => {
    const real = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`
    const violations = checkDiff({
      changes: [{ status: 'M', path: 'src/adapters/model/openrouter-gemma.ts' }],
      fileContents: new Map([
        ['src/adapters/model/openrouter-gemma.ts', `const key = '${real}'`],
      ]),
    })
    expect(violations.map((v) => v.rule)).toContain('비밀 정보')
    expect(violations[0]?.detail).toContain('OpenRouter')
  })

  it('테스트가 쓰는 가짜 키는 막지 않는다', () => {
    // 고정 응답 테스트는 키 모양의 자리표시자가 필요하다. 진짜 형식이 아니면 통과해야 한다.
    for (const fake of ['sk-or-v1-fixture-0123', 'sk-or-v1-fixture-key', 'sk-or-테스트']) {
      expect(
        checkDiff({
          changes: [{ status: 'M', path: 'tests/gemma.test.ts' }],
          fileContents: new Map([['tests/gemma.test.ts', `const FAKE_KEY = '${fake}'`]]),
        }),
      ).toEqual([])
    }
  })

  it('길기만 한 문자열(해시 등)은 키로 오인하지 않는다', () => {
    expect(
      checkDiff({
        changes: [{ status: 'M', path: 'tests/gemma.test.ts' }],
        fileContents: new Map([
          [
            'tests/gemma.test.ts',
            "const HASH = '500793c11e170293d768bc1513ea32300560445a3511c9b9d099171dfc95140a'",
          ],
        ]),
      }),
    ).toEqual([])
  })

  it('비밀 정보 경로를 막는다', () => {
    for (const path of ['.env', 'config/.env.local', 'certs/app.pem', '.npmrc', 'secrets.json']) {
      expect(checkDiff({ changes: [{ status: '??', path }] }).map((v) => v.rule)).toContain(
        '비밀 정보',
      )
    }
  })

  it('배포 설정을 막는다', () => {
    for (const path of ['.github/workflows/ci.yml', 'Dockerfile', 'electron-builder.yml']) {
      expect(checkDiff({ changes: [{ status: '??', path }] }).map((v) => v.rule)).toContain(
        '배포 설정',
      )
    }
  })

  it('파일 삭제를 막는다', () => {
    expect(
      checkDiff({ changes: [{ status: 'D', path: 'src/core/index.ts' }] }).map((v) => v.rule),
    ).toContain('파일 삭제')
  })

  it('package-lock.json 과 node_modules 변경을 막는다', () => {
    expect(
      checkDiff({ changes: [{ status: 'M', path: 'package-lock.json' }] }).map((v) => v.rule),
    ).toContain('의존성 산출물')
  })

  it('의존성이 추가되면 막는다 (무단 패키지 설치)', () => {
    const before = JSON.stringify({ dependencies: { fflate: '^0.8.3' } })
    const after = JSON.stringify({ dependencies: { fflate: '^0.8.3', lodash: '^4.0.0' } })
    const violations = checkDiff({
      changes: [{ status: 'M', path: 'package.json' }],
      packageJsonBefore: before,
      packageJsonAfter: after,
    })
    expect(violations.map((v) => v.rule)).toContain('무단 패키지 변경')
    expect(violations[0]?.detail).toContain('lodash')
  })

  it('의존성이 그대로면 package.json 변경은 통과한다 (스크립트 추가 등)', () => {
    const deps = { dependencies: { fflate: '^0.8.3' } }
    expect(
      checkDiff({
        changes: [{ status: 'M', path: 'package.json' }],
        packageJsonBefore: JSON.stringify(deps),
        packageJsonAfter: JSON.stringify({ ...deps, scripts: { a: 'b' } }),
      }),
    ).toEqual([])
  })
})

describe('사람 확인이 필요한 단계', () => {
  it('2단계는 실제 한글 저장 관찰이 필요하다', () => {
    const gates = detectHumanGates(stageOf(2))
    expect(gates.length).toBeGreaterThan(0)
    expect(gates.map((g) => g.reason).join(' ')).toContain('한글 for Mac')
  })

  it('4단계는 API 키가 필요하다', () => {
    expect(detectHumanGates(stageOf(4)).map((g) => g.reason).join(' ')).toContain('API 키')
  })

  it('7단계는 Claude Code 실행 방식 확인이 필요하다', () => {
    expect(detectHumanGates(stageOf(7)).map((g) => g.reason).join(' ')).toContain('Claude Code')
  })

  it('5단계는 화면 확인이 필요하다', () => {
    expect(detectHumanGates(stageOf(5)).map((g) => g.reason).join(' ')).toContain('화면')
  })

  it('6단계는 사람 확인이 필요 없다 (순수 알고리즘)', () => {
    expect(detectHumanGates(stageOf(6))).toEqual([])
  })

  it('안내 메시지가 사용자가 준 플래그를 이어서 제안한다', () => {
    const gates = detectHumanGates(stageOf(2))
    expect(formatGates(stageOf(2), gates)).toContain('npm run stage -- 2 --gate-ok')
    expect(formatGates(stageOf(2), gates, ['--review-only'])).toContain(
      'npm run stage -- 2 --review-only --gate-ok',
    )
  })
})

describe('claude 세션 인자와 출력', () => {
  it('구현 세션은 편집을 허용하되 위험한 명령을 막는다', () => {
    const args = buildArgs({ prompt: 'x', cwd: '/proj' })
    expect(args).toContain('--permission-prompts')
    expect(args).toContain('none')
    expect(args).toContain('acceptEdits')
    expect(args.join(' ')).toContain('Bash(npm install*)')
    expect(args.join(' ')).toContain('Bash(git push*)')
    expect(args.join(' ')).toContain('Bash(rm *)')
  })

  it('검토 세션은 명령 실행 도구를 뺀다', () => {
    const args = buildArgs({ prompt: 'x', cwd: '/proj', restricted: true })
    expect(args).toContain('--restricted')
    expect(args).not.toContain('acceptEdits')
  })

  it('세션 JSON 출력을 읽는다', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '완료',
      session_id: 's1',
      num_turns: 3,
      total_cost_usd: 0.1,
      permission_denials: [],
    })
    const result = parseSessionOutput(json, '', 0)
    expect(result).toMatchObject({ ok: true, text: '완료', sessionId: 's1', numTurns: 3 })
  })

  it('오류 결과를 실패로 본다', () => {
    const json = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'x' })
    expect(parseSessionOutput(json, '', 0).ok).toBe(false)
  })

  it('JSON 이 아니면 실패로 본다', () => {
    expect(parseSessionOutput('not json', 'boom', 1).ok).toBe(false)
  })

  it('검토 판정을 읽는다', () => {
    expect(parseVerdict('설명...\n{"verdict":"pass","summary":"좋다"}')).toMatchObject({
      verdict: 'pass',
    })
    expect(
      parseVerdict('{"verdict":"fail","summary":"부족","problems":["a","b"]}'),
    ).toMatchObject({ verdict: 'fail', problems: ['a', 'b'] })
  })

  it('판정을 읽지 못하면 통과로 보지 않는다', () => {
    expect(parseVerdict('좋아 보입니다!').verdict).toBe('unparsed')
    expect(parseVerdict('{"verdict":"maybe"}').verdict).toBe('unparsed')
  })
})

describe('git status 파싱', () => {
  it('상태 코드와 경로를 나눈다', () => {
    expect(parsePorcelain(' M src/a.ts\n?? tests/b.ts\n D src/c.ts\n')).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: '??', path: 'tests/b.ts' },
      { status: 'D', path: 'src/c.ts' },
    ])
  })

  it('이름이 바뀐 경우 새 이름을 쓴다', () => {
    expect(parsePorcelain('R  old.ts -> new.ts\n')).toEqual([{ status: 'R', path: 'new.ts' }])
  })
})
