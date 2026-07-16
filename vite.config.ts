import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  root: 'src',
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
    outDir: '../dist',
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
  }
})
