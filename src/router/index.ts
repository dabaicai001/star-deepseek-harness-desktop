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
          // embed 入口 URL 是 /starhub/index.html?embed=1&route=...(host-static 托管):
          // history base 剥离 /starhub/ 后路径为 /index.html,无匹配则整树不挂载
          // (embed iframe 白屏,P3b 探针实测发现)。匹配后由 CyberLayout embed
          // 分支读 query.route 并 replace 到目标功能路由。
          path: 'index.html',
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
          path: 'web/:id',
          name: 'web-browser',
          component: () => import('@/views/WebBrowserView.vue'),
          props: true,
        },
        // ===== embed 段路由(无资产 id,dsh 壳 iframe 专用,P3 主壳融合)=====
        // client-nav 导航条目指向这些段路由(如 /ssh);embed 守卫在 CyberLayout
        // 里把「有资产」的段重定向到带 instanceId 的功能路由,「无资产」的段
        // 停在空态页。旧外壳从不导航到这些路径,静态段路由优先于 :id 参数路由。
        ...([
          ['ssh', 'terminal'],
          ['db/mysql', 'database'],
          ['db/redis', 'redis'],
          ['db/elasticsearch', 'elasticsearch'],
          ['db/clickhouse', 'clickhouse'],
          ['db/postgresql', 'postgresql'],
          ['docker', 'docker'],
          ['broker', 'broker'],
          ['excel', 'excel'],
        ] as const).map(([path, section]) => ({
          path,
          name: `embed-section-${section}`,
          component: () => import('@/components/common/EmbedSectionEmpty.vue'),
          meta: { embedSection: section },
        })),
      ],
    },
  ],
})

export default router
