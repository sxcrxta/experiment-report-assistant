/**
 * 보고서의 목차(구조) — 검토 화면에서 "이론적 배경 > 가. …" 처럼 골라 요청하는 데 쓴다 ([Q-47]).
 *
 * 누가 무엇을 정하나
 * - **어느 문단이 제목이고 몇 급인지**: AI 가 제안한다 (`app/document-outline.ts`). 쓸 수 없으면 아래의
 *   번호 규칙(`ruleHeadings`)으로 정한다.
 * - **각 항목이 어디까지인지**: 언제나 이 파일의 `buildOutline` 이 정한다 — 다음의 같은 급·윗급 제목 직전까지.
 *   AI 가 범위를 정하지 않는다 (`CLAUDE.md` §2).
 *
 * 부작용 없는 순수 함수만 둔다. 렌더러·앱·테스트가 함께 쓴다.
 */
import type { ParagraphChoice } from './feedback.js'

/** 제목 하나. 문단 순서 위치와 급(1 이 가장 크다), 보여 줄 이름 */
export interface HeadingMark {
  index: number
  level: number
  title: string
}

export interface OutlineNode {
  title: string
  level: number
  /** 이 항목의 문단 (제목 문단 포함, 문서 순서). 요청할 때는 글이 있는 문단만 보낸다 */
  paragraphIds: string[]
  /** 글이 있는 문단 수 (제목 문단 포함) */
  writtenCount: number
  children: OutlineNode[]
}

export interface OutlineView {
  /** ai: AI 가 나눈 목차, rule: 번호 규칙으로 나눈 목차 */
  source: 'ai' | 'rule'
  /**
   * ready: 지금 문서와 맞다. stale: AI 목차가 있지만 제목이 바뀌었다(다시 분석하면 좋다).
   * missing: 아직 AI 로 나누지 않았다.
   */
  status: 'ready' | 'stale' | 'missing'
  /** AI 목차면 쓴 모델. 보여 주기만 하고 분기에 쓰지 않는다 */
  modelId: string | null
  nodes: OutlineNode[]
}

/** 목차 항목의 최대 급 */
export const OUTLINE_MAX_LEVEL = 3
/** 목차 항목의 최대 수 */
export const OUTLINE_MAX_ITEMS = 80

/** 번호 제목의 급. 작을수록 큰 제목이다. 제목이 아니면 null */
export function headingLevel(text: string): number | null {
  const t = text.trim()
  if (t.length === 0 || t.length > 40) return null
  // 번호 뒤에 띄어쓰기와 글자가 와야 제목이다. "24.5 ℃", "26.08.26.(수)" 같은 값은 제목이 아니다.
  const word = '\\s+[가-힣A-Za-z]'
  if (new RegExp(`^\\d{1,2}\\.${word}`).test(t)) return 1
  if (new RegExp(`^[IVX]{1,4}\\.${word}`).test(t)) return 1
  if (new RegExp(`^[가-하]\\.${word}`).test(t)) return 2
  if (new RegExp(`^\\d{1,2}\\)${word}`).test(t)) return 3
  if (new RegExp(`^\\(\\d{1,2}\\)${word}`).test(t)) return 4
  return null
}

/** 번호 규칙으로 찾은 제목들 (AI 를 쓸 수 없을 때의 목차) */
export function ruleHeadings(paragraphs: readonly Pick<ParagraphChoice, 'text'>[]): HeadingMark[] {
  return paragraphs.flatMap((paragraph, index) => {
    const level = headingLevel(paragraph.text)
    return level === null || level > OUTLINE_MAX_LEVEL ? [] : [{ index, level, title: paragraph.text.trim() }]
  })
}

/**
 * 제목 목록을 목차 나무로 만든다. 항목은 제목 문단부터 **다음의 같은 급·윗급 제목 직전까지**다.
 * 급이 건너뛰면(1 → 3) 가까운 윗항목의 자식으로 둔다. 순서가 어긋난 제목은 버린다.
 */
export function buildOutline(
  marks: readonly HeadingMark[],
  paragraphs: readonly Pick<ParagraphChoice, 'paragraphId' | 'hasContent'>[],
): OutlineNode[] {
  const sorted = [...marks]
    .filter((mark) => mark.index >= 0 && mark.index < paragraphs.length && mark.level >= 1)
    .sort((a, b) => a.index - b.index)
    .filter((mark, i, all) => i === 0 || all[i - 1]!.index !== mark.index)

  const roots: OutlineNode[] = []
  const stack: { level: number; node: OutlineNode }[] = []
  sorted.forEach((mark, i) => {
    let end = paragraphs.length
    for (const next of sorted.slice(i + 1)) {
      if (next.level <= mark.level) { end = next.index; break }
    }
    const range = paragraphs.slice(mark.index, end)
    const node: OutlineNode = {
      title: mark.title,
      level: mark.level,
      paragraphIds: range.map((p) => p.paragraphId),
      writtenCount: range.filter((p) => p.hasContent).length,
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1]!.level >= mark.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(node)
    else parent.node.children.push(node)
    stack.push({ level: mark.level, node })
  })
  return roots
}

/** 나무를 문서 순서로 펼친다. 윗항목 이름을 함께 준다 */
export function flattenOutline(nodes: readonly OutlineNode[], parents: readonly string[] = []):
  { node: OutlineNode; parents: string[] }[] {
  return nodes.flatMap((node) => [{ node, parents: [...parents] },
    ...flattenOutline(node.children, [...parents, node.title])])
}

/** 버튼에 쓸 짧은 이름. 앞 번호("2.", "가.", "1)")를 뗀다 */
export function shortTitle(title: string): string {
  const short = title.trim().replace(/^(\d{1,2}\.|[IVX]{1,4}\.|[가-하]\.|\d{1,2}\)|\(\d{1,2}\))\s*/, '')
  return short.length >= 2 ? short : title.trim()
}
