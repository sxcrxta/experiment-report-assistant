/**
 * 설치된 Claude Code 를 찾고 로그인 상태를 본다 (PRD 4.3·5절, [Q-6], [Q-30]).
 *
 * **왜 로그인 셸을 거치는가:** `claude` 는 `~/.local/bin` 에 있고 그 경로는 로그인 셸의 PATH 에만 있다.
 * Finder 로 띄운 Electron 앱은 로그인 셸의 PATH 를 물려받지 않으므로 그냥 `spawn('claude')` 하면
 * 설치되어 있어도 `ENOENT` 가 난다. 그래서 `$SHELL -l -c 'command -v claude'` 를 한 번 실행해
 * 절대 경로를 얻는다 (`docs/V2-claude-code-확인.md` 1절).
 *
 * 여기서 하는 일은 **찾고 확인하는 것뿐이다.** 검토 요청은 `claude-code.ts` 가 보낸다.
 * 이 파일은 문서 내용을 다루지 않는다. 밖으로 나가는 것은 `command -v` 와 `auth status` 뿐이다.
 *
 * 쓰는 명령과 출력은 이 맥에 설치된 2.1.269 에서 실제로 확인한 것만 쓴다 (`CLAUDE.md` §7).
 * - 경로: `$SHELL -l -c 'command -v claude'` → 절대 경로 한 줄, 없으면 빈 출력에 0 아닌 종료 코드
 * - 로그인: `<경로> auth status` → JSON 이 기본 출력. `{"loggedIn": true, …}`
 * - 판: `<경로> --version` → `2.1.269 (Claude Code)`
 */
import { spawn } from 'node:child_process'

/** 감지 명령 하나의 결과. */
export interface CommandResult {
  /** 종료 코드. 신호로 끝났거나 실행하지 못했으면 null */
  code: number | null
  stdout: string
  stderr: string
  /** 프로그램을 찾지 못했다 (ENOENT) */
  notFound?: boolean
}

/** 명령 하나를 실행한다. 테스트에서는 고정 결과를 돌려주는 가짜로 바꾼다. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>

/** 감지 명령 하나가 기다리는 시간. 실측은 0.4초 안쪽이다. */
export const DETECT_TIMEOUT_MS = 10_000

/** 로그인 확인을 다시 묻지 않고 재사용하는 시간. 그 사이에 로그아웃하면 호출이 실패로 드러난다. */
export const AUTH_CACHE_MS = 60_000

export const runDetectCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, stdout, stderr: `${stderr}\n명령이 ${timeoutMs}ms 안에 끝나지 않았습니다.` })
    }, timeoutMs)

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (cause: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr: cause.message, notFound: cause.code === 'ENOENT' })
    })
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })

/** 지금 쓸 수 있는가. 쓸 수 없으면 무엇 때문인지. */
export type ClaudeCliState = 'ready' | 'not-installed' | 'not-logged-in' | 'error'

export interface ClaudeCliStatus {
  state: ClaudeCliState
  /** 찾은 절대 경로. 찾지 못했으면 null */
  path: string | null
  /** `--version` 첫 줄. 확인하지 못했으면 null */
  version: string | null
  /** 사용자가 그대로 읽는 한국어 안내 */
  message: string
  /** 사용자가 설정에서 직접 지정한 경로를 썼는가 */
  fromOverride: boolean
}

export interface ClaudeCliLocatorDeps {
  run?: CommandRunner
  /** 로그인 셸. 없으면 `$SHELL`, 그것도 없으면 /bin/zsh */
  shell?: string
  /** 사용자가 설정에서 직접 지정한 경로를 읽는다. 없으면 null */
  overridePath?: () => string | null
  now?: () => number
}

export interface ClaudeCliLocator {
  /** 지금 상태. 찾은 경로와 로그인 확인 결과를 잠시 재사용한다 */
  status(): Promise<ClaudeCliStatus>
  /** 캐시를 버린다. 사용자가 경로를 바꾸거나 로그인한 뒤에 부른다 */
  forget(): void
}

const NOT_INSTALLED_MESSAGE =
  'Claude Code 를 찾지 못했습니다. 설치되어 있다면 설정에서 실행 파일 경로를 직접 지정해 주세요. ' +
  '심층 검토만 쓸 수 없고 빠른 검토와 나머지 기능은 그대로 쓸 수 있습니다.'

const NOT_LOGGED_IN_MESSAGE =
  'Claude Code 에 로그인되어 있지 않습니다. 터미널에서 `claude auth login` 으로 로그인한 뒤 다시 확인해 주세요. ' +
  '그동안에도 빠른 검토와 나머지 기능은 그대로 쓸 수 있습니다.'

/** 경로로 쓸 수 있는 모양인가. 절대 경로만 받는다. */
export function isUsableCliPath(value: string): boolean {
  const path = value.trim()
  return path.startsWith('/') && !path.includes('\n') && path.length <= 1024
}

/** `command -v` 출력에서 경로 한 줄을 뽑는다. 여러 줄이면 첫 줄만 본다. */
export function parseWhichOutput(stdout: string): string | null {
  const first = stdout.split('\n').map((line) => line.trim()).find((line) => line !== '')
  if (first === undefined || !isUsableCliPath(first)) return null
  return first
}

/** `auth status` 의 JSON 에서 로그인 여부만 읽는다. 이메일·조직·구독 종류는 읽지 않는다. */
export function parseAuthStatus(stdout: string): { loggedIn: boolean } | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed !== 'object' || parsed === null) return null
    const loggedIn = (parsed as Record<string, unknown>)['loggedIn']
    return typeof loggedIn === 'boolean' ? { loggedIn } : null
  } catch {
    return null
  }
}

export function createClaudeCliLocator(deps: ClaudeCliLocatorDeps = {}): ClaudeCliLocator {
  const {
    run = runDetectCommand,
    shell = process.env['SHELL'] ?? '/bin/zsh',
    overridePath = () => null,
    now = () => Date.now(),
  } = deps

  let cached: { status: ClaudeCliStatus; at: number; override: string | null } | null = null
  /**
   * 진행 중인 감지. 화면이 깊이마다 한 번씩 물어보는 등 요청이 겹칠 때
   * 같은 명령을 여러 번 띄우지 않게 한다. 끝나면 비운다.
   */
  let inFlight: { promise: Promise<ClaudeCliStatus>; override: string | null } | null = null

  /** 로그인 셸로 경로를 찾는다. 사용자가 지정한 경로가 있으면 그것을 먼저 쓴다. */
  async function resolvePath(override: string | null): Promise<{ path: string; fromOverride: boolean } | null> {
    if (override !== null && isUsableCliPath(override)) {
      return { path: override.trim(), fromOverride: true }
    }
    const result = await run(shell, ['-l', '-c', 'command -v claude'], DETECT_TIMEOUT_MS)
    const path = result.code === 0 ? parseWhichOutput(result.stdout) : null
    return path === null ? null : { path, fromOverride: false }
  }

  async function detect(): Promise<ClaudeCliStatus> {
    const override = overridePath()
    const resolved = await resolvePath(override)
    if (resolved === null) {
      return { state: 'not-installed', path: null, version: null, message: NOT_INSTALLED_MESSAGE, fromOverride: false }
    }

    const base = { path: resolved.path, fromOverride: resolved.fromOverride }

    const version = await run(resolved.path, ['--version'], DETECT_TIMEOUT_MS)
    if (version.notFound === true || version.code !== 0) {
      return {
        ...base,
        state: 'not-installed',
        version: null,
        message: resolved.fromOverride
          ? `설정에 지정한 경로에서 Claude Code 를 실행하지 못했습니다: ${resolved.path}`
          : NOT_INSTALLED_MESSAGE,
      }
    }
    const versionLine = version.stdout.trim().split('\n')[0]?.trim() ?? null

    const auth = await run(resolved.path, ['auth', 'status'], DETECT_TIMEOUT_MS)
    const parsed = parseAuthStatus(auth.stdout)
    if (parsed === null) {
      return {
        ...base,
        state: 'error',
        version: versionLine,
        message:
          'Claude Code 의 로그인 상태를 읽지 못했습니다. 터미널에서 `claude auth status` 를 실행해 확인해 주세요.',
      }
    }
    if (!parsed.loggedIn) {
      return { ...base, state: 'not-logged-in', version: versionLine, message: NOT_LOGGED_IN_MESSAGE }
    }
    return {
      ...base,
      state: 'ready',
      version: versionLine,
      message: `Claude Code 를 쓸 수 있습니다 (${versionLine ?? '판 미상'}).`,
    }
  }

  return {
    async status(): Promise<ClaudeCliStatus> {
      const override = overridePath()
      if (cached !== null && cached.override === override && now() - cached.at < AUTH_CACHE_MS) {
        return cached.status
      }
      if (inFlight !== null && inFlight.override === override) return inFlight.promise

      const promise = detect().then((status) => {
        cached = { status, at: now(), override }
        return status
      })
      inFlight = { promise, override }
      try {
        return await promise
      } finally {
        if (inFlight?.promise === promise) inFlight = null
      }
    },
    forget(): void {
      cached = null
      inFlight = null
    },
  }
}
