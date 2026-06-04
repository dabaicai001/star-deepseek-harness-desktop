<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import TerminalPane from './TerminalPane.vue'
import type { Asset } from '@/types/asset'

const { t } = useI18n()

const props = defineProps<{
  asset: Asset
}>()

const terminalRef = ref<InstanceType<typeof TerminalPane>>()
const connected = ref(false)
const connecting = ref(false)
let unlisten: (() => void) | null = null

onMounted(async () => {
  await connect()
})

onBeforeUnmount(async () => {
  await disconnect()
})

async function connect() {
  if (!props.asset.config.host || !props.asset.config.username) {
    terminalRef.value?.writeln('\x1b[31mError: Missing host or username\x1b[0m')
    return
  }

  connecting.value = true
  terminalRef.value?.writeln(`\x1b[33mConnecting to ${props.asset.config.host}...\x1b[0m`)

  try {
    const config = {
      host: props.asset.config.host,
      port: props.asset.config.port || 22,
      username: props.asset.config.username,
      auth: props.asset.config.password
        ? { Password: props.asset.config.password }
        : props.asset.config.privateKey
          ? { PrivateKey: { key: props.asset.config.privateKey, passphrase: props.asset.config.passphrase } }
          : { Password: '' }
    }

    await invoke('ssh_connect', { id: props.asset.id, config })
    connected.value = true
    terminalRef.value?.writeln('\x1b[32mConnected!\x1b[0m')

    unlisten = await listen(`ssh:data:${props.asset.id}`, (event) => {
      terminalRef.value?.write(event.payload as string)
    })
  } catch (error) {
    terminalRef.value?.writeln(`\x1b[31mConnection failed: ${error}\x1b[0m`)
  } finally {
    connecting.value = false
  }
}

async function disconnect() {
  if (unlisten) {
    unlisten()
    unlisten = null
  }

  if (connected.value) {
    try {
      await invoke('ssh_disconnect', { id: props.asset.id })
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
    connected.value = false
  }
}

async function handleData(data: string) {
  if (connected.value) {
    try {
      await invoke('ssh_write', { id: props.asset.id, data })
    } catch (error) {
      console.error('Failed to write data:', error)
    }
  }
}

async function handleResize(cols: number, rows: number) {
  if (connected.value) {
    try {
      await invoke('ssh_resize', { id: props.asset.id, cols, rows })
    } catch (error) {
      console.error('Failed to resize:', error)
    }
  }
}
</script>

<template>
  <div class="ssh-terminal">
    <v-toolbar density="compact">
      <v-toolbar-title>
        <v-icon class="mr-2">mdi-console</v-icon>
        {{ asset.name }} - {{ asset.config.host }}
      </v-toolbar-title>
      <v-chip
        :color="connected ? 'success' : 'error'"
        size="small"
      >
        {{ connected ? t('asset.connect') : t('asset.disconnect') }}
      </v-chip>
      <v-btn
        icon
        size="small"
        @click="connect"
        :disabled="connecting || connected"
      >
        <v-icon>mdi-connection</v-icon>
      </v-btn>
      <v-btn
        icon
        size="small"
        @click="disconnect"
        :disabled="!connected"
      >
        <v-icon>mdi-logout</v-icon>
      </v-btn>
    </v-toolbar>
    <TerminalPane
      ref="terminalRef"
      :session-id="asset.id"
      @data="handleData"
      @resize="handleResize"
    />
  </div>
</template>

<style scoped>
.ssh-terminal {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.ssh-terminal .v-toolbar {
  flex-shrink: 0;
}
</style>
