<script setup lang="ts">
</script>

<template>
  <v-list>
    <v-list-subheader>资产树</v-list-subheader>
    <v-list-item disabled>
      <template v-slot:prepend>
        <v-icon>mdi-information-outline</v-icon>
      </template>
      <v-list-item-title>暂无连接</v-list-item-title>
      <v-list-item-subtitle>请先添加数据库或 SSH 连接</v-list-item-subtitle>
    </v-list-item>
  </v-list>
</template>
