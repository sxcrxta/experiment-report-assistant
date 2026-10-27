/**
 * 문단 텍스트 정규화.
 *
 * 해시와 Diff 가 이 규칙 위에 서므로, 규칙을 바꾸면 기존 해시가 전부 달라진다.
 * 규칙을 고칠 때는 테스트를 함께 고치고 저장된 해시의 무효화를 고려한다.
 *
 * 정규화하는 것
 * - 유니코드 NFC (한글 자모 조합 형태를 하나로)
 * - 탭·줄바꿈·전각 공백(U+3000)·NBSP(U+00A0) 등 공백류를 보통 공백으로
 * - 연속 공백을 하나로, 앞뒤 공백 제거
 * - 보이지 않는 제어 문자 제거 (한글 문서에 섞여 들어오지만 내용이 아니다)
 *
 * 정규화하지 않는 것 (의도한 결정)
 * - 전각 영숫자를 반각으로 바꾸지 않는다. 단위나 기호(예: ｍ 과 m)가 실제로 다른 글자일 수 있고,
 *   사용자가 쓴 표기를 프로그램이 임의로 같다고 보면 표기 관련 피드백이 사라진다.
 * - 문장 부호와 대소문자는 건드리지 않는다.
 *
 * 정규식의 문자는 눈에 보이지 않으므로 모두 \u 이스케이프로 적는다.
 */

/** 공백으로 취급할 문자. 세로 탭·폼피드부터 전각 공백까지. */
const WHITESPACE =
  /[\t\n\v\f\r\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g

/**
 * 폭이 없거나 보이지 않는 문자. 내용이 아니므로 지운다.
 * 제어 문자를 일부러 대상으로 삼으므로 no-control-regex 를 끈다.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g

export function normalizeText(input: string): string {
  return input
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(WHITESPACE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** 정규화 결과가 비면 내용이 없는 문단이다. */
export function isEmptyText(input: string): boolean {
  return normalizeText(input).length === 0
}
