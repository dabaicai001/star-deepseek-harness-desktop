import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import vuetify from './plugins/vuetify'

// 启动时清理 v0.x 的旧 localStorage 数据:
// v0.x 的 app store 持久化 key 是 `app`,且 tab 模型里 tab.id === assetId
// v0.3+ 改成 `app-v2`,tab.id 改成 instanceId,旧数据格式不兼容,直接清掉
// 避免旧 tab 路由到 ssh/${assetId} 但 tab.id 是新格式而找不到资产
const LEGACY_PERSIST_KEYS = [
  'app',              // 旧 app store
  'app-assets',       // 旧 asset store(若以后也加版本号,这里提前加)
]
try {
  for (const k of LEGACY_PERSIST_KEYS) {
    if (localStorage.getItem(k) !== null) {
      localStorage.removeItem(k)
    }
  }
} catch {
  // 隐私模式或 localStorage 不可用,静默
}

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app.use(pinia)
app.use(router)
app.use(i18n)
app.use(vuetify)
app.mount('#app')

// 全局抑制浏览器/系统的默认右键菜单
// Tauri 桌面壳里浏览器的"返回/刷新/打印/检查"毫无意义,
// 各业务区域需要时自己挂 @contextmenu 并用 <ContextMenu> 弹自定义菜单
document.addEventListener('contextmenu', (e) => e.preventDefault())
