/**
 * 온라인 여부.
 *
 * PRD 5절: "인터넷이 연결되지 않으면 AI 검토 요청만 차단하고 그 사실을 표시한다."
 * 이 값을 보는 곳은 AI 검토 요청뿐이다. 문서 등록·저장 감지·버전 기록·지침 편집은 이 값을 모른다.
 *
 * 확인 방법은 인자로 받는다. 메인 프로세스는 Electron 의 `net.isOnline()` 을 넘긴다.
 * 그 값이 false 면 연결할 수 없다는 강한 신호지만, true 라고 연결이 보장되지는 않는다.
 * 실제 연결 실패는 모델 어댑터가 따로 알린다.
 */

export interface OnlineStatus {
  isOnline(): boolean
}

/**
 * @param probe 연결돼 있으면 true
 * @param warn 확인 자체가 실패했을 때 남길 곳. 그때는 오프라인으로 본다 (AI 요청만 막힌다)
 */
export function createOnlineStatus(
  probe: () => boolean,
  warn: (message: string) => void = (message) => console.warn(message),
): OnlineStatus {
  return {
    isOnline(): boolean {
      try {
        return probe()
      } catch (cause) {
        warn(`[net] 연결 상태를 확인하지 못해 오프라인으로 봅니다: ${cause instanceof Error ? cause.message : String(cause)}`)
        return false
      }
    },
  }
}
