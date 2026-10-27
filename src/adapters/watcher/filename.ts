/**
 * 파일 이름 다루기.
 *
 * V-1 관찰(`docs/V1-hwpx-저장동작.md` §2.4): macOS 는 파일 이름을 **NFD**(한글 자모가 분리된 형태)
 * 로 돌려준다. 소스에 적은 NFC 문자열과 눈으로는 같아 보여도 `===` 가 false 다.
 * 첫 관찰 시도가 실제로 이것 때문에 실패했다. 그래서 이름 비교는 **반드시 NFC 정규화 후에** 한다
 * (`CLAUDE.md` §3).
 *
 * 여기에는 파일 시스템 접근이 없다. 순수 문자열 함수만 둔다.
 */

/** 유니코드 NFC 로 맞춘다. 비교 전에 양쪽 모두에 적용한다. */
export function toNfc(value: string): string {
  return value.normalize('NFC')
}

/**
 * 두 파일 이름이 같은 파일을 가리키는가.
 * 한쪽이 NFD, 다른 쪽이 NFC 여도 같다고 본다. 대소문자는 구분한다.
 */
export function sameFilename(a: string, b: string): boolean {
  return toNfc(a) === toNfc(b)
}

/**
 * 지원 형식인가. PRD 5절: 한컴오피스 한글 for Mac 이 저장한 **HWPX 만** 지원한다.
 * 확장자만으로는 내용을 보장하지 못하므로, 실제 확인은 `checkHwpxIntact` 가 한 번 더 한다.
 */
export function isHwpxFilename(name: string): boolean {
  return toNfc(name).toLowerCase().endsWith('.hwpx')
}

/**
 * iCloud Drive 가 아직 내려받지 않은 파일의 자리표시자 이름.
 * `report.hwpx` 가 내려받히지 않았으면 같은 폴더에 `.report.hwpx.icloud` 가 있다.
 */
export function icloudPlaceholderName(name: string): string {
  return `.${toNfc(name)}.icloud`
}
