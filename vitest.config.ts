import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // 통합 테스트는 실제 한글 저장이 필요하다. 따로 돌린다 (`npm run test:v1`).
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'tests/integration/**'],
    environment: 'node',
    restoreMocks: true,
    // 파일 감시 테스트는 실제 파일 조작과 디바운스를 기다린다.
    testTimeout: 20_000,
  },
})
