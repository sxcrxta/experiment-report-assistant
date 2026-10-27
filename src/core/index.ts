/**
 * 코어 — 순수·결정론 계층.
 *
 * CLAUDE.md §2: 문단 해시, 문단 UUID 추적, Myers Diff, 캐시 판정,
 * 우선순위 점수 계산과 Top-K 선별, 통계 집계는 모두 여기에 산다.
 *
 * 규칙:
 * - 부작용이 없다. 파일·네트워크·시간·난수는 인자로 주입받는다.
 * - Node 내장 모듈과 electron 을 import 하지 않는다 (tools/boundaries.ts 가 강제).
 *
 * 실제 모듈은 IMPLEMENTATION_PLAN.md 1단계부터 채운다.
 */
export {}
