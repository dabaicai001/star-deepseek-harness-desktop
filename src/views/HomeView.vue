<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import AssetTree from '@/components/asset/AssetTree.vue'

const { t } = useI18n()
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
              <v-card-title>{{ t('home.welcome') }}</v-card-title>
              <v-card-text>
                <p>{{ t('home.subtitle') }}</p>
                <p>{{ t('home.hint') }}</p>
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
