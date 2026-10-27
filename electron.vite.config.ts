import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // 네이티브 모듈은 번들에 넣지 않고 런타임에 require 한다.
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {},
  renderer: {},
})
