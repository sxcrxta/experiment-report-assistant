/**
 * STAGE_TASKS.md 를 읽어 단계 목록을 만든다.
 *
 * 이 문서가 자동화의 유일한 입력이다. 문서에 없는 단계를 만들어 내지 않는다.
 */
import type { Stage, StageStatus } from './types.mts'

/** 진행 상황 표의 한 줄: | 1 | 이름 | 상태 | */
const TABLE_ROW = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/

/** 단계 제목: ## 3단계 — 평가 지침  (뒤에 ✅ 같은 표시가 붙을 수 있다) */
const STAGE_HEADING = /^##\s*(\d+)단계\s*[—-]\s*(.+?)\s*$/

/** 상태 칸의 글에서 상태를 읽는다. '보류' 가 '완료' 보다 앞선다 (둘 다 적히는 일은 없지만). */
export function statusOf(cell: string): StageStatus {
  if (cell.includes('보류')) return 'deferred'
  if (cell.includes('완료')) return 'done'
  return 'pending'
}

export function parseStatusTable(markdown: string): Map<number, { title: string; status: StageStatus }> {
  const out = new Map<number, { title: string; status: StageStatus }>()
  let inTable = false

  for (const line of markdown.split('\n')) {
    if (line.startsWith('| 단계 |')) {
      inTable = true
      continue
    }
    if (inTable && !line.startsWith('|')) {
      if (out.size > 0) break
      continue
    }
    if (!inTable) continue

    const match = TABLE_ROW.exec(line)
    if (match === null) continue
    const number = Number(match[1])
    const title = (match[2] ?? '').trim()
    const statusCell = match[3] ?? ''
    out.set(number, { title, status: statusOf(statusCell) })
  }

  return out
}

/** 단계 본문에서 "**제목**" 절 하나를 뽑는다. */
export function extractSection(body: string, heading: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim().startsWith(`**${heading}`))
  if (start === -1) return ''

  const collected: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (/^\*\*[^*]+\*\*/.test(line.trim()) && line.trim().endsWith('**')) break
    if (/^\*\*[^*]+:?\*\*\s*$/.test(line.trim())) break
    if (line.startsWith('## ')) break
    collected.push(line)
  }
  return collected.join('\n').trim()
}

export function parseStages(markdown: string): Stage[] {
  const table = parseStatusTable(markdown)
  const lines = markdown.split('\n')

  const headings: { number: number; title: string; line: number }[] = []
  lines.forEach((line, i) => {
    const match = STAGE_HEADING.exec(line)
    if (match !== null) {
      headings.push({ number: Number(match[1]), title: (match[2] ?? '').trim(), line: i })
    }
  })

  return headings.map((heading, i) => {
    // 다음 단계 제목이 아니라 **다음 `## ` 제목**에서 끊는다.
    // 단계 사이에 단계가 아닌 절(예: "## UI 통합")이 있으면 앞 단계 본문에 섞여 들어가,
    // 그 단계 세션이 범위를 착각한다.
    const nextStageLine = headings[i + 1]?.line ?? lines.length
    let end = nextStageLine
    for (let line = heading.line + 1; line < nextStageLine; line += 1) {
      if ((lines[line] as string).startsWith('## ')) {
        end = line
        break
      }
    }
    const body = lines.slice(heading.line + 1, end).join('\n').trim()
    const fromTable = table.get(heading.number)

    return {
      number: heading.number,
      title: fromTable?.title ?? heading.title.replace(/\s*✅.*$/, '').trim(),
      status: fromTable?.status ?? statusOf(heading.title),
      body,
      prerequisites: extractSection(body, '선행 조건'),
      tasks: extractSection(body, '작업'),
      completion: extractSection(body, '완료 조건'),
      outOfScope: extractSection(body, '이 단계에서 하지 않는 것'),
    }
  })
}

/**
 * 다음에 실행할 단계. 없으면 null.
 * 보류(deferred)는 건너뛴다. 이번 개발 범위 밖이기 때문이다.
 */
export function nextPendingStage(stages: readonly Stage[]): Stage | null {
  return [...stages].sort((a, b) => a.number - b.number).find((s) => s.status === 'pending') ?? null
}

/**
 * 진행 상황 표에서 한 단계의 상태 칸만 바꾼다.
 * 문서의 다른 부분은 건드리지 않는다.
 */
export function withUpdatedStatus(markdown: string, stageNumber: number, statusCell: string): string {
  let inTable = false
  let replaced = false

  const lines = markdown.split('\n').map((line) => {
    if (line.startsWith('| 단계 |')) {
      inTable = true
      return line
    }
    if (!inTable || replaced || !line.startsWith('|')) return line

    const match = TABLE_ROW.exec(line)
    if (match === null || Number(match[1]) !== stageNumber) return line

    replaced = true
    return `| ${match[1]} | ${(match[2] ?? '').trim()} | ${statusCell} |`
  })

  if (!replaced) {
    throw new Error(`진행 상황 표에서 ${stageNumber}단계 줄을 찾지 못했습니다`)
  }
  return lines.join('\n')
}
