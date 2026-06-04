<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AssetType, CreateAssetDto } from '@/types/asset'

const { t } = useI18n()

const emit = defineEmits<{
  submit: [dto: CreateAssetDto]
  cancel: []
}>()

const assetType = ref<AssetType>('ssh')
const name = ref('')
const host = ref('')
const port = ref(22)
const username = ref('')
const password = ref('')

const portLabel = computed(() => {
  switch (assetType.value) {
    case 'ssh': return '22'
    case 'db': return '3306'
    case 'docker': return '2375'
    default: return ''
  }
})

function onSubmit() {
  const dto: CreateAssetDto = {
    type: assetType.value,
    name: name.value,
    config: {
      host: host.value,
      port: port.value,
      username: username.value,
      password: password.value
    }
  }
  emit('submit', dto)
}
</script>

<template>
  <v-card>
    <v-card-title>{{ t('asset.create') }}</v-card-title>
    <v-card-text>
      <v-form @submit.prevent="onSubmit">
        <v-row>
          <v-col cols="12">
            <v-btn-toggle v-model="assetType" mandatory>
              <v-btn value="ssh">
                <v-icon class="mr-1">mdi-console</v-icon>
                SSH
              </v-btn>
              <v-btn value="db">
                <v-icon class="mr-1">mdi-database</v-icon>
                {{ t('db.title') }}
              </v-btn>
              <v-btn value="docker">
                <v-icon class="mr-1">mdi-docker</v-icon>
                Docker
              </v-btn>
            </v-btn-toggle>
          </v-col>
          <v-col cols="12">
            <v-text-field
              v-model="name"
              :label="t('asset.name')"
              required
            />
          </v-col>
          <v-col cols="12" md="8">
            <v-text-field
              v-model="host"
              :label="t('asset.host')"
              required
            />
          </v-col>
          <v-col cols="12" md="4">
            <v-text-field
              v-model.number="port"
              :label="t('asset.port')"
              type="number"
              :placeholder="portLabel"
            />
          </v-col>
          <v-col cols="12">
            <v-text-field
              v-model="username"
              :label="t('asset.username')"
              required
            />
          </v-col>
          <v-col cols="12">
            <v-text-field
              v-model="password"
              :label="t('asset.password')"
              type="password"
            />
          </v-col>
        </v-row>
      </v-form>
    </v-card-text>
    <v-card-actions>
      <v-spacer />
      <v-btn @click="emit('cancel')">
        {{ t('common.cancel') }}
      </v-btn>
      <v-btn color="primary" @click="onSubmit">
        {{ t('common.save') }}
      </v-btn>
    </v-card-actions>
  </v-card>
</template>
