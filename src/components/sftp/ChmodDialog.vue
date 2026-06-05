<script setup lang="ts">
import { ref, watch, computed } from 'vue'

const props = defineProps<{
  visible: boolean
  currentPermissions: number
  fileName: string
}>()

const emit = defineEmits<{
  confirm: [permissions: number]
  cancel: []
}>()

const bits = ref<boolean[]>(Array(9).fill(false))

watch(() => props.visible, (val) => {
  if (val) {
    for (let i = 0; i < 9; i++) {
      bits.value[i] = (props.currentPermissions & (1 << (8 - i))) !== 0
    }
  }
})

const numericMode = computed(() => {
  const owner = (bits.value[0] ? 4 : 0) + (bits.value[1] ? 2 : 0) + (bits.value[2] ? 1 : 0)
  const group = (bits.value[3] ? 4 : 0) + (bits.value[4] ? 2 : 0) + (bits.value[5] ? 1 : 0)
  const other = (bits.value[6] ? 4 : 0) + (bits.value[7] ? 2 : 0) + (bits.value[8] ? 1 : 0)
  return `${owner}${group}${other}`
})

const labels = ['Read', 'Write', 'Execute']

function handleConfirm() {
  const owner = (bits.value[0] ? 4 : 0) + (bits.value[1] ? 2 : 0) + (bits.value[2] ? 1 : 0)
  const group = (bits.value[3] ? 4 : 0) + (bits.value[4] ? 2 : 0) + (bits.value[5] ? 1 : 0)
  const other = (bits.value[6] ? 4 : 0) + (bits.value[7] ? 2 : 0) + (bits.value[8] ? 1 : 0)
  emit('confirm', (owner << 6) | (group << 3) | other)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="chmod-backdrop" @click.self="emit('cancel')">
      <div class="chmod-dialog cyber-panel">
        <div class="modal-header">
          <div class="icon-box">
            <span class="mdi">mdi-shield-key</span>
          </div>
          <h3>Permissions — {{ fileName }}</h3>
        </div>

        <div class="modal-body">
          <div class="numeric-mode">
            <span class="mode-label">Mode</span>
            <span class="mode-value">{{ numericMode }}</span>
          </div>

          <div class="chmod-grid">
            <div class="chmod-header"></div>
            <div class="chmod-header">Read</div>
            <div class="chmod-header">Write</div>
            <div class="chmod-header">Execute</div>

            <div class="chmod-row-label">Owner</div>
            <label v-for="i in 3" :key="'o'+i" class="chmod-check">
              <input type="checkbox" v-model="bits[i - 1]" />
              <span class="checkmark"></span>
            </label>

            <div class="chmod-row-label">Group</div>
            <label v-for="i in 3" :key="'g'+i" class="chmod-check">
              <input type="checkbox" v-model="bits[i + 2]" />
              <span class="checkmark"></span>
            </label>

            <div class="chmod-row-label">Other</div>
            <label v-for="i in 3" :key="'e'+i" class="chmod-check">
              <input type="checkbox" v-model="bits[i + 5]" />
              <span class="checkmark"></span>
            </label>
          </div>
        </div>

        <div class="modal-footer">
          <span class="spacer"></span>
          <button class="cyber-btn-secondary" @click="emit('cancel')">Cancel</button>
          <button class="cyber-btn" @click="handleConfirm">Confirm</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.chmod-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
  backdrop-filter: blur(4px);
}

.chmod-dialog {
  width: 380px;
  max-width: 90vw;
}

.numeric-mode {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.mode-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.mode-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 24px;
  font-weight: 700;
  color: var(--cyan);
  letter-spacing: 0.1em;
}

.chmod-grid {
  display: grid;
  grid-template-columns: 60px 1fr 1fr 1fr;
  gap: 8px;
  align-items: center;
}

.chmod-header {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  text-align: center;
  padding-bottom: 4px;
}

.chmod-row-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.chmod-check {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.chmod-check input {
  display: none;
}

.checkmark {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: rgba(20, 25, 40, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.chmod-check input:checked + .checkmark {
  background: rgba(0, 240, 255, 0.15);
  border-color: var(--cyan);
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
}

.chmod-check input:checked + .checkmark::after {
  content: '✓';
  color: var(--cyan);
  font-size: 14px;
  font-weight: 700;
}

.chmod-check:hover .checkmark {
  border-color: var(--cyan);
}
</style>
