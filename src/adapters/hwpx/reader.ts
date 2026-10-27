/**
 * HWPX 읽기 — **읽기 전용**.
 *
 * PRD 4.5: "프로그램은 사용자의 HWPX를 읽기만 하며 어떤 경우에도 수정하지 않는다."
 * 이 파일에 쓰기 코드를 추가하지 말 것.
 *
 * 확인된 구조 (한글 for Mac 12.30, Darwin 24.6 이 저장한 파일에서 관찰)
 * - 컨테이너: ZIP, `mimetype` 이 "application/hwp+zip"
 * - `Contents/content.hpf`: OPF. spine(itemref) 순서가 섹션 순서
 * - `Contents/header.xml`: hh:style (id, type, name) — 문단 역할 판정의 근거
 * - `Contents/sectionN.xml`: hs:sec 안에 hp:p
 *   - hp:p 속성: id, paraPrIDRef, styleIDRef ...
 *   - hp:p 자식: hp:run, hp:linesegarray(줄바꿈 계산 결과이므로 무시)
 *   - hp:run 자식: hp:t(텍스트), hp:tbl, hp:equation, hp:ctrl, hp:secPr
 *   - 표: hp:tbl > hp:tr > hp:tc > hp:subList > hp:p (문단이 중첩된다)
 */
import { readFileSync } from 'node:fs'

import { unzipSync } from 'fflate'
import { SaxesParser, type SaxesTagPlain } from 'saxes'

import { paragraphHash, paragraphUuid } from '../../core/document/hash.js'
import {
  roleFromStyleName,
  type HwpxDocument,
  type Paragraph,
  type TablePosition,
} from '../../core/document/model.js'
import { normalizeText } from '../../core/document/normalize.js'

const MIMETYPE = 'application/hwp+zip'

export class NotHwpxError extends Error {
  constructor(detail: string) {
    super(`HWPX 파일이 아닙니다: ${detail}`)
    this.name = 'NotHwpxError'
  }
}

/** 로컬 이름만 본다. 네임스페이스 접두사(hp:, hs: ...)는 파일마다 다를 수 있다. */
function localName(qualified: string): string {
  const colon = qualified.indexOf(':')
  return colon === -1 ? qualified : qualified.slice(colon + 1)
}

const decoder = new TextDecoder('utf-8')

function entryText(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path]
  return bytes === undefined ? null : decoder.decode(bytes)
}

/** header.xml 에서 스타일 id -> 이름 표를 만든다. */
export function parseStyles(headerXml: string): Map<string, string> {
  const styles = new Map<string, string>()
  const parser = new SaxesParser()
  parser.on('opentag', (tag: SaxesTagPlain) => {
    if (localName(tag.name) !== 'style') return
    const id = tag.attributes['id']
    const name = tag.attributes['name']
    if (typeof id === 'string' && typeof name === 'string') styles.set(id, name)
  })
  parser.write(headerXml).close()
  return styles
}

/** content.hpf 의 spine 순서로 섹션 경로를 돌려준다. */
export function parseSectionOrder(contentHpf: string): string[] {
  const hrefById = new Map<string, string>()
  const spine: string[] = []

  const parser = new SaxesParser()
  parser.on('opentag', (tag: SaxesTagPlain) => {
    const name = localName(tag.name)
    if (name === 'item') {
      const id = tag.attributes['id']
      const href = tag.attributes['href']
      if (typeof id === 'string' && typeof href === 'string') hrefById.set(id, href)
    } else if (name === 'itemref') {
      const idref = tag.attributes['idref']
      if (typeof idref === 'string') spine.push(idref)
    }
  })
  parser.write(contentHpf).close()

  return spine
    .map((id) => hrefById.get(id))
    .filter((href): href is string => href !== undefined && /section\d+\.xml$/.test(href))
}

/** spine 을 읽지 못했을 때의 대비책. sectionN.xml 을 숫자 순서로 정렬한다. */
function fallbackSectionOrder(files: Record<string, Uint8Array>): string[] {
  return Object.keys(files)
    .filter((path) => /^Contents\/section\d+\.xml$/.test(path))
    .sort((a, b) => sectionNumber(a) - sectionNumber(b))
}

function sectionNumber(path: string): number {
  const match = /section(\d+)\.xml$/.exec(path)
  return match === null ? 0 : Number(match[1])
}

/** 한 문단을 쌓아 두는 자리. 표 안 문단 때문에 스택으로 관리한다. */
interface PendingParagraph {
  styleIDRef: string | null
  chunks: string[]
  equations: string[]
  table: TablePosition | null
}

/** 섹션 XML 하나에서 문단을 문서 순서대로 뽑는다. */
export function parseSection(
  sectionXml: string,
  options: {
    sectionIndex: number
    styles: Map<string, string>
    /** 문서 전체에서 이 섹션이 시작하는 문단 번호 */
    startIndex: number
    /** 문서 전체에서 이 섹션이 시작하는 표 번호 */
    startTableIndex: number
  },
): { paragraphs: Paragraph[]; tableCount: number } {
  const paragraphs: Paragraph[] = []
  const paragraphStack: PendingParagraph[] = []
  const tableStack: { tableIndex: number; row: number; col: number }[] = []
  let tableCount = 0
  let index = options.startIndex
  /** hp:equation 안의 hp:script 텍스트만 모으기 위한 깊이 표시 */
  let equationDepth = 0
  let scriptDepth = 0
  /** hp:linesegarray 같은 무시 대상 안에 있는가 */
  let ignoreDepth = 0

  const parser = new SaxesParser()

  parser.on('opentag', (tag: SaxesTagPlain) => {
    const name = localName(tag.name)

    if (ignoreDepth > 0) {
      ignoreDepth += 1
      return
    }

    switch (name) {
      case 'linesegarray':
        // 줄바꿈 계산 결과다. 내용이 아니므로 통째로 건너뛴다.
        ignoreDepth = 1
        return
      case 'p': {
        const styleIDRef = tag.attributes['styleIDRef']
        paragraphStack.push({
          styleIDRef: typeof styleIDRef === 'string' ? styleIDRef : null,
          chunks: [],
          equations: [],
          table: currentTablePosition(tableStack),
        })
        return
      }
      case 'tbl':
        tableStack.push({ tableIndex: options.startTableIndex + tableCount, row: -1, col: -1 })
        tableCount += 1
        return
      case 'tc': {
        // 셀 주소는 hp:cellAddr 이 알려 준다. 없으면 순서로 센다.
        const top = tableStack[tableStack.length - 1]
        if (top !== undefined) top.col += 1
        return
      }
      case 'tr': {
        const top = tableStack[tableStack.length - 1]
        if (top !== undefined) {
          top.row += 1
          top.col = -1
        }
        return
      }
      case 'cellAddr': {
        const top = tableStack[tableStack.length - 1]
        const colAddr = tag.attributes['colAddr']
        const rowAddr = tag.attributes['rowAddr']
        if (top !== undefined && typeof colAddr === 'string' && typeof rowAddr === 'string') {
          top.col = Number(colAddr)
          top.row = Number(rowAddr)
        }
        return
      }
      case 'equation':
        equationDepth += 1
        return
      case 'script':
        if (equationDepth > 0) scriptDepth += 1
        return
      case 'lineBreak':
      case 'tab': {
        // 정규화가 공백으로 바꿔 준다.
        const current = paragraphStack[paragraphStack.length - 1]
        if (current !== undefined) current.chunks.push(' ')
        return
      }
      default:
        return
    }
  })

  parser.on('text', (text: string) => {
    if (ignoreDepth > 0) return
    if (scriptDepth > 0) {
      const current = paragraphStack[paragraphStack.length - 1]
      if (current !== undefined) current.equations.push(text)
      return
    }
    const current = paragraphStack[paragraphStack.length - 1]
    if (current !== undefined) current.chunks.push(text)
  })

  parser.on('closetag', (tag: SaxesTagPlain) => {
    const name = localName(tag.name)

    if (ignoreDepth > 0) {
      ignoreDepth -= 1
      return
    }

    switch (name) {
      case 'p': {
        const pending = paragraphStack.pop()
        if (pending === undefined) return
        const rawText = pending.chunks.join('')
        const text = normalizeText(rawText)
        const equations = pending.equations.map((e) => e.trim()).filter((e) => e.length > 0)
        const styleName =
          pending.styleIDRef === null ? null : (options.styles.get(pending.styleIDRef) ?? null)
        const { role, headingLevel } = roleFromStyleName(styleName)

        paragraphs.push({
          uuid: paragraphUuid({
            sectionIndex: options.sectionIndex,
            index,
            text,
            equations,
          }),
          index,
          sectionIndex: options.sectionIndex,
          role,
          headingLevel,
          styleName,
          table: pending.table,
          rawText,
          text,
          equations,
          hash: paragraphHash({ text, equations }),
        })
        index += 1
        return
      }
      case 'tbl':
        tableStack.pop()
        return
      case 'equation':
        equationDepth = Math.max(0, equationDepth - 1)
        return
      case 'script':
        if (equationDepth > 0) scriptDepth = Math.max(0, scriptDepth - 1)
        return
      default:
        return
    }
  })

  parser.write(sectionXml).close()
  return { paragraphs, tableCount }
}

function currentTablePosition(
  stack: readonly { tableIndex: number; row: number; col: number }[],
): TablePosition | null {
  const top = stack[stack.length - 1]
  if (top === undefined) return null
  return { tableIndex: top.tableIndex, row: Math.max(0, top.row), col: Math.max(0, top.col) }
}

/** HWPX 파일을 읽어 문단 목록을 돌려준다. 파일을 수정하지 않는다. */
export function readHwpx(absolutePath: string): HwpxDocument {
  const files = unzipSync(readFileSync(absolutePath))

  const mimetype = entryText(files, 'mimetype')?.trim()
  if (mimetype !== MIMETYPE) {
    throw new NotHwpxError(`mimetype 이 "${mimetype ?? '없음'}" 입니다`)
  }

  const headerXml = entryText(files, 'Contents/header.xml')
  const styles = headerXml === null ? new Map<string, string>() : parseStyles(headerXml)

  const contentHpf = entryText(files, 'Contents/content.hpf')
  let sectionPaths = contentHpf === null ? [] : parseSectionOrder(contentHpf)
  if (sectionPaths.length === 0) sectionPaths = fallbackSectionOrder(files)
  if (sectionPaths.length === 0) throw new NotHwpxError('본문 섹션을 찾지 못했습니다')

  const paragraphs: Paragraph[] = []
  let tableIndex = 0

  for (const [sectionIndex, path] of sectionPaths.entries()) {
    const xml = entryText(files, path)
    if (xml === null) throw new NotHwpxError(`본문 섹션이 누락되었습니다: ${path}`)
    const result = parseSection(xml, {
      sectionIndex,
      styles,
      startIndex: paragraphs.length,
      startTableIndex: tableIndex,
    })
    paragraphs.push(...result.paragraphs)
    tableIndex += result.tableCount
  }

  return { paragraphs, sectionCount: sectionPaths.length }
}
