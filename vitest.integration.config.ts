import { defineConfig } from 'vitest/config'

/**
 * 통합 테스트 전용 설정 (`npm run test:v1`).
 *
 * 실제 한컴오피스 한글로 저장해야 통과하므로 기본 `npm run check` 에서는 제외한다.
 * 사람이 손으로 돌리고 결과를 보고한다 (STAGE_TASKS 2단계).
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // 사람이 한글에서 저장할 때까지 기다린다.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
