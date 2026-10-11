<template>
  <div class="tabs-bar">
    <el-tabs
      v-model="active"
      type="card"
      closable
      @tab-remove="onRemove"
      @tab-click="onClick"
    >
      <el-tab-pane
        v-for="tab in tabsStore.tabs"
        :key="tab.path"
        :label="tab.title"
        :name="tab.path"
        :closable="!tab.affix"
      />
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTabsStore } from '@/stores/tabs'

const route = useRoute()
const router = useRouter()
const tabsStore = useTabsStore()

const active = computed({
  get: () => tabsStore.active,
  set: (v: string) => tabsStore.setActive(v),
})

// 路由变化时新增标签
watch(
  () => route.path,
  () => {
    tabsStore.addTab(route)
  },
  { immediate: true },
)

function onRemove(path: string) {
  tabsStore.removeTab(path)
  if (tabsStore.active !== route.path) {
    router.push(tabsStore.active)
  }
}

function onClick(tab: any) {
  const path = tab.props.name
  if (path !== route.path) router.push(path)
}
</script>

<style scoped>
.tabs-bar {
  background: #fff;
  padding: 6px 12px 0;
  border-bottom: 1px solid #e6e6e6;
}
.tabs-bar :deep(.el-tabs__header) { margin: 0; }
.tabs-bar :deep(.el-tabs__nav) { border: none; }
</style>
