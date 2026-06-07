/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// 允许从 package.json 导入 version
declare module '~package.json' {
  export const version: string
  export const name: string
}
