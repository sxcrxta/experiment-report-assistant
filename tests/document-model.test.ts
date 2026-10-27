import { describe, expect, it } from 'vitest'

import { hasContent, roleFromStyleName, type Paragraph } from '../src/core/document/model.js'

function paragraph(overrides: Partial<Paragraph>): Paragraph {
  return {
    uuid: 'u',
    index: 0,
    sectionIndex: 0,
    role: 'body',
    headingLevel: null,
    styleName: '바탕글',
    table: null,
    rawText: '',
    text: '',
    equations: [],
    hash: 'h',
    ...overrides,
  }
}

describe('스타일 이름 -> 문단 역할', () => {
  it('개요 N 을 제목과 수준으로 읽는다', () => {
    expect(roleFromStyleName('개요 1')).toEqual({ role: 'heading', headingLevel: 1 })
    expect(roleFromStyleName('개요 10')).toEqual({ role: 'heading', headingLevel: 10 })
    expect(roleFromStyleName('Outline 3')).toEqual({ role: 'heading', headingLevel: 3 })
  })

  it('차례 제목과 타이들도 제목으로 본다', () => {
    expect(roleFromStyleName('차례 제목').role).toBe('heading')
    expect(roleFromStyleName('타이들').role).toBe('heading')
  })

  it('캡션과 본문을 구분한다', () => {
    expect(roleFromStyleName('캡션').role).toBe('caption')
    expect(roleFromStyleName('바탕글').role).toBe('body')
    expect(roleFromStyleName('본문').role).toBe('body')
  })

  it('모르는 스타일은 other 로 둔다 (제목이라고 단정하지 않는다)', () => {
    expect(roleFromStyleName('머리말').role).toBe('other')
    expect(roleFromStyleName(null)).toEqual({ role: 'other', headingLevel: null })
  })
})

describe('내용 있는 문단 판정 (선행 작성 확인의 기준)', () => {
  it('빈 문단은 내용이 없다', () => {
    expect(hasContent(paragraph({ text: '' }))).toBe(false)
  })

  it('텍스트가 있으면 내용이 있다', () => {
    expect(hasContent(paragraph({ text: '실험 결과' }))).toBe(true)
  })

  it('텍스트가 없어도 수식만 있으면 내용이 있다', () => {
    expect(hasContent(paragraph({ text: '', equations: ['PV=nRT'] }))).toBe(true)
  })
})
