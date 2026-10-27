/**
 * 저장 감지 어댑터 (FSEvents 기반).
 *
 * PRD 5절: 한글 for Mac 이 저장한 HWPX 만 지원하며, 경로를 잃으면 그 사실을 표시하고
 * 사용자가 다시 선택한다.
 * CLAUDE.md §3: 추적은 **경로**를 기준으로 한다. inode 는 추적 근거가 아니다.
 *
 * 구현과 그 근거(V-1 관찰)는 `fsevents-watcher.ts` 에 있다.
 */

export type WatchEvent =
  /** 저장이 끝나고 파일을 온전히 읽을 수 있는 상태 */
  | { kind: 'saved'; path: string; byteSize: number }
  /** 경로가 사라졌다. 감시를 멈춘다. 임의의 다른 파일로 옮겨 붙지 않는다. */
  | { kind: 'path-lost'; path: string; reason: 'missing' | 'icloud-not-downloaded'; message: string }
  /** 기다렸는데도 온전한 HWPX 로 읽지 못했다. 조용히 삼키지 않고 사용자에게 알린다. */
  | { kind: 'unreadable'; path: string; message: string }

export interface FileWatcher {
  /**
   * 경로 하나를 감시한다.
   * @returns 감시를 멈추는 함수
   */
  watch(absolutePath: string, onEvent: (event: WatchEvent) => void): Promise<() => void>
}

export { createFileWatcher, WatchTargetError } from './fsevents-watcher.js'
export type { WatchOptions } from './fsevents-watcher.js'
export { classifyPath } from './path-status.js'
export type { PathStatus, PathStatusKind } from './path-status.js'
export { isHwpxFilename, sameFilename, toNfc, icloudPlaceholderName } from './filename.js'
