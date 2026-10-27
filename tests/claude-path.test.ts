/**
 * 7단계 — 설치된 Claude Code 찾기와 로그인 확인 ([Q-6], [Q-30], `docs/V2-claude-code-확인.md`).
 *
 * 여기서 지키는 것
 * - GUI 앱의 PATH 에는 `~/.local/bin` 이 없다. **로그인 셸을 거쳐** 경로를 얻는다.
 * - 못 찾았거나 로그인되어 있지 않으면 **그 사실만 알리고** 나머지 기능을 막지 않는다.
 * - 사용자가 지정한 경로가 있으면 그것을 먼저 쓴다.
 * - 실제 프로세스를 띄우지 않는다. 명령 실행은 고정 결과를 돌려주는 가짜로 바꾼다.
 */
import { describe, expect, it } from 'vitest'

import {
  createClaudeCliLocator,
  isUsableCliPath,
  parseAuthStatus,
  parseWhichOutput,
  type CommandResult,
} from '../src/adapters/model/claude-path.js'

const CLI = '/Users/me/.local/bin/claude'

interface Call {
  command: string
  args: string[]
}

/** 명령마다 정해 둔 결과를 돌려주는 가짜. 부른 내역을 남긴다. */
function fakeRunner(
  replies: Partial<{ which: CommandResult; version: CommandResult; auth: CommandResult }> = {},
): { run: (command: string, args: readonly string[]) => Promise<CommandResult>; calls: Call[] } {
  const calls: Call[] = []
  const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' })
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args: [...args] })
      if (args.includes('command -v claude')) return Promise.resolve(replies.which ?? ok(`${CLI}\n`))
      if (args[0] === '--version') return Promise.resolve(replies.version ?? ok('2.1.269 (Claude Code)\n'))
      if (args[0] === 'auth') {
        return Promise.resolve(replies.auth ?? ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })))
      }
      throw new Error(`예상하지 못한 명령: ${command} ${args.join(' ')}`)
    },
  }
}

function locator(
  replies?: Parameters<typeof fakeRunner>[0],
  overridePath: () => string | null = () => null,
): ReturnType<typeof createClaudeCliLocator> & { calls: Call[] } {
  const runner = fakeRunner(replies)
  const created = createClaudeCliLocator({ run: runner.run, shell: '/bin/zsh', overridePath })
  return Object.assign(created, { calls: runner.calls })
}

describe('명령 출력 읽기', () => {
  it('command -v 의 첫 줄만 절대 경로로 받는다', () => {
    expect(parseWhichOutput(`${CLI}\n/usr/local/bin/claude\n`)).toBe(CLI)
    expect(parseWhichOutput('  \n')).toBeNull()
    // 상대 경로나 셸이 찍은 안내는 경로로 쓰지 않는다.
    expect(parseWhichOutput('claude not found')).toBeNull()
    expect(parseWhichOutput('./claude')).toBeNull()
  })

  it('auth status 에서 loggedIn 만 읽는다', () => {
    const status = parseAuthStatus(JSON.stringify({ loggedIn: true, email: 'me@example.com', orgId: 'x' }))
    // 이메일·조직은 읽지 않는다. 필요하지 않고, 화면에도 쓰지 않는다.
    expect(status).toEqual({ loggedIn: true })
    expect(parseAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false })
    expect(parseAuthStatus('로그인이 필요합니다')).toBeNull()
    expect(parseAuthStatus('{}')).toBeNull()
  })

  it('절대 경로만 받는다', () => {
    expect(isUsableCliPath(CLI)).toBe(true)
    expect(isUsableCliPath('claude')).toBe(false)
    expect(isUsableCliPath('/bin/claude\n rm -rf /')).toBe(false)
  })
})

describe('설치와 로그인 감지', () => {
  it('로그인 셸로 경로를 찾고 판과 로그인까지 확인한다', async () => {
    const cli = locator()
    const status = await cli.status()

    expect(status).toMatchObject({ state: 'ready', path: CLI, version: '2.1.269 (Claude Code)', fromOverride: false })
    // GUI 앱의 PATH 를 믿지 않는다. 로그인 셸(-l)을 거친다.
    expect(cli.calls[0]).toEqual({ command: '/bin/zsh', args: ['-l', '-c', 'command -v claude'] })
    expect(cli.calls[1]).toEqual({ command: CLI, args: ['--version'] })
    expect(cli.calls[2]).toEqual({ command: CLI, args: ['auth', 'status'] })
  })

  it('찾지 못하면 설치되지 않음으로 보고, 무엇을 하면 되는지 알린다', async () => {
    const cli = locator({ which: { code: 1, stdout: '', stderr: '' } })
    const status = await cli.status()

    expect(status.state).toBe('not-installed')
    expect(status.path).toBeNull()
    expect(status.message).toContain('빠른 검토')
    // 찾지 못했으면 실행해 보지도 않는다.
    expect(cli.calls).toHaveLength(1)
  })

  it('로그인되어 있지 않으면 그 사실과 할 일을 알린다', async () => {
    const cli = locator({ auth: { code: 0, stdout: '{"loggedIn":false}', stderr: '' } })
    const status = await cli.status()

    expect(status.state).toBe('not-logged-in')
    expect(status.message).toContain('claude auth login')
    expect(status.path).toBe(CLI)
  })

  it('로그인 상태를 읽지 못하면 조용히 넘기지 않고 확인 실패로 알린다', async () => {
    const cli = locator({ auth: { code: 0, stdout: '알 수 없는 출력', stderr: '' } })
    expect((await cli.status()).state).toBe('error')
  })

  it('찾은 경로에서 실행하지 못하면 설치되지 않은 것으로 본다', async () => {
    const cli = locator({ version: { code: null, stdout: '', stderr: 'ENOENT', notFound: true } })
    expect((await cli.status()).state).toBe('not-installed')
  })
})

describe('사용자가 지정한 경로', () => {
  it('지정한 경로가 있으면 로그인 셸을 거치지 않는다', async () => {
    const cli = locator(undefined, () => '/opt/claude')
    const status = await cli.status()

    expect(status).toMatchObject({ state: 'ready', path: '/opt/claude', fromOverride: true })
    expect(cli.calls.map((call) => call.command)).toEqual(['/opt/claude', '/opt/claude'])
  })

  it('지정한 경로가 돌지 않으면 그 경로를 그대로 적어 알린다', async () => {
    const cli = locator({ version: { code: 127, stdout: '', stderr: '' } }, () => '/opt/claude')
    const status = await cli.status()

    expect(status.state).toBe('not-installed')
    expect(status.message).toContain('/opt/claude')
  })

  it('지정한 경로가 바뀌면 캐시를 쓰지 않고 다시 찾는다', async () => {
    let override: string | null = null
    const cli = locator(undefined, () => override)

    await cli.status()
    const before = cli.calls.length
    await cli.status()
    // 같은 조건이면 다시 묻지 않는다 (감지에 프로세스를 세 번 띄운다).
    expect(cli.calls).toHaveLength(before)

    override = '/opt/claude'
    expect((await cli.status()).path).toBe('/opt/claude')
    expect(cli.calls.length).toBeGreaterThan(before)
  })

  it('시간이 지나면 로그인 상태를 다시 확인한다', async () => {
    const runner = fakeRunner()
    let clock = 0
    const cli = createClaudeCliLocator({ run: runner.run, shell: '/bin/zsh', now: () => clock })

    await cli.status()
    const before = runner.calls.length
    clock = 61_000
    await cli.status()
    expect(runner.calls.length).toBeGreaterThan(before)
  })

  it('forget 을 부르면 곧바로 다시 찾는다', async () => {
    const cli = locator()
    await cli.status()
    const before = cli.calls.length
    cli.forget()
    await cli.status()
    expect(cli.calls.length).toBeGreaterThan(before)
  })
})


it('겹쳐 물어도 감지 명령을 한 번만 띄운다', async () => {
  const cli = locator()
  // 화면이 깊이마다 한 번씩 묻는 상황. 같은 명령을 여러 번 실행하지 않는다.
  const [first, second] = await Promise.all([cli.status(), cli.status()])

  expect(first).toEqual(second)
  expect(cli.calls).toHaveLength(3)
})
