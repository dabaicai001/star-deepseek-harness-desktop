<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import AssetTree from '@/components/asset/AssetTree.vue'

const { t } = useI18n()
const router = useRouter()
const assetStore = useAssetStore()
</script>

<template>
  <v-navigation-drawer permanent width="280">
    <template v-slot:prepend>
      <v-list-item
        lines="two"
        prepend-icon="mdi-hub"
        :title="t('common.app')"
        subtitle="All-in-One DevOps Hub"
      />
    </template>

    <v-divider />

    <v-list density="compact" nav>
      <v-list-item
        prepend-icon="mdi-home"
        :title="t('common.home')"
        to="/"
      />
      <v-list-item
        prepend-icon="mdi-cog"
        :title="t('settings.title')"
        to="/settings"
      />
    </v-list>

    <v-divider />

    <v-list density="compact" nav>
      <v-list-subheader>{{ t('asset.title') }}</v-list-subheader>
      <v-list-item>
        <template v-slot:prepend>
          <v-icon>mdi-magnify</v-icon>
        </template>
        <v-text-field
          v-model="assetStore.searchQuery"
          :placeholder="t('common.search')"
          density="compact"
          variant="plain"
          hide-details
        />
      </v-list-item>
    </v-list>

    <AssetTree />

    <template v-slot:append>
      <div class="pa-2">
        <v-btn
          block
          color="primary"
          prepend-icon="mdi-plus"
          @click="() => {}"
        >
          {{ t('asset.create') }}
        </v-btn>
      </div>
    </template>
  </v-navigation-drawer>
</template>
