import { createI18n } from 'vue-i18n'

const messages = {
  'zh-CN': {
    settings: {
      title: '设置',
      appearance: '外观',
      theme: '主题',
      language: '语言'
    }
  },
  'en-US': {
    settings: {
      title: 'Settings',
      appearance: 'Appearance',
      theme: 'Theme',
      language: 'Language'
    }
  }
}

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages
})

export default i18n
