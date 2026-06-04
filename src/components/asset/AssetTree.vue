<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <v-list>
    <v-list-subheader>{{ t('asset.title') }}</v-list-subheader>
    <v-list-item disabled>
      <template v-slot:prepend>
        <v-icon>mdi-information-outline</v-icon>
      </template>
      <v-list-item-title>{{ t('asset.noConnection') }}</v-list-item-title>
      <v-list-item-subtitle>{{ t('asset.addHint') }}</v-list-item-subtitle>
    </v-list-item>
  </v-list>
</template>
