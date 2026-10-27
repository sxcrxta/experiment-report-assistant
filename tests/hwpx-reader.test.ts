import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import { NotHwpxError, parseSectionOrder, parseStyles, readHwpx } from '../src/adapters/hwpx/index.js'

import { makeHwpx, para, paraWithEquation, table } from './helpers/make-hwpx.js'

const dir = mkdtempSync(join(tmpdir(), 'hwpx-test-'))

function writeSample(name: string, bytes: Uint8Array): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

describe('HWPX 부품 파싱', () => {
  it('header.xml 에서 스타일 이름표를 만든다', () => {
    const styles = parseStyles(
      '<hh:head xmlns:hh="x"><hh:style id="0" type="PARA" name="바탕글"/>' +
        '<hh:style id="2" type="PARA" name="개요 1"/></hh:head>',
    )
    expect(styles.get('0')).toBe('바탕글')
    expect(styles.get('2')).toBe('개요 1')
  })

  it('content.hpf 의 spine 순서로 섹션을 정한다', () => {
    const hpf =
      '<opf:package xmlns:opf="x"><opf:manifest>' +
      '<opf:item id="header" href="Contents/header.xml"/>' +
      '<opf:item id="s1" href="Contents/section1.xml"/>' +
      '<opf:item id="s0" href="Contents/section0.xml"/>' +
      '</opf:manifest><opf:spine>' +
      '<opf:itemref idref="header"/><opf:itemref idref="s0"/><opf:itemref idref="s1"/>' +
      '</opf:spine></opf:package>'
    expect(parseSectionOrder(hpf)).toEqual(['Contents/section0.xml', 'Contents/section1.xml'])
  })
})

describe('HWPX 읽기', () => {
  it('본문 문단을 순서대로 뽑는다', () => {
    const path = writeSample(
      'basic.hwpx',
      makeHwpx({ sections: [para('첫 문단') + para('둘째 문단')] }),
    )
    const doc = readHwpx(path)
    expect(doc.paragraphs.map((p) => p.text)).toEqual(['첫 문단', '둘째 문단'])
    expect(doc.paragraphs.map((p) => p.index)).toEqual([0, 1])
    expect(doc.sectionCount).toBe(1)
  })

  it('linesegarray 의 텍스트를 문단 내용으로 넣지 않는다', () => {
    const path = writeSample('lineseg.hwpx', makeHwpx({ sections: [para('본문만')] }))
    const doc = readHwpx(path)
    expect(doc.paragraphs[0]?.text).toBe('본문만')
    expect(doc.paragraphs[0]?.text).not.toContain('무시')
  })

  it('스타일 이름으로 제목·캡션·본문을 구분한다', () => {
    const path = writeSample(
      'roles.hwpx',
      makeHwpx({ sections: [para('실험 목적', '2') + para('설명', '0') + para('그림 1', '22')] }),
    )
    const [heading, body, caption] = readHwpx(path).paragraphs
    expect(heading).toMatchObject({ role: 'heading', headingLevel: 1, styleName: '개요 1' })
    expect(body).toMatchObject({ role: 'body', headingLevel: null })
    expect(caption).toMatchObject({ role: 'caption' })
  })

  it('표 안 문단을 위치와 함께 뽑는다', () => {
    const path = writeSample(
      'table.hwpx',
      makeHwpx({
        sections: [
          para('표 앞') +
            table([
              ['온도', '압력'],
              ['300', '101'],
            ]),
        ],
      }),
    )
    const doc = readHwpx(path)
    const cells = doc.paragraphs.filter((p) => p.table !== null)
    expect(cells.map((p) => p.text)).toEqual(['온도', '압력', '300', '101'])
    expect(cells[0]?.table).toEqual({ tableIndex: 0, row: 0, col: 0 })
    expect(cells[3]?.table).toEqual({ tableIndex: 0, row: 1, col: 1 })
    expect(doc.paragraphs.find((p) => p.text === '표 앞')?.table).toBeNull()
  })

  it('수식은 text 가 아니라 equations 로 들어가고 해시에 반영된다', () => {
    const withEq = writeSample(
      'eq.hwpx',
      makeHwpx({ sections: [paraWithEquation('식은 다음과 같다', 'PV=nRT')] }),
    )
    const changed = writeSample(
      'eq2.hwpx',
      makeHwpx({ sections: [paraWithEquation('식은 다음과 같다', 'PV=nRT+1')] }),
    )

    const a = readHwpx(withEq).paragraphs[0]
    const b = readHwpx(changed).paragraphs[0]

    expect(a?.text).toBe('식은 다음과 같다')
    expect(a?.equations).toEqual(['PV=nRT'])
    expect(a?.hash).not.toBe(b?.hash)
  })

  it('여러 섹션을 spine 순서로 이어 붙이고 번호를 계속 센다', () => {
    const path = writeSample(
      'multi.hwpx',
      makeHwpx({ sections: [para('섹션0 문단'), para('섹션1 문단')] }),
    )
    const doc = readHwpx(path)
    expect(doc.sectionCount).toBe(2)
    expect(doc.paragraphs.map((p) => [p.sectionIndex, p.index, p.text])).toEqual([
      [0, 0, '섹션0 문단'],
      [1, 1, '섹션1 문단'],
    ])
  })

  it('content.hpf 가 없으면 파일 이름 순서로 대신한다', () => {
    const path = writeSample(
      'nohpf.hwpx',
      makeHwpx({ sections: [para('첫째'), para('둘째')], omitContentHpf: true }),
    )
    expect(readHwpx(path).paragraphs.map((p) => p.text)).toEqual(['첫째', '둘째'])
  })

  it('목차에 선언한 섹션이 빠져 있으면 일부만 읽고 성공하지 않는다', () => {
    const files = unzipSync(makeHwpx({ sections: [para('첫째'), para('둘째')] }))
    delete files['Contents/section1.xml']
    const path = writeSample('missing-section.hwpx', zipSync(files))
    expect(() => readHwpx(path)).toThrow(NotHwpxError)
  })

  it('HWPX 가 아니면 거절한다 (추측해서 처리하지 않는다)', () => {
    const path = writeSample(
      'notHwpx.hwpx',
      makeHwpx({ sections: [para('x')], mimetype: 'application/zip' }),
    )
    expect(() => readHwpx(path)).toThrow(NotHwpxError)
  })

  it('같은 파일을 두 번 읽으면 완전히 같은 결과다 (재현 가능)', () => {
    const path = writeSample(
      'repeat.hwpx',
      makeHwpx({
        sections: [para('제목', '2') + para('본문') + table([['가', '나']])],
      }),
    )
    expect(readHwpx(path)).toEqual(readHwpx(path))
  })

  it('읽어도 파일이 변하지 않는다 (T-13)', () => {
    const path = writeSample('readonly.hwpx', makeHwpx({ sections: [para('내용')] }))
    const before = readFileSync(path)
    const beforeStat = statSync(path)

    readHwpx(path)
    readHwpx(path)

    expect(readFileSync(path).equals(before)).toBe(true)
    expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs)
  })
})
