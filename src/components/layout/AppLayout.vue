<script setup lang="ts">
import Sidebar from './Sidebar.vue'
import TabBar from './TabBar.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
</script>

<template>
  <v-layout>
    <Sidebar />
    <v-main>
      <TabBar v-if="appStore.tabs.length > 0" />
      <router-view />
    </v-main>
  </v-layout>
</template>
