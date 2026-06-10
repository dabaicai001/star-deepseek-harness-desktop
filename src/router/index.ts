import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
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
          path: 'docker/:id',
          name: 'docker',
          component: () => import('@/views/DockerView.vue'),
          props: true,
        },
        {
          path: 'ai',
          name: 'ai',
          component: () => import('@/views/AiView.vue'),
        },
      ],
    },
  ],
})

export default router
