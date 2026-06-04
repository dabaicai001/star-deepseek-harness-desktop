<script setup lang="ts">
import AssetTree from '@/components/asset/AssetTree.vue'
</script>

<template>
  <div class="home-view">
    <v-navigation-drawer width="280">
      <AssetTree />
    </v-navigation-drawer>
    <v-main>
      <v-container>
        <v-row>
          <v-col>
            <v-card>
              <v-card-title>欢迎使用 StarHub</v-card-title>
              <v-card-text>
                <p>All-in-One 开发运维桌面中枢</p>
                <p>从左侧资产树选择连接开始</p>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </v-container>
    </v-main>
  </div>
</template>

<style scoped>
.home-view {
  display: flex;
  height: 100%;
}
</style>
