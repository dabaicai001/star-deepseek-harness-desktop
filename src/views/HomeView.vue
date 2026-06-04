<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <v-container>
    <v-row>
      <v-col>
        <v-card>
          <v-card-title class="text-h4">
            {{ t('common.app') }}
          </v-card-title>
          <v-card-text>
            <p class="text-h6 mb-4">{{ t('home.subtitle') }}</p>
            <p>{{ t('home.hint') }}</p>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>
