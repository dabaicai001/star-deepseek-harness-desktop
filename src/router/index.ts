import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  // embed 构建的 BASE_URL 是 /starhub/(vite.config.ts 的 mode==='embed'),
  // 使 iframe 内 router.replace 出的 URL 仍落在 host-static 前缀下,可刷新;
  // 普通构建 BASE_URL='/',行为与 createWebHistory() 完全一致。
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/components/layout/CyberLayout.vue'),
      children: [
        {
          // 根路径:无匹配子路由时落到 CyberLayout 的欢迎页(tabs.length === 0)
          // 用一个空 div 占位即可 —— workspace 外的 v-if 已经处理"无 tab"的展示
          path: '',
          component: { template: '<div />' }
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('@/views/SettingsView.vue')
        },
        {
 path: 'ssh/:id',
 name: 'ssh-terminal',
 component: () => import('@/components/ssh/SshTerminal.vue'),
 props: true,
 },
 {
 path: 'db/mysql/:id',
          name: 'db-mysql',
          component: () => import('@/views/DbView.vue'),
          props: true,
        },
        {
          path: 'db/redis/:id',
          name: 'db-redis',
          component: () => import('@/views/RedisView.vue'),
          props: true,
        },
        {
          path: 'db/elasticsearch/:id',
          name: 'db-elasticsearch',
          component: () => import('@/views/ElasticsearchView.vue'),
          props: true,
        },
        {
          path: 'db/clickhouse/:id',
          name: 'db-clickhouse',
          component: () => import('@/views/DbView.vue'),
          props: true,
        },
        {
          path: 'db/postgresql/:id',
          name: 'db-postgresql',
          component: () => import('@/views/DbView.vue'),
          props: true,
        },
        {
          path: 'broker/:id',
          name: 'db-broker',
          component: () => import('@/views/BrokerView.vue'),
          props: true,
        },
        {
          path: 'docker/:id',
          name: 'docker',
          component: () => import('@/views/DockerView.vue'),
          props: true,
        },
        {
          path: 'excel/:id',
          name: 'excel',
          component: () => import('@/views/ExcelView.vue'),
          props: true,
        },
        {
          path: 'local/:id',
          name: 'local',
          component: () => import('@/views/LocalView.vue'),
          props: true,
        },
        {
          path: 'ai/:id?',
          name: 'ai',
          component: () => import('@/views/AiView.vue'),
          props: true,
        },
        {
          path: 'web/:id',
          name: 'web-browser',
          component: () => import('@/views/WebBrowserView.vue'),
          props: true,
        },
      ],
    },
  ],
})

export default router
