import { describe, expect, it } from 'vitest'

import { isEmptyText, normalizeText } from '../src/core/document/normalize.js'

describe('문단 텍스트 정규화', () => {
  it('앞뒤 공백을 없애고 연속 공백을 하나로 만든다', () => {
    expect(normalizeText('  실험   결과를  정리했다  ')).toBe('실험 결과를 정리했다')
  })

  it('탭·줄바꿈·전각 공백·NBSP 를 모두 보통 공백으로 본다', () => {
    expect(normalizeText('실험\t결과')).toBe('실험 결과')
    expect(normalizeText('실험\n결과')).toBe('실험 결과')
    expect(normalizeText('실험　결과')).toBe('실험 결과')
    expect(normalizeText('실험 결과')).toBe('실험 결과')
  })

  it('보이지 않는 문자를 지운다', () => {
    expect(normalizeText('실험​결과')).toBe('실험결과')
    expect(normalizeText('﻿실험')).toBe('실험')
  })

  it('한글 자모 조합형을 완성형으로 통일한다 (NFC)', () => {
    const decomposed = '실험'.normalize('NFD')
    expect(decomposed).not.toBe('실험')
    expect(normalizeText(decomposed)).toBe('실험')
  })

  it('전각 영숫자는 그대로 둔다 (표기 차이를 지우지 않는다)', () => {
    expect(normalizeText('ｍ')).toBe('ｍ')
    expect(normalizeText('ｍ')).not.toBe('m')
  })

  it('문장 부호와 대소문자는 건드리지 않는다', () => {
    expect(normalizeText('PV=nRT, 즉 P·V 이다.')).toBe('PV=nRT, 즉 P·V 이다.')
  })

  it('빈 문단을 알아본다', () => {
    expect(isEmptyText('   \t\n　 ')).toBe(true)
    expect(isEmptyText('내용')).toBe(false)
  })
})
