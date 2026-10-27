import { createHash, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { paragraphHash, paragraphUuid } from '../src/core/document/hash.js'
import { sha256Hex, utf8Bytes } from '../src/core/document/sha256.js'

describe('SHA-256 (코어의 순수 구현)', () => {
  it('공개 시험 벡터와 일치한다', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('node:crypto 와 결과가 같다 (한국어·수식·이모지 포함)', () => {
    const inputs = [
      '',
      'a',
      '실험 결과 고찰',
      '이상 기체 상태 방정식 PV=nRT',
      'x'.repeat(55), // 패딩 경계 (55, 56, 63, 64)
      'x'.repeat(56),
      'x'.repeat(63),
      'x'.repeat(64),
      'x'.repeat(1000),
      '🧪⚗️ 실험',
    ]
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'))
    }
  })

  it('무작위 입력 200건에서도 node:crypto 와 같다', () => {
    for (let i = 0; i < 200; i += 1) {
      const input = randomBytes(1 + (i % 200)).toString('utf8')
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'))
    }
  })

  it('UTF-8 변환이 서러게이트 쌍을 올바르게 다룬다', () => {
    expect(Array.from(utf8Bytes('🧪'))).toEqual(Array.from(Buffer.from('🧪', 'utf8')))
  })
})

describe('문단 해시', () => {
  it('같은 내용이면 같은 해시다', () => {
    const input = { text: '결과를 정리하였다', equations: [] }
    expect(paragraphHash(input)).toBe(paragraphHash({ ...input }))
  })

  it('텍스트가 바뀌면 해시가 바뀐다', () => {
    expect(paragraphHash({ text: 'A', equations: [] })).not.toBe(
      paragraphHash({ text: 'B', equations: [] }),
    )
  })

  it('수식만 바뀌어도 해시가 바뀐다 (안 바뀜으로 보면 수정이 누락된다)', () => {
    const text = '식은 다음과 같다'
    expect(paragraphHash({ text, equations: ['PV=nRT'] })).not.toBe(
      paragraphHash({ text, equations: ['PV=nRT+1'] }),
    )
  })

  it('수식이 사라져도 해시가 바뀐다', () => {
    const text = '식은 다음과 같다'
    expect(paragraphHash({ text, equations: ['PV=nRT'] })).not.toBe(
      paragraphHash({ text, equations: [] }),
    )
  })

  it('텍스트와 수식의 경계가 뭉개지지 않는다', () => {
    // 구분자가 없으면 아래 두 입력이 같은 문자열로 이어져 같은 해시가 나올 수 있다.
    expect(paragraphHash({ text: 'AB', equations: [] })).not.toBe(
      paragraphHash({ text: 'A', equations: ['B'] }),
    )
  })
})

describe('문단 UUID', () => {
  const base = { sectionIndex: 0, index: 3, text: '실험 목적', equations: [] }

  it('같은 입력이면 같은 값이다', () => {
    expect(paragraphUuid(base)).toBe(paragraphUuid({ ...base }))
  })

  it('UUID 형식이다 (버전 5, RFC 4122 variant)', () => {
    expect(paragraphUuid(base)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('위치가 다르면 다른 값이다 (같은 문장이 여러 번 나와도 구분된다)', () => {
    expect(paragraphUuid(base)).not.toBe(paragraphUuid({ ...base, index: 4 }))
    expect(paragraphUuid(base)).not.toBe(paragraphUuid({ ...base, sectionIndex: 1 }))
  })
})
