<script setup lang="ts">
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
</script>

<template>
  <v-tabs
    v-model="appStore.activeTab"
    show-arrows
    density="compact"
    class="tab-bar"
  >
    <v-tab
      v-for="tab in appStore.tabs"
      :key="tab.id"
      :value="tab.id"
      @click="appStore.setActiveTab(tab.id)"
    >
      <v-icon size="small" class="mr-1">
        {{ tab.type === 'ssh' ? 'mdi-console' : tab.type === 'db' ? 'mdi-database' : 'mdi-docker' }}
      </v-icon>
      {{ tab.title }}
      <v-btn
        icon
        size="x-small"
        variant="text"
        @click.stop="appStore.removeTab(tab.id)"
      >
        <v-icon size="small">mdi-close</v-icon>
      </v-btn>
    </v-tab>
  </v-tabs>
</template>

<style scoped>
.tab-bar {
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
}
</style>
