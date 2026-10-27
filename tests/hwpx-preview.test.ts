import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { readHwpxPreview } from '../src/adapters/hwpx/preview.js'
import { parseSection, readHwpx } from '../src/adapters/hwpx/reader.js'
import { openDatabase } from '../src/adapters/repo/index.js'
import { createDocumentRepository } from '../src/adapters/repo/documents.js'
import { createPreviewHandler } from '../src/main/preview-ipc.js'
import type { PreviewBlock } from '../src/shared/document-preview.js'
import { makeHwpx, para, sectionXml, table } from './helpers/make-hwpx.js'

function flatten(blocks: readonly PreviewBlock[]): PreviewBlock[] {
  return blocks.flatMap(block => [block, ...flatten(block.kind === 'table'
    ? block.rows.flatMap(row => row.flatMap(cell => cell.children)) : block.kind === 'paragraph' ? block.children : [])])
}
afterEach(() => vi.unstubAllGlobals())

/**
 * 한글은 저장할 때 자기가 조판한 줄 나눔을 `<hp:linesegarray>` 에 넣어 둔다.
 * 그 자리에서 끊으면 우리가 줄 나눔을 다시 계산하지 않아도 원본과 같은 줄이 나온다.
 */
function withLineSegs(body: string, positions: number[]): string {
  const segs = positions
    .map(pos => `<hp:lineseg textpos="${pos}" vertpos="${pos * 16}" vertsize="1000" horzpos="0" horzsize="40932"/>`)
    .join('')
  // `para()` 가 실제 파일처럼 붙여 둔 자리표시 linesegarray 를 갈아 끼운다.
  return body.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/, '')
    .replace('</hp:p>', `<hp:linesegarray>${segs}</hp:linesegarray></hp:p>`)
}

it('본문 뒤에 있는 셀 주소·병합·너비를 읽고 형제 표를 중첩시키지 않는다', () => {
  const body = table([['첫 칸', '둘째 칸']]).replace(
    '<hp:cellAddr colAddr="0" rowAddr="0"/>', '',
  ).replace('</hp:subList>', '</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="2" rowSpan="3"/><hp:cellSz width="15000"/>') + table([['다음 표']])
  const paragraphs = parseSection(sectionXml(body), { sectionIndex: 0, startIndex: 0, startTableIndex: 0, styles: new Map() }).paragraphs
  const preview = readHwpxPreview(makeHwpx({ sections: [body] }), paragraphs, 1)
  const tables = flatten(preview.blocks).filter(b => b.kind === 'table')
  expect(tables).toHaveLength(2)
  expect(tables[0]?.rows[0]?.[0]).toMatchObject({ row: 0, col: 0, colSpan: 2, rowSpan: 3, width: 200 })
  expect(preview.blocks).toHaveLength(2)
  const ids = flatten(preview.blocks).flatMap(b => b.kind === 'paragraph' ? [b.paragraphId] : [])
  expect(new Set(ids)).toEqual(new Set(paragraphs.map(p => p.uuid)))
})

it('지원되는 ZIP 내부 그림만 바이트로 전달하고 외부 그림은 열지 않는다', () => {
  const body = para('그림').replace('</hp:run>', '<hp:pic><hp:img binaryItemIDRef="safe"/><hp:sz width="7500" height="15000"/></hp:pic><hp:pic><hp:img binaryItemIDRef="remote"/></hp:pic></hp:run>')
  const files = unzipSync(makeHwpx({ sections: [body] }))
  files['Contents/content.hpf'] = strToU8(new TextDecoder().decode(files['Contents/content.hpf']).replace('</opf:manifest>', '<opf:item id="safe" href="BinData/a.png"/><opf:item id="remote" href="https://example.com/a.png"/></opf:manifest>'))
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  files['BinData/a.png'] = png
  const preview = readHwpxPreview(zipSync(files), [{ uuid: 'p' }], 1)
  expect(preview.images).toEqual([{ imageId: 'image-0', mimeType: 'image/png', bytes: png }])
  expect(flatten(preview.blocks).filter(b => b.kind === 'image')).toEqual([
    { kind: 'image', imageId: 'image-0', width: 100, height: 200 },
    { kind: 'image', imageId: null, width: 0, height: 0 },
  ])
  expect(JSON.stringify(preview)).not.toMatch(/https:|BinData|href/)
})

it('실제 HWPX 의 표·삽입 이미지·문단 연결을 모두 읽어도 원본은 변하지 않는다', async () => {
  const path = join(import.meta.dirname, 'fixtures/sample-full.hwpx')
  const before = readFileSync(path)
  const doc = readHwpx(path)
  const preview = readHwpxPreview(before, doc.paragraphs, 1)
  const blocks = flatten(preview.blocks)
  expect(blocks.filter(b => b.kind === 'table')).toHaveLength(9)
  expect(preview.images.length).toBeGreaterThan(0)
  expect(blocks.filter(b => b.kind === 'image').every(b => b.imageId !== null)).toBe(true)
  expect(blocks.filter(b => b.kind === 'paragraph')).toHaveLength(doc.paragraphs.length)
  const outer = blocks.find(b => b.kind === 'table')!
  expect(outer.rows[0]?.[0]?.colSpan).toBe(4)
  // 이 보고서는 수식이 100개 넘게 들어 있다. 하나도 빠뜨리지 않고 문단에 연결한다.
  const equations = blocks.flatMap(b => b.kind === 'paragraph' ? b.equations : [])
  expect(equations.length).toBeGreaterThan(100)
  expect(equations.every(e => e.script.length > 0 && e.offset >= 0)).toBe(true)
  // 표 중심 보고서이므로 실선 테두리와 색 채운 칸이 실제로 있어야 한다.
  const cells = blocks.flatMap(b => b.kind === 'table' ? b.rows.flat() : [])
  expect(cells.some(c => c.border.top.style === 'solid' || c.border.left.style === 'solid')).toBe(true)
  expect(cells.some(c => c.background !== null)).toBe(true)

  const { db } = openDatabase({ file: ':memory:', migrationsDir: join(import.meta.dirname, '../src/adapters/repo/migrations') })
  try {
    const repo = createDocumentRepository(db)
    repo.createDocument({ id: 'd', path, displayName: '보고서', createdAt: 'now', subject: null })
    repo.appendVersion({ id: 'v', documentId: 'd', detectedAt: 'now', sourcePath: path, byteSize: before.length,
      contentHash: createHash('sha256').update(before).digest('hex'), previousVersionId: null,
      paragraphs: doc.paragraphs.map(p => ({ uuid: p.uuid, paragraph: p })), lineage: [], diffEntries: [] })
    const result = await createPreviewHandler(repo)('d')
    expect(result.status).toBe('ok')
    expect(JSON.stringify(result)).not.toContain(path)
    repo.appendVersion({ id: 'v2', documentId: 'd', detectedAt: 'now', sourcePath: path, byteSize: 1,
      contentHash: '다른 저장', previousVersionId: 'v', paragraphs: [], lineage: [], diffEntries: [] })
    expect((await createPreviewHandler(repo)('d')).status).toBe('failed')
  } finally { db.close() }
  expect(readFileSync(path)).toEqual(before)
})

it('글상자 안 문단의 수식을 부모 문단이 삼키지 않는다', () => {
  const body = '<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">'
    + '<hp:t>본문 앞</hp:t>'
    + '<hp:rect><hp:drawText><hp:subList><hp:p id="9" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">'
    + '<hp:t>상자 안 </hp:t><hp:equation><hp:script>E=mc^2</hp:script></hp:equation>'
    + '</hp:run></hp:p></hp:subList></hp:drawText></hp:rect>'
    + '<hp:t> 본문 뒤 </hp:t><hp:equation><hp:script>F=ma</hp:script></hp:equation>'
    + '</hp:run></hp:p>'
  const parsed = parseSection(sectionXml(body), { sectionIndex: 0, startIndex: 0, startTableIndex: 0, styles: new Map() }).paragraphs
  const preview = readHwpxPreview(makeHwpx({ sections: [body] }), parsed, 1)
  const paragraphs = flatten(preview.blocks).filter(b => b.kind === 'paragraph')

  // 읽기 파서가 나눈 그대로: 상자 안 문단이 E=mc^2 를, 부모 문단이 F=ma 만 갖는다.
  const byId = new Map(paragraphs.map(b => [b.paragraphId, b.equations.map(e => e.script)]))
  for (const paragraph of parsed) expect(byId.get(paragraph.uuid)).toEqual(paragraph.equations)
  const outer = paragraphs.find(b => b.paragraphId === parsed.at(-1)!.uuid)!
  // 부모 글 "본문 앞 본문 뒤" 끝(9)에 놓인다. 상자 글 길이만큼 밀리지 않는다.
  expect(outer.equations.map(e => ({ script: e.script, offset: e.offset })))
    .toEqual([{ script: 'F=ma', offset: 9 }])
})

it('쪽 설정이 없으면 A4 기본값으로 그린다', () => {
  const body = para('쪽 설정 없음')
  const parsed = parseSection(sectionXml(body), { sectionIndex: 0, startIndex: 0, startTableIndex: 0, styles: new Map() }).paragraphs
  const preview = readHwpxPreview(makeHwpx({ sections: [body] }), parsed, 1)
  expect(preview.page).toEqual({ width: 794, marginTop: 76, marginRight: 113, marginBottom: 76, marginLeft: 113 })
})

it('수식은 글 흐름에서 여덟 칸을 차지한다 (그래야 뒤 줄이 제자리에 온다)', () => {
  // "앞" + 수식 + "뒤로가는글자들" — 수식이 8칸이므로 "뒤" 는 textpos 9 에서 시작한다.
  const body = withLineSegs(
    '<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">'
    + '<hp:t>앞</hp:t><hp:equation><hp:script>x</hp:script></hp:equation>'
    + '<hp:t>뒤로가는글자</hp:t></hp:run></hp:p>', [0, 9])
  const parsed = parseSection(sectionXml(body), { sectionIndex: 0, startIndex: 0, startTableIndex: 0, styles: new Map() }).paragraphs
  const preview = readHwpxPreview(makeHwpx({ sections: [body] }), parsed, 1)
  const paragraph = flatten(preview.blocks).find(b => b.kind === 'paragraph')!
  // 수식은 글자가 아니므로 정규화된 글에서는 "앞" 다음(1)이 두 번째 줄의 시작이다.
  expect(paragraph.equations.map(e => e.offset)).toEqual([1])
  expect(paragraph.lines).toEqual([1])
})

it('셀 수 없는 개체가 있으면 그 문단의 줄 나눔을 쓰지 않는다 (틀린 자리에서 끊지 않는다)', () => {
  // 흐름 길이(4칸)를 넘는 textpos 는 우리가 세지 못한 개체가 있다는 뜻이다.
  const body = withLineSegs(para('가나다라'), [0, 99])
  const parsed = parseSection(sectionXml(body), { sectionIndex: 0, startIndex: 0, startTableIndex: 0, styles: new Map() }).paragraphs
  const preview = readHwpxPreview(makeHwpx({ sections: [body] }), parsed, 1)
  expect(flatten(preview.blocks).find(b => b.kind === 'paragraph')!.lines).toEqual([])
})

it('실제 보고서의 줄 나눔을 한글이 나눈 그대로 되살린다', () => {
  const path = join(import.meta.dirname, 'fixtures/sample-full.hwpx')
  const doc = readHwpx(path)
  const preview = readHwpxPreview(readFileSync(path), doc.paragraphs, 1)
  const paragraphs = flatten(preview.blocks).filter(b => b.kind === 'paragraph')
  const text = new Map(doc.paragraphs.map(p => [p.uuid, p.text]))

  const withLines = paragraphs.filter(p => p.lines.length > 0)
  expect(withLines.length).toBeGreaterThan(100)
  for (const paragraph of paragraphs) {
    const body = text.get(paragraph.paragraphId) ?? ''
    // 줄 시작 자리는 늘 글 안이고 오름차순이며 겹치지 않는다.
    expect(paragraph.lines).toEqual([...paragraph.lines].sort((a, b) => a - b))
    expect(new Set(paragraph.lines).size).toBe(paragraph.lines.length)
    for (const at of paragraph.lines) expect(at).toBeGreaterThan(0)
    for (const at of paragraph.lines) expect(at).toBeLessThan(body.length)
  }
  // 이 보고서의 첫 줄은 한글에서 "…라이터 기체에 대하여 " 까지였다.
  const summary = paragraphs.find(p => (text.get(p.paragraphId) ?? '').startsWith('드라이아이스의 승화로'))!
  const body = text.get(summary.paragraphId)!
  expect(body.slice(0, summary.lines[0])).toBe(
    '드라이아이스의 승화로 얻은 이산화탄소와 수상치환으로 포집한 라이터 기체에 대하여 ')
})
