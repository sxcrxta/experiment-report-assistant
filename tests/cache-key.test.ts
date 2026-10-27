import { describe, expect, it } from 'vitest'

import { createCacheKey, type CacheKeyParts } from '../src/core/cache/key.js'

const base: CacheKeyParts = {
  documentId: 'doc-a',
  paragraphId: 'paragraph-id-a',
  paragraphHash: 'paragraph-a',
  rubricVersion: 'rubric-a',
  promptVersion: 'prompt-a',
  modelId: 'model-a',
  perspective: 'logic',
  stage: 'question',
  scope: 'paragraph',
  sentenceHash: null,
}

describe('검토 캐시 키', () => {
  it('같은 입력은 같은 키를 만들고, 필수 구성 요소 하나라도 달라지면 재사용하지 않는다 (T-19)', () => {
    expect(createCacheKey(base)).toBe(createCacheKey({ ...base }))

    for (const changed of [
      { paragraphHash: 'paragraph-b' },
      { rubricVersion: 'rubric-b' },
      { promptVersion: 'prompt-b' },
      { personalizationVersion: '["approved-v2"]' },
      { modelId: 'model-b' },
      { perspective: 'expression' as const },
      { stage: 'weak_hint' as const },
    ]) {
      expect(createCacheKey({ ...base, ...changed })).not.toBe(createCacheKey(base))
    }
  })

  it('문장과 문단 범위의 결과를 섞지 않는다', () => {
    expect(createCacheKey({ ...base, scope: 'sentence', sentenceHash: 'sentence-a' })).not.toBe(
      createCacheKey(base),
    )
  })

  it('빈 필수 값은 키를 만들지 않는다', () => {
    expect(() => createCacheKey({ ...base, promptVersion: '' })).toThrow('프롬프트 버전')
  })
})
