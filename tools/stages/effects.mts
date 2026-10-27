/**
 * 실제 외부 작용. runner 의 Effects 를 git·npm·claude 로 구현한다.
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { parseVerdict, runClaude } from './claude-session.mts'
import { withUpdatedStatus } from './parse-stages.mts'
import { implementPrompt, reviewPrompt } from './prompts.mts'
import type { RunLog } from './runlog.mts'
import type { Effects } from './runner.mts'
import type { CommandResult, FileChange, Stage } from './types.mts'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

export function parsePorcelain(output: string): FileChange[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const status = line.slice(0, 2).trim()
      let path = line.slice(3)
      // 이름이 바뀐 경우 "old -> new" 형태다. 새 이름을 쓴다.
      const arrow = path.indexOf(' -> ')
      if (arrow !== -1) path = path.slice(arrow + 4)
      return { status, path: path.replace(/^"|"$/g, '') }
    })
}

export interface CreateEffectsOptions {
  projectRoot: string
  runLog: RunLog
  say(message: string): void
  sessionTimeoutMs: number
}

export function createEffects(options: CreateEffectsOptions): Effects {
  const cwd = options.projectRoot

  return {
    async gitRoot() {
      return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    },

    async branch() {
      return (await git(cwd, ['branch', '--show-current'])).trim()
    },

    async workingTreeClean() {
      return (await git(cwd, ['status', '--porcelain'])).trim().length === 0
    },

    async changedFiles() {
      return parsePorcelain(await git(cwd, ['status', '--porcelain']))
    },

    async diff() {
      const tracked = await git(cwd, ['diff', 'HEAD'])
      const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard']))
        .split('\n')
        .filter((p) => p.trim().length > 0)

      const extras = untracked
        .map((path) => {
          try {
            return `--- /dev/null\n+++ b/${path}\n${readFileSync(join(cwd, path), 'utf8')
              .split('\n')
              .map((l) => `+${l}`)
              .join('\n')}`
          } catch {
            return `+++ b/${path}\n(읽을 수 없는 파일)`
          }
        })
        .join('\n\n')

      return extras.length > 0 ? `${tracked}\n\n# 새로 생긴 파일\n${extras}` : tracked
    },

    async readFileAtHead(path) {
      try {
        return await git(cwd, ['show', `HEAD:${path}`])
      } catch {
        return null
      }
    },

    readFile(path) {
      try {
        return Promise.resolve(readFileSync(join(cwd, path), 'utf8'))
      } catch {
        return Promise.resolve(null)
      }
    },

    async commit(message) {
      await git(cwd, ['add', '-A'])
      await git(cwd, ['commit', '-m', message])
      return (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
    },

    async runCheck() {
      try {
        const { stdout, stderr } = await exec('npm', ['run', 'check'], {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
        })
        return { ok: true, code: 0, stdout, stderr }
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string }
        return {
          ok: false,
          code: e.code ?? 1,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? String(error),
        } satisfies CommandResult
      }
    },

    async implement(stage: Stage, attempt: number, problems: string[]) {
      const prompt = implementPrompt(stage, attempt, problems)
      options.runLog.artifact(`stage${stage.number}-implement-${attempt}.prompt.txt`, prompt)
      const result = await runClaude({ prompt, cwd, timeoutMs: options.sessionTimeoutMs })
      options.runLog.artifact(`stage${stage.number}-implement-${attempt}.result.json`, result.raw)
      return result
    },

    async review(stage: Stage, diff: string, checkOutput: string) {
      const prompt = reviewPrompt(stage, diff, checkOutput)
      options.runLog.artifact(`stage${stage.number}-review.prompt.txt`, prompt)
      const result = await runClaude({
        prompt,
        cwd,
        restricted: true,
        timeoutMs: options.sessionTimeoutMs,
      })
      options.runLog.artifact(`stage${stage.number}-review.result.json`, result.raw)
      if (!result.ok) {
        return { verdict: 'unparsed' as const, summary: '검토 세션이 실패했습니다', raw: result.text }
      }
      return parseVerdict(result.text)
    },

    updateStageStatus(stage: Stage, statusCell: string) {
      const path = join(cwd, 'STAGE_TASKS.md')
      const updated = withUpdatedStatus(readFileSync(path, 'utf8'), stage.number, statusCell)
      writeFileSync(path, updated)
      return Promise.resolve()
    },

    log(event, stage, detail) {
      options.runLog.entry(event, stage, detail)
    },

    say: (message: string) => options.say(message),
  }
}
