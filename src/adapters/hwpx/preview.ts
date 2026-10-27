/** HWPX ZIP 안의 표·셀·그림·문단 서식만 읽는다. 외부 참조를 열거나 파일을 쓰지 않는다. */
import { unzipSync } from 'fflate'
import { SaxesParser, type SaxesTagPlain } from 'saxes'

import { normalizeText } from '../../core/document/normalize.js'
import { parseHwpEquation } from '../../core/math/hwp-equation.js'
import type {
  DocumentPreview, PreviewBlock, PreviewBorder, PreviewCell, PreviewEdges, PreviewEquation,
  PreviewPage, PreviewParagraph, PreviewTable,
} from '../../shared/document-preview.js'
import { parseSectionOrder } from './reader.js'

interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }
/** 글자도 문서 순서대로 담는다. 수식이 문단 어디에 놓였는지 세려면 순서가 필요하다. */
const TEXT_NODE = '#text'
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: 'root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const parser = new SaxesParser()
  parser.on('opentag', (tag: SaxesTagPlain) => {
    const node: XmlNode = { name: tag.name.split(':').at(-1)!, attrs: tag.attributes, children: [], text: '' }
    stack.at(-1)!.children.push(node)
    stack.push(node)
  })
  parser.on('text', (text: string) => {
    stack.at(-1)!.children.push({ name: TEXT_NODE, attrs: {}, children: [], text })
  })
  parser.on('closetag', () => { stack.pop() })
  parser.write(xml).close()
  return root
}
function descendants(node: XmlNode, name: string): XmlNode[] {
  return node.children.flatMap(child => [
    ...(child.name === name ? [child] : []), ...descendants(child, name),
  ])
}
/** 태그 안의 글자를 모두 이어 붙인다 (수식 스크립트를 꺼낼 때 쓴다). */
function textOf(node: XmlNode): string {
  return node.name === TEXT_NODE ? node.text : node.children.map(textOf).join('')
}
function size(value: string | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(n / 75, 2000) : 0
}
/** 문단 여백·들여쓰기는 음수(내어쓰기)도 있다. */
function offsetSize(value: string | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(-200, Math.min(n / 75, 400)) : 0
}
function integer(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : fallback
}
/** `#RRGGBB` 만 받아들인다. `none` 이나 빈 값은 지정이 없는 것으로 본다. */
function color(value: string | undefined): string | null {
  return value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null
}
/**
 * 글꼴 이름. 인라인 스타일에 그대로 들어가므로 글자·숫자·공백·하이픈만 받는다.
 * 따옴표나 세미콜론이 섞인 이름은 스타일 선언을 깨고 다른 선언을 밀어 넣을 수 있어 버린다.
 */
function fontName(value: string | undefined): string | null {
  return value !== undefined && value.length <= 60 && /^[\p{L}\p{N} _-]+$/u.test(value) ? value : null
}

/** `left`·`right`·`top`·`bottom` 속성을 가진 여백 태그를 px 로 읽는다. */
function edges(node: XmlNode | undefined, fallback = 0): PreviewEdges {
  const value = (name: string): number => {
    const raw = node?.attrs[name]
    return raw === undefined ? fallback : size(raw)
  }
  return { top: value('top'), right: value('right'), bottom: value('bottom'), left: value('left') }
}

/**
 * 첫 구역의 쪽 설정. 한글이 쓴 A4 폭과 여백을 그대로 쓴다.
 * 쪽 나눔은 재현하지 않지만, **글 폭이 같아야 줄바꿈이 원본과 비슷해진다.**
 * 머리말·꼬리말 높이는 위·아래 여백에 더한다 (그만큼 본문이 안쪽에서 시작한다).
 */
const A4: PreviewPage = { width: 794, marginTop: 76, marginRight: 113, marginBottom: 76, marginLeft: 113 }
function readPage(section: XmlNode): PreviewPage {
  const pagePr = descendants(section, 'pagePr')[0]
  if (pagePr === undefined) return A4
  const margin = descendants(pagePr, 'margin')[0]
  const width = size(pagePr.attrs['width'])
  const header = size(margin?.attrs['header'])
  const footer = size(margin?.attrs['footer'])
  const box = edges(margin)
  return {
    width: width > 100 ? width : A4.width,
    marginTop: box.top + header,
    marginRight: box.right,
    marginBottom: box.bottom + footer,
    marginLeft: box.left,
  }
}

const BORDER_NONE: PreviewBorder = { style: 'none', width: 0, color: '#000000' }
/** 한글의 선 종류를 화면이 그릴 수 있는 값으로 옮긴다. 모르는 종류는 실선으로 둔다. */
function borderStyle(type: string | undefined): PreviewBorder['style'] {
  if (type === undefined || type === 'NONE') return 'none'
  if (type.startsWith('DOT') && !type.startsWith('DOT_DASH')) return 'dotted'
  if (type.includes('DASH')) return 'dashed'
  if (type.startsWith('DOUBLE') || type.includes('_2') || type === 'TRIPLE') return 'double'
  return 'solid'
}
/** 선 두께는 `0.12 mm` 처럼 단위가 붙어 온다. 화면에서 보이도록 최소 1px 로 둔다. */
function borderWidth(value: string | undefined): number {
  const mm = Number((value ?? '').replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(mm) || mm <= 0) return 1
  return Math.max(1, Math.min(6, Math.round(mm * 3.78)))
}
function border(node: XmlNode | undefined): PreviewBorder {
  if (node === undefined) return BORDER_NONE
  const style = borderStyle(node.attrs['type'])
  if (style === 'none') return BORDER_NONE
  return { style, width: borderWidth(node.attrs['width']), color: color(node.attrs['color']) ?? '#000000' }
}

interface BorderFill {
  border: PreviewCell['border']
  background: string | null
}
/** `header.xml` 의 `borderFill` 정의를 셀이 참조한다 (`borderFillIDRef`). */
function readBorderFills(header: XmlNode): Map<string, BorderFill> {
  return new Map(descendants(header, 'borderFill').map(node => {
    const side = (name: string): PreviewBorder =>
      border(node.children.find(child => child.name === name))
    const face = descendants(node, 'winBrush')[0]?.attrs['faceColor']
    return [node.attrs['id'] ?? '', {
      border: {
        top: side('topBorder'), right: side('rightBorder'),
        bottom: side('bottomBorder'), left: side('leftBorder'),
      },
      // 흰 채우기는 화면 배경과 같으므로 굳이 칠하지 않는다.
      background: face === '#FFFFFF' ? null : color(face),
    }]
  }))
}
const NO_FILL: BorderFill = {
  border: { top: BORDER_NONE, right: BORDER_NONE, bottom: BORDER_NONE, left: BORDER_NONE },
  background: null,
}

/** 자기 문단을 따로 갖는 중첩 구조. 표·글상자·각주의 문단은 자기 글과 수식을 스스로 가진다. */
const NESTED_PARAGRAPH = new Set(['tbl', 'subList', 'p'])

/**
 * 한글의 글 흐름에서 **인라인 개체 하나가 차지하는 칸 수**.
 *
 * `lineseg` 의 `textpos` 는 글자 수가 아니라 이 흐름에서의 위치다. 순수한 글에서는 글자 수와
 * 같지만, 수식·그림·표 같은 개체는 여러 칸을 차지한다. 실제 보고서에서 잰 값이 8이다
 * (줄 너비 `horzsize` 와 맞춰 보면 7은 1485, **8은 689**, 9는 958 HWPUNIT 어긋난다.
 * 한 글자가 약 1000 이므로 8이 뚜렷한 최솟값이고, 435개 문단이 모두 앞뒤가 맞는다).
 */
const OBJECT_UNITS = 8

/** 글 흐름에서 한 칸을 차지하는 제어 문자. 정규화가 공백으로 바꾼다. */
const CHAR_CONTROLS = new Set(['tab', 'lineBreak', 'hyphen', 'nbSpace', 'fwSpace'])

/** 글 흐름에서 `OBJECT_UNITS` 칸을 차지하는 개체. */
const INLINE_OBJECTS = new Set([
  'equation', 'pic', 'tbl', 'container', 'rect', 'line', 'ellipse', 'arc', 'polygon', 'curve',
  'connectLine', 'textart', 'ole', 'chart', 'video', 'footNote', 'endNote', 'compose', 'dutmal',
  'btn', 'hiddenComment',
])

/**
 * 공백류와 보이지 않는 글자. `core/document/normalize.ts` 와 같은 목록이되 `g` 플래그를 뺐다
 * (`g` 가 붙은 정규식의 `test` 는 호출마다 위치를 기억해 글자 하나씩 볼 때 틀린 답을 준다).
 * 두 곳이 어긋나면 아래 `trusted` 검사가 걸러 낸다.
 */
const WHITESPACE = /[\t\n\v\f\r\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/

/**
 * `core/document/normalize.ts` 의 규칙을 **글자 하나씩** 적용한다.
 *
 * 한 번에 정규화하면 원문의 어느 자리가 정규화된 글의 어디로 갔는지 알 수 없다. 수식과 줄 나눔은
 * 둘 다 "원문의 이 자리" 로 오므로 그 대응이 필요하다. 끝의 공백은 마지막에 한 번 떼어 낸다.
 */
class Normalizer {
  private text = ''
  get length(): number { return this.text.length }
  append(chunk: string): void {
    for (const char of chunk.normalize('NFC')) {
      if (INVISIBLE.test(char)) continue
      const space = WHITESPACE.test(char) || char === ' '
      // 연속 공백은 하나로, 앞의 공백은 버린다 (정규화와 같은 규칙).
      if (space) { if (this.text !== '' && !this.text.endsWith(' ')) this.text += ' '; continue }
      this.text += char
    }
  }
  get value(): string { return this.text.trimEnd() }
}

interface ParagraphInline {
  equations: PreviewEquation[]
  /** 한글이 줄을 새로 시작한 자리 (정규화된 글에서의 위치). 믿을 수 없으면 빈 배열 */
  lines: number[]
}

/**
 * 문단의 수식과 **한글이 계산해 둔 줄 나눔**을 읽는다.
 *
 * 한글은 저장할 때 자기가 조판한 결과를 `<hp:linesegarray>` 에 넣어 둔다. 그 `textpos` 로 글을
 * 자르면 **한글이 나눈 그대로** 줄이 나온다 — 우리가 줄 나눔을 다시 계산할 필요가 없다.
 *
 * 읽기 파서(`reader.ts`)가 중첩 문단을 **별도 문단**으로 기록하므로 여기서도 중첩에서 멈춘다.
 * 멈추지 않으면 글상자·각주 안 수식이 부모 문단에 겹쳐 들어가고 뒤 수식의 위치도 밀린다.
 */
function readInline(paragraph: XmlNode): ParagraphInline {
  const equations: PreviewEquation[] = []
  const norm = new Normalizer()
  /** 흐름의 칸마다 그 자리가 정규화된 글의 어디인지. `textpos` 를 우리 좌표로 옮기는 표다. */
  const offsetAt: number[] = []
  let raw = ''

  function mark(units: number): void {
    for (let i = 0; i < units; i += 1) offsetAt.push(norm.length)
  }

  function walk(node: XmlNode): void {
    for (const child of node.children) {
      if (NESTED_PARAGRAPH.has(child.name)) { mark(OBJECT_UNITS); continue }
      if (child.name === 'linesegarray') continue
      if (child.name === TEXT_NODE) {
        for (const char of child.text) { mark(1); norm.append(char); raw += char }
        continue
      }
      if (CHAR_CONTROLS.has(child.name)) { mark(1); norm.append(' '); raw += ' '; continue }
      if (INLINE_OBJECTS.has(child.name)) {
        mark(OBJECT_UNITS)
        if (child.name === 'equation') {
          const script = normalizeText(descendants(child, 'script').map(textOf).join(' '))
          if (script.length > 0) {
            equations.push({ script, offset: norm.length, nodes: parseHwpEquation(script) })
          }
        }
        continue
      }
      walk(child)
    }
  }
  walk(paragraph)

  const text = norm.value
  const clamp = (offset: number): number => Math.min(offset, text.length)
  // 한 글자씩 정규화한 결과가 한 번에 정규화한 것과 다르면 대응표를 믿을 수 없다.
  const trusted = text === normalizeText(raw)
  const segments = paragraph.children.find(child => child.name === 'linesegarray')
  const lines = !trusted || segments === undefined ? [] : segments.children
    .filter(seg => seg.name === 'lineseg')
    .map(seg => Number(seg.attrs['textpos']))
    // 흐름 밖을 가리키면(우리가 세지 못한 개체가 있다) 그 문단의 줄 나눔은 쓰지 않는다.
    .map(position => Number.isInteger(position) && position >= 0 && position <= offsetAt.length
      ? clamp(offsetAt[position] ?? text.length) : -1)

  return {
    equations: equations.map(item => ({ ...item, offset: clamp(item.offset) })),
    lines: lines.includes(-1) ? [] : [...new Set(lines)].filter(at => at > 0 && at < text.length),
  }
}

export function readHwpxPreview(
  bytes: Uint8Array,
  paragraphs: readonly { uuid: string }[],
  versionOrdinal: number,
): DocumentPreview {
  const files = unzipSync(bytes)
  const decoder = new TextDecoder()
  const xml = (name: string): string => decoder.decode(files[name] ?? new Uint8Array())
  if (xml('mimetype').trim() !== 'application/hwp+zip') throw new Error('HWPX 형식이 아닙니다.')
  const header = parseXml(xml('Contents/header.xml'))
  const charStyles = new Map(descendants(header, 'charPr').map(n => [n.attrs['id'], n]))
  const paraStyles = new Map(descendants(header, 'paraPr').map(n => [n.attrs['id'], n]))
  const borderFills = readBorderFills(header)
  // 글꼴 이름은 언어별 목록에 있고, charPr 의 fontRef 가 그 번호를 가리킨다.
  const fontFaces = new Map(descendants(header, 'fontface')
    .filter(face => face.attrs['lang'] === 'HANGUL')
    .flatMap(face => descendants(face, 'font')
      .flatMap(font => {
        const name = fontName(font.attrs['face'])
        return name === null ? [] : [[font.attrs['id'] ?? '', name] as const]
      })))
  const manifest = parseXml(xml('Contents/content.hpf'))
  const images: DocumentPreview['images'] = []
  const imageIds = new Map<string, string>()
  // ZIP 내부 항목만 읽는다. 지원하지 않는 벡터·외부 그림은 자리 안내로 남긴다.
  for (const item of descendants(manifest, 'item')) {
    const href = item.attrs['href'] ?? ''
    const data = files[href]
    if (!href.startsWith('BinData/') || data === undefined) continue
    let mimeType: DocumentPreview['images'][number]['mimeType'] | null = null
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) mimeType = 'image/png'
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) mimeType = 'image/jpeg'
    if (decoder.decode(data.slice(0, 3)) === 'GIF') mimeType = 'image/gif'
    if (mimeType === null) continue
    const imageId = `image-${images.length}`
    imageIds.set(item.attrs['id'] ?? '', imageId)
    images.push({ imageId, mimeType, bytes: data })
  }
  let paths = parseSectionOrder(xml('Contents/content.hpf'))
  if (paths.length === 0) paths = Object.keys(files).filter(p => /^Contents\/section\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  const sections = paths.map(path => parseXml(xml(path)))
  // 기존 읽기 파서와 같은 닫는 태그 순서로 기록된 문단 UUID 를 연결한다.
  const ids = new Map<XmlNode, string>()
  let index = 0
  function identify(node: XmlNode): void {
    for (const child of node.children) identify(child)
    if (node.name === 'p') {
      const paragraph = paragraphs[index++]
      if (paragraph === undefined) throw new Error('미리보기 문단과 기록된 버전이 다릅니다.')
      ids.set(node, paragraph.uuid)
    }
  }
  sections.forEach(identify)
  if (index !== paragraphs.length) throw new Error('미리보기 문단 수가 기록과 다릅니다.')
  let tableIndex = 0
  function walk(node: XmlNode): PreviewBlock[] {
    if (node.name === 'p') {
      const paraPr = paraStyles.get(node.attrs['paraPrIDRef'])
      const align = paraPr === undefined ? '' : descendants(paraPr, 'align')[0]?.attrs['horizontal']
      const margin = paraPr === undefined ? undefined : descendants(paraPr, 'margin')[0]
      const spacing = paraPr === undefined ? undefined : descendants(paraPr, 'lineSpacing')[0]
      const percent = spacing?.attrs['type'] === 'PERCENT' ? Number(spacing.attrs['value']) : NaN
      const run = node.children.find(n => n.name === 'run')
      const charPr = charStyles.get(run?.attrs['charPrIDRef'])
      const fontId = charPr === undefined ? undefined : descendants(charPr, 'fontRef')[0]?.attrs['hangul']
      const inline = readInline(node)
      const paragraph: PreviewParagraph = {
        kind: 'paragraph', paragraphId: ids.get(node)!,
        align: align === 'CENTER' ? 'center' : align === 'RIGHT' ? 'right' : align === 'JUSTIFY' ? 'justify' : 'left',
        fontSize: Math.min(48, Math.max(10, size(charPr?.attrs['height']) || 13)),
        bold: charPr !== undefined && descendants(charPr, 'bold').length > 0,
        italic: charPr !== undefined && descendants(charPr, 'italic').length > 0,
        // 밑줄·취소선은 태그가 있어도 종류가 NONE 이면 그리지 않는다.
        underline: charPr !== undefined
          && descendants(charPr, 'underline').some(n => borderStyle(n.attrs['type']) !== 'none'),
        strike: charPr !== undefined
          && descendants(charPr, 'strikeout').some(n => borderStyle(n.attrs['shape']) !== 'none'),
        color: charPr === undefined ? null
          : charPr.attrs['textColor'] === '#000000' ? null : color(charPr.attrs['textColor']),
        fontFamily: fontId === undefined ? null : (fontFaces.get(fontId) ?? null),
        lineHeight: Number.isFinite(percent) && percent >= 50 && percent <= 300 ? percent / 100 : 1.6,
        indent: offsetSize(margin?.children.find(n => n.name === 'intent')?.attrs['value']),
        marginLeft: offsetSize(margin?.children.find(n => n.name === 'left')?.attrs['value']),
        marginRight: offsetSize(margin?.children.find(n => n.name === 'right')?.attrs['value']),
        spaceBefore: offsetSize(margin?.children.find(n => n.name === 'prev')?.attrs['value']),
        spaceAfter: offsetSize(margin?.children.find(n => n.name === 'next')?.attrs['value']),
        equations: inline.equations,
        lines: inline.lines,
        children: node.children.flatMap(walk),
      }
      return [paragraph]
    }
    if (node.name === 'tbl') {
      const id = tableIndex++
      const outer = borderFills.get(node.attrs['borderFillIDRef'] ?? '') ?? NO_FILL
      const horzAlign = node.children.find(n => n.name === 'pos')?.attrs['horzAlign']
      // 칸 여백은 표가 정한 값이 기본이고, hasMargin 인 칸만 자기 값을 쓴다.
      const tableInset = edges(node.children.find(n => n.name === 'inMargin'))
      const rows = node.children.filter(n => n.name === 'tr').map((row, r) =>
        row.children.filter(n => n.name === 'tc').map((cell, c): PreviewCell => {
          const addr = cell.children.find(n => n.name === 'cellAddr')?.attrs
          const span = cell.children.find(n => n.name === 'cellSpan')?.attrs
          const sz = cell.children.find(n => n.name === 'cellSz')?.attrs
          const align = cell.children.find(n => n.name === 'subList')?.attrs['vertAlign']
          const fill = borderFills.get(cell.attrs['borderFillIDRef'] ?? '') ?? NO_FILL
          const inset = cell.attrs['hasMargin'] === '1'
            ? edges(cell.children.find(n => n.name === 'cellMargin')) : tableInset
          return {
            row: integer(addr?.['rowAddr'], r), col: integer(addr?.['colAddr'], c),
            rowSpan: Math.max(1, integer(span?.['rowSpan'], 1)), colSpan: Math.max(1, integer(span?.['colSpan'], 1)),
            width: size(sz?.['width']), verticalAlign: align === 'CENTER' ? 'middle' : align === 'BOTTOM' ? 'bottom' : 'top',
            border: fill.border, background: fill.background, padding: inset,
            children: cell.children.flatMap(walk),
          }
        }))
      const table: PreviewTable = {
        kind: 'table', tableIndex: id,
        width: size(node.children.find(n => n.name === 'sz')?.attrs['width']),
        align: horzAlign === 'CENTER' ? 'center' : horzAlign === 'RIGHT' ? 'right' : 'left',
        border: outer.border,
        margin: edges(node.children.find(n => n.name === 'outMargin')),
        rows,
      }
      // 표 설명(caption)의 문단은 행 바깥에 있으므로 따로 보존한다.
      return [table, ...node.children.filter(n => n.name !== 'tr').flatMap(walk)]
    }
    if (node.name === 'pic') {
      const ref = descendants(node, 'img')[0]?.attrs['binaryItemIDRef'] ?? ''
      const sz = node.children.find(n => n.name === 'sz')?.attrs
      return [{ kind: 'image', imageId: imageIds.get(ref) ?? null, width: size(sz?.['width']), height: size(sz?.['height']) }]
    }
    return node.children.flatMap(walk)
  }
  const page = sections[0] === undefined ? A4 : readPage(sections[0])
  return { versionOrdinal, page, blocks: sections.flatMap(walk), images }
}
