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
 // SFTP独立路由:不再内嵌在 SshTerminal 右栏,
 // 用户从资产右键"打开 SFTP"直接进入,UI 上和 SSH终端完全平等。
 //底层仍复用 SSH 连接池(sftp subsystem挂在同一条连接上)。
 path: 'sftp/:id',
 name: 'sftp',
 component: () => import('@/components/sftp/SftpView.vue'),
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
