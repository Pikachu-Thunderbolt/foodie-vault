// components/tab-bar/index.ts
Component({
  properties: {
    active: {
      type: String,
      value: 'index',
    },
  },

  data: {
    tabs: [
      { key: 'index', label: '食材', icon: 'pantry' },
      { key: 'recipes', label: '菜谱', icon: 'recipe' },
      { key: 'scan-import', label: '扫描', icon: 'scan' },
      { key: 'checklist', label: '清单', icon: 'checklist' },
      { key: 'profile', label: '我的', icon: 'profile' },
    ],
  },

  methods: {
    switchTab(e: any) {
      const { key } = e.currentTarget.dataset
      if (key === this.properties.active) return

      wx.switchTab({ url: `/pages/${key}/index` })
    },
  },
})
