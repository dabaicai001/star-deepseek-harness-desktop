<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CreateAssetDto } from '@/types/asset'

const { t } = useI18n()

const emit = defineEmits<{
  submit: [dto: CreateAssetDto]
  cancel: []
}>()

const name = ref('')
const host = ref('')
const port = ref(22)
const username = ref('')
const authType = ref<'password' | 'key'>('password')
const password = ref('')
const privateKey = ref('')

function onSubmit() {
  if (!name.value || !host.value || !username.value) return

  const dto: CreateAssetDto = {
    type: 'ssh',
    name: name.value,
    config: {
      host: host.value,
      port: port.value,
      username: username.value,
      password: authType.value === 'password' ? password.value : undefined,
      privateKey: authType.value === 'key' ? privateKey.value : undefined
    }
  }
  emit('submit', dto)
}
</script>

<template>
  <v-card>
    <v-card-title>{{ t('asset.create') }} - SSH</v-card-title>
    <v-card-text>
      <v-form @submit.prevent="onSubmit">
        <v-row>
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
            <v-btn-toggle v-model="authType" mandatory>
              <v-btn value="password">
                <v-icon class="mr-1">mdi-key</v-icon>
                {{ t('asset.password') }}
              </v-btn>
              <v-btn value="key">
                <v-icon class="mr-1">mdi-key-variant</v-icon>
                {{ t('asset.privateKey') }}
              </v-btn>
            </v-btn-toggle>
          </v-col>
          <v-col cols="12" v-if="authType === 'password'">
            <v-text-field
              v-model="password"
              :label="t('asset.password')"
              type="password"
            />
          </v-col>
          <v-col cols="12" v-else>
            <v-textarea
              v-model="privateKey"
              :label="t('asset.privateKey')"
              rows="4"
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
