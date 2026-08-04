# 恢复库/表节点右键菜单 + 丰富标签页右键菜单 — 设计文档

日期:2026-08-04
状态:已获用户批准(树侧持有菜单 + 标签右键加四项)

## 背景与根因

v0.39(cba7587)对象树并入全局资产树后,库/表右键改为广播 `starhub:object-contextmenu`,由 DbView 挂载时监听。v0.40 起单击连接只展开树不开 tab → 事件无人接收 → 菜单不弹。Redis/ES 节点同构。Docker 容器/镜像节点从无监听方(本次不补,另议)。

菜单项代码从未丢失,仍在 DbView.vue(onDatabaseContextMenu:695 / onTableContextMenu:756)。

## 方案一:树侧持有对象菜单(用户已选)

- AssetTree 的 `onNodeCtx` 不再广播 contextmenu 事件,改为树侧直接构建并弹 ContextMenu:
  - 复制名称:树侧 clipboard 直接完成;
  - 其余动作:objectTree 新增 `pendingObjectAction` / `dispatchObjectAction`(仿 selectObject 双通道:pending 兜底 + `starhub:object-action` 事件)+ `openAssetTab` 拉起 tab;
  - DbView / RedisView / ElasticsearchView 监听 `starhub:object-action` 并在 onMounted 消费 pending,映射到各自现有函数;动作必须在连接就绪(connId 存在)后执行。
- 菜单项忠实恢复原清单:
  - database:复制名称 / 新建表 / 刷新表列表
  - table:复制名称 / 查看字段 / 查看 DDL / 查看索引 / 重命名表 / 清空表 / 删除表(danger)
  - Redis / ES:恢复各视图现有菜单项(原样照搬)
- 移除三个视图里旧的 `starhub:object-contextmenu` 监听与 AssetTree 的广播(单一路径,避免双弹)。

## 方案二:标签页右键菜单增强(用户已选四项)

CyberLayout.vue `tabCtxItems` 新增(仅 asset tab 显示后三项):
1. 关闭左侧标签(照抄 closeRightTabs 写法)
2. 重连该连接(复用 AssetTree reconnectToAsset 思路:关同资产 tab + openAssetTab 重开,通用无需各 view 加监听)
3. 断开连接(派 `starhub:tab-disconnect {assetId}`;DbView/RedisView/ElasticsearchView/DockerView 各自监听执行现有断开逻辑)
4. 刷新该连接资产树(objectTree 清 state 重新加载)

## 验证

`npm run build` + 7.3 真实布局回归:不开 tab 直接右键库/表出菜单;各菜单项动作生效;Redis/ES 节点右键;标签右键四项;无 console error。版本号递增修订版,七处同步,CHANGELOG 记录。
