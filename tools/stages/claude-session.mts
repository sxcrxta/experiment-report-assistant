/**
 * claude -p 세션 실행.
 *
 * 인자와 출력 형식은 설치된 CLI(2.1.266)에서 직접 확인한 것만 쓴다 (CLAUDE.md §7).
 * - -p / --output-format json  -> { type, subtype, is_error, result, session_id, num_turns, ... }
 * - --permission-mode acceptEdits
 * - --permission-prompts none  -> 물어봐야 하는 일은 자동으로 거부된다 (무인 실행에서 멈추지 않는다)
 * - --allowedTools / --disallowedTools  -> "Bash(git *)" 같은 형태
 * - --restricted -> Bash 등 명령 실행 도구를 뺀다 (검토 세션용)
 */
import { spawn } from 'node:child_process'

import type { ReviewVerdict, SessionResult } from './types.mts'

/** 구현 세션이 쓸 수 있는 도구. 여기 없는 것은 자동으로 거부된다. */
export const IMPLEMENT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(npm run *)',
  'Bash(npm test)',
  'Bash(npx vitest*)',
  'Bash(npx tsc*)',
  'Bash(npx eslint*)',
  'Bash(node *)',
  'Bash(ls *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(grep *)',
  'Bash(find *)',
  'Bash(git status*)',
  'Bash(git diff*)',
]

/** 구현 세션이 절대 못 쓰는 것. 허용 목록과 겹쳐서 두 겹으로 막는다. */
export const IMPLEMENT_DISALLOWED_TOOLS = [
  'Bash(npm run stage*)',
  'Bash(npm install*)',
  'Bash(npm i *)',
  'Bash(npm uninstall*)',
  'Bash(npm publish*)',
  'Bash(npx *--yes*)',
  'Bash(yarn*)',
  'Bash(pnpm*)',
  'Bash(rm *)',
  'Bash(rmdir*)',
  'Bash(mv *)',
  'Bash(git commit*)',
  'Bash(git push*)',
  'Bash(git reset*)',
  'Bash(git checkout*)',
  'Bash(git branch*)',
  'Bash(git clean*)',
  'Bash(curl*)',
  'Bash(wget*)',
  'Bash(ssh*)',
  'Bash(security*)',
  'Bash(sudo*)',
  'WebFetch',
  'WebSearch',
]

export interface RunClaudeOptions {
  prompt: string
  cwd: string
  /** 검토 세션이면 true. 명령 실행 도구를 뺀다 */
  restricted?: boolean
  timeoutMs?: number
  claudeBin?: string
}

interface ClaudeJson {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  session_id?: string
  num_turns?: number
  total_cost_usd?: number
  permission_denials?: unknown[]
}

export function buildArgs(options: RunClaudeOptions): string[] {
  const args = ['-p', '--output-format', 'json', '--permission-prompts', 'none']

  if (options.restricted === true) {
    args.push('--restricted')
  } else {
    args.push('--permission-mode', 'acceptEdits')
    args.push('--allowedTools', ...IMPLEMENT_ALLOWED_TOOLS)
    args.push('--disallowedTools', ...IMPLEMENT_DISALLOWED_TOOLS)
  }

  return args
}

export async function runClaude(options: RunClaudeOptions): Promise<SessionResult> {
  const bin = options.claudeBin ?? 'claude'
  const args = buildArgs(options)

  const raw = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            if (settled) return
            settled = true
            child.kill('SIGTERM')
            reject(new Error(`claude 세션이 ${options.timeoutMs}ms 안에 끝나지 않았습니다`))
          }, options.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? -1 })
    })

    child.stdin.write(options.prompt)
    child.stdin.end()
  })

  return parseSessionOutput(raw.stdout, raw.stderr, raw.code)
}

export function parseSessionOutput(stdout: string, stderr: string, code: number): SessionResult {
  let parsed: ClaudeJson | null
  try {
    parsed = JSON.parse(stdout) as ClaudeJson
  } catch {
    parsed = null
  }

  if (parsed === null) {
    return {
      ok: false,
      text: stderr.trim() || stdout.trim(),
      sessionId: null,
      costUsd: null,
      numTurns: null,
      permissionDenials: [],
      raw: stdout,
    }
  }

  return {
    ok: code === 0 && parsed.is_error !== true && parsed.subtype === 'success',
    text: parsed.result ?? '',
    sessionId: parsed.session_id ?? null,
    costUsd: parsed.total_cost_usd ?? null,
    numTurns: parsed.num_turns ?? null,
    permissionDenials: parsed.permission_denials ?? [],
    raw: stdout,
  }
}

/** 검토 세션의 응답에서 판정을 읽는다. JSON 블록을 찾아 파싱한다. */
export function parseVerdict(text: string): ReviewVerdict {
  const candidates = [...text.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]).reverse()

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        verdict?: unknown
        summary?: unknown
        problems?: unknown
      }
      const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
      if (parsed.verdict === 'pass') {
        return { verdict: 'pass', summary, raw: text }
      }
      if (parsed.verdict === 'fail') {
        return {
          verdict: 'fail',
          summary,
          problems: Array.isArray(parsed.problems)
            ? parsed.problems.filter((p): p is string => typeof p === 'string')
            : [],
          raw: text,
        }
      }
    } catch {
      continue
    }
  }

  return { verdict: 'unparsed', summary: '검토 응답에서 판정을 읽지 못했습니다', raw: text }
}
