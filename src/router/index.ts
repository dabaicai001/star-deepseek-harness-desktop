import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('@/components/layout/CyberLayout.vue'),
      children: [
        {
          path: '',
          name: 'home',
          component: () => import('@/views/HomeView.vue')
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
