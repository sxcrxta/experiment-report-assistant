/**
 * 테스트용 HWPX 를 메모리에서 만든다.
 *
 * 실제 한글이 저장한 파일의 구조를 본떠서 만들되, 개인 문서를 저장소에 넣지 않기 위해
 * 필요한 부분만 합성한다. 실제 샘플로 하는 검증은 tests/fixtures 를 쓰는 별도 테스트가 맡는다.
 */
import { zipSync, strToU8 } from 'fflate'

export const NS =
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ' +
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"'

export function headerXml(styles: { id: string; name: string }[], extra = ''): string {
  const items = styles
    .map((s) => `<hh:style id="${s.id}" type="PARA" name="${s.name}" engName=""/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><hh:head ${NS}><hh:styles>${items}</hh:styles>${extra}</hh:head>`
}

export function contentHpf(sectionCount: number): string {
  const items = Array.from(
    { length: sectionCount },
    (_, i) => `<opf:item id="section${i}" href="Contents/section${i}.xml" media-type="application/xml"/>`,
  ).join('')
  const refs = Array.from(
    { length: sectionCount },
    (_, i) => `<opf:itemref idref="section${i}" linear="yes"/>`,
  ).join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<opf:package xmlns:opf="http://www.idpf.org/2007/opf/">' +
    `<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${items}</opf:manifest>` +
    `<opf:spine><opf:itemref idref="header" linear="yes"/>${refs}</opf:spine>` +
    '</opf:package>'
  )
}

export function sectionXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hs:sec ${NS}>${body}</hs:sec>`
}

/** 문단 하나. linesegarray 는 실제 파일처럼 붙여 둔다 (무시되어야 한다). */
export function para(text: string, styleIDRef = '0'): string {
  return (
    `<hp:p id="1" paraPrIDRef="0" styleIDRef="${styleIDRef}">` +
    `<hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run>` +
    '<hp:linesegarray><hp:lineseg textpos="0" text="무시되어야 하는 값"/></hp:linesegarray>' +
    '</hp:p>'
  )
}

/** 수식이 들어간 문단. */
export function paraWithEquation(text: string, script: string, styleIDRef = '0'): string {
  return (
    `<hp:p id="2" paraPrIDRef="0" styleIDRef="${styleIDRef}">` +
    `<hp:run charPrIDRef="0"><hp:t>${text}</hp:t>` +
    `<hp:equation><hp:script>${script}</hp:script></hp:equation>` +
    '</hp:run></hp:p>'
  )
}

/** 표. 셀마다 문단이 중첩된다. */
export function table(rows: string[][], styleIDRef = '0'): string {
  const trs = rows
    .map((cells, rowIndex) => {
      const tcs = cells
        .map(
          (cell, colIndex) =>
            '<hp:tc>' +
            `<hp:cellAddr colAddr="${colIndex}" rowAddr="${rowIndex}"/>` +
            `<hp:subList>${para(cell, styleIDRef)}</hp:subList>` +
            '</hp:tc>',
        )
        .join('')
      return `<hp:tr>${tcs}</hp:tr>`
    })
    .join('')
  return (
    '<hp:p id="3" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">' +
    `<hp:tbl rowCnt="${rows.length}">${trs}</hp:tbl>` +
    '</hp:run></hp:p>'
  )
}

export interface MakeOptions {
  sections: string[]
  styles?: { id: string; name: string }[]
  mimetype?: string
  omitContentHpf?: boolean
  /** `header.xml` 에 그대로 넣을 XML (charPr·paraPr·borderFill 정의를 넣을 때 쓴다). */
  headerExtra?: string
}

export function makeHwpx({
  sections,
  styles = [
    { id: '0', name: '바탕글' },
    { id: '2', name: '개요 1' },
    { id: '22', name: '캡션' },
  ],
  mimetype = 'application/hwp+zip',
  omitContentHpf = false,
  headerExtra = '',
}: MakeOptions): Uint8Array {
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8(mimetype),
    'Contents/header.xml': strToU8(headerXml(styles, headerExtra)),
  }
  if (!omitContentHpf) files['Contents/content.hpf'] = strToU8(contentHpf(sections.length))
  sections.forEach((body, i) => {
    files[`Contents/section${i}.xml`] = strToU8(sectionXml(body))
  })
  return zipSync(files)
}
