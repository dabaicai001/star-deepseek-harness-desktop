<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useAssetStore } from '@/stores/asset'
import { useAppStore } from '@/stores/app'
import type { Asset } from '@/types/asset'

const { t } = useI18n()
const assetStore = useAssetStore()
const appStore = useAppStore()

function getIcon(type: string) {
  switch (type) {
    case 'ssh': return 'mdi-console'
    case 'db': return 'mdi-database'
    case 'docker': return 'mdi-docker'
    default: return 'mdi-file'
  }
}

function connectToAsset(asset: Asset) {
  appStore.addTab({
    id: asset.id,
    title: asset.name,
    type: asset.type
  })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
}
</script>

<template>
  <v-list density="compact" nav>
    <v-list-subheader v-if="assetStore.favoriteAssets.length > 0">
      <v-icon size="small" class="mr-1">mdi-star</v-icon>
      {{ t('asset.favorite') }}
    </v-list-subheader>
    <v-list-item
      v-for="asset in assetStore.favoriteAssets"
      :key="asset.id"
      :prepend-icon="getIcon(asset.type)"
      :title="asset.name"
      :subtitle="asset.config.host"
      @click="connectToAsset(asset)"
    >
      <template v-slot:append>
        <v-btn
          icon
          size="x-small"
          variant="text"
          @click.stop="assetStore.toggleFavorite(asset.id)"
        >
          <v-icon size="small" color="warning">mdi-star</v-icon>
        </v-btn>
      </template>
    </v-list-item>

    <v-divider v-if="assetStore.favoriteAssets.length > 0" class="my-2" />

    <v-list-subheader>
      <v-icon size="small" class="mr-1">mdi-folder</v-icon>
      {{ t('asset.title') }}
    </v-list-subheader>
    <v-list-item
      v-for="asset in assetStore.filteredAssets"
      :key="asset.id"
      :prepend-icon="getIcon(asset.type)"
      :title="asset.name"
      :subtitle="asset.config.host || asset.config.dbType"
      @click="connectToAsset(asset)"
    >
      <template v-slot:append>
        <v-btn
          icon
          size="x-small"
          variant="text"
          @click.stop="assetStore.toggleFavorite(asset.id)"
        >
          <v-icon size="small">
            {{ asset.favorite ? 'mdi-star' : 'mdi-star-outline' }}
          </v-icon>
        </v-btn>
      </template>
    </v-list-item>

    <v-list-item v-if="assetStore.assets.length === 0">
      <template v-slot:prepend>
        <v-icon>mdi-information</v-icon>
      </template>
      <v-list-item-title>{{ t('common.noData') }}</v-list-item-title>
    </v-list-item>
  </v-list>
</template>
