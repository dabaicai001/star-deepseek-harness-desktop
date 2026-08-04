<script setup lang="ts">
import { computed } from 'vue'
import mysqlIcon from '@/assets/icons/mysql.svg'
import postgresIcon from 'simple-icons/icons/postgresql.svg'
import redisIcon from 'simple-icons/icons/redis.svg'
import elasticsearchIcon from 'simple-icons/icons/elasticsearch.svg'
import clickhouseIcon from 'simple-icons/icons/clickhouse.svg'
import kafkaIcon from 'simple-icons/icons/apachekafka.svg'
import dockerIcon from 'simple-icons/icons/docker.svg'

const props = withDefaults(defineProps<{
  product?: string
  size?: number
}>(), {
  product: 'mysql',
  size: 16,
})

const icons: Record<string, string> = {
  mysql: mysqlIcon,
  postgresql: postgresIcon,
  redis: redisIcon,
  elasticsearch: elasticsearchIcon,
  clickhouse: clickhouseIcon,
  kafka: kafkaIcon,
  docker: dockerIcon,
}
const iconUrl = computed(() => icons[props.product.toLowerCase()] || '')
const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  '--product-icon': iconUrl.value ? `url("${iconUrl.value}")` : undefined,
}))
</script>

<template>
  <span
    class="product-icon"
    :class="[`product-${product.toLowerCase()}`, { 'product-icon-text': !iconUrl }]"
    :style="style"
    role="img"
    :aria-label="product"
  >
    <span v-if="!iconUrl">{{ product.toUpperCase().slice(0, 3) }}</span>
  </span>
</template>
