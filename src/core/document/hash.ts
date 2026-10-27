/**
 * 문단 해시와 문단 UUID.
 *
 * PRD 4.5: "저장 시 문단별 해시를 비교해 바뀌지 않은 문단은 분석하지 않는다."
 * 따라서 문단의 **의미 있는 변화가 전부** 해시에 들어가야 한다. 하나라도 빠지면
 * 사용자가 고친 부분을 프로그램이 보지 못하고 넘어간다.
 */
import { sha256Hex } from './sha256.js'

/** 입력을 이어 붙일 때 쓰는 구분자. 정규화된 텍스트에는 나타날 수 없는 제어 문자다. */
const SEP = '\u001F'

export interface ParagraphHashInput {
  /** 정규화된 텍스트 */
  text: string
  /** 수식 스크립트. 순서를 유지한다 */
  equations: readonly string[]
}

/**
 * 문단 해시.
 * 텍스트뿐 아니라 수식도 넣는다. 수식만 고친 문단을 "안 바뀜"으로 보면 안 되기 때문이다.
 */
export function paragraphHash({ text, equations }: ParagraphHashInput): string {
  return sha256Hex([text, ...equations].join(SEP))
}

export interface ParagraphUuidInput extends ParagraphHashInput {
  sectionIndex: number
  index: number
  /**
   * 같은 위치·같은 내용이라도 다른 값을 얻어야 할 때 쓰는 이름 공간 (예: 버전 식별자).
   *
   * 2단계 문단 추적이 **새로 생긴 문단**에 uuid 를 줄 때 쓴다. 이것이 없으면 예전에 지웠던
   * 문단과 같은 내용을 같은 자리에 다시 쓸 때 uuid 가 겹쳐 서로 다른 문단이 한 줄기로 보인다.
   * 넘기지 않으면 1단계와 완전히 같은 값이 나온다.
   */
  namespace?: string
}

/**
 * 문단 UUID.
 *
 * 같은 파일을 두 번 읽으면 같은 값이 나오도록 내용과 위치에서 유도한다.
 * 무작위 값을 쓰지 않는 이유는 1단계 완료 조건이 "두 번 읽으면 같은 결과"이기 때문이다.
 * 버전 사이에서 문단을 이어 붙이는 일은 2단계의 `core/diff/track.ts` 가 맡는다.
 */
export function paragraphUuid(input: ParagraphUuidInput): string {
  const parts = [String(input.sectionIndex), String(input.index), input.text, ...input.equations]
  if (input.namespace !== undefined) parts.unshift(input.namespace)
  const digest = sha256Hex(parts.join(SEP))
  // RFC 4122 형태로 잘라 쓴다. 버전 자리는 5(이름 기반), variant 자리는 RFC 4122 로 맞춘다.
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    '5' + digest.slice(13, 16),
    variant + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-')
}
