/**
 * 실행 기록.
 *
 * 무엇을 시도했고 왜 멈췄는지 나중에 확인할 수 있어야 한다.
 * 기록은 logs/stages/ 에 남기고 커밋하지 않는다 (.gitignore).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LogEntry {
  time: string
  stage: number | null
  event: string
  detail?: unknown
}

export interface RunLog {
  runId: string
  dir: string
  entry(event: string, stage: number | null, detail?: unknown): void
  artifact(name: string, content: string): string
  path: string
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

export function createRunLog(projectRoot: string, now: Date = new Date()): RunLog {
  const runId = timestamp(now)
  const dir = join(projectRoot, 'logs', 'stages', runId)
  mkdirSync(dir, { recursive: true })

  const path = join(dir, 'run.jsonl')
  writeFileSync(path, '')

  return {
    runId,
    dir,
    path,
    entry(event, stage, detail) {
      const line: LogEntry = { time: new Date().toISOString(), stage, event }
      if (detail !== undefined) line.detail = detail
      appendFileSync(path, `${JSON.stringify(line)}\n`)
    },
    artifact(name, content) {
      const target = join(dir, name)
      writeFileSync(target, content)
      return target
    },
  }
}

/** 화면 출력용. 기록과 별개로 사람이 읽는 줄. */
export function say(message: string): void {
  process.stdout.write(`${message}\n`)
}
