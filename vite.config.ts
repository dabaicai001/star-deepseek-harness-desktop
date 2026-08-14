/// <reference types="vitest" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [vue()],
  root: 'src',
  // embed 模式(dsh 壳 iframe 内嵌构建):资源走 /starhub/ 前缀,由 dsh 侧
  // host-static 插件托管(避免与 dsh 自身的 /assets/ 冲突);产物落 dist-embed/。
  base: mode === 'embed' ? '/starhub/' : '/',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '~package.json': resolve(__dirname, 'package.json')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true
  },
  build: {
    outDir: mode === 'embed' ? '../dist-embed' : '../dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'pinia', 'vue-router', 'vue-i18n'],
          vuetify: ['vuetify'],
          codemirror: [
            'codemirror',
            '@codemirror/autocomplete',
            '@codemirror/commands',
            '@codemirror/lang-sql',
            '@codemirror/state',
            '@codemirror/view'
          ],
          xterm: [
            '@xterm/xterm',
            '@xterm/addon-fit',
            '@xterm/addon-search',
            '@xterm/addon-web-links'
          ]
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    root: resolve(__dirname),
    include: ['tests/**/*.test.{ts,mts,js,mjs}'],
    exclude: ['tests/**/*.test.mjs', 'node_modules', 'dist'],
    passWithNoTests: true
  }
}))
