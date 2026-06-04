import { createI18n } from 'vue-i18n'

const messages = {
  'zh-CN': {
    common: {
      noData: '暂无数据'
    },
    home: {
      welcome: '欢迎使用 StarHub',
      subtitle: 'All-in-One 开发运维桌面中枢',
      hint: '从左侧资产树选择连接开始'
    },
    asset: {
      title: '资产树',
      noConnection: '暂无连接',
      addHint: '请先添加数据库或 SSH 连接'
    },
    settings: {
      title: '设置',
      appearance: '外观',
      theme: '主题',
      language: '语言'
    }
  },
  'en-US': {
    common: {
      noData: 'No data'
    },
    home: {
      welcome: 'Welcome to StarHub',
      subtitle: 'All-in-One DevOps Desktop Hub',
      hint: 'Select a connection from the asset tree to get started'
    },
    asset: {
      title: 'Asset Tree',
      noConnection: 'No connections',
      addHint: 'Please add a database or SSH connection first'
    },
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
