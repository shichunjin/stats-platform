<template>
  <div class="tabs-bar">
    <el-tabs
      v-model="active"
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
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
}
.tabs-bar :deep(.el-tabs__header) {
  margin: 0;
}
.tabs-bar :deep(.el-tabs__nav-wrap::after) {
  display: none;
}
.tabs-bar :deep(.el-tabs__item) {
  height: 40px;
  line-height: 40px;
  padding: 0 16px;
  color: var(--text-secondary);
  font-size: 13px;
  border: none;
  transition: color 0.18s ease;
}
.tabs-bar :deep(.el-tabs__item:hover) {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.tabs-bar :deep(.el-tabs__item.is-active) {
  color: var(--color-primary);
  font-weight: 600;
}
.tabs-bar :deep(.el-tabs__active-bar) {
  height: 2px;
  background: var(--color-primary);
  border-radius: 2px;
}
.tabs-bar :deep(.el-tabs__item .is-icon-close) {
  margin-left: 6px;
  border-radius: 50%;
  transition: background 0.18s ease;
}
.tabs-bar :deep(.el-tabs__item .is-icon-close:hover) {
  background: rgba(0, 0, 0, 0.1);
  color: var(--color-danger);
}
</style>
