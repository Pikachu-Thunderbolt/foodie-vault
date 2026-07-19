interface ChecklistItem {
  id: string
  name: string
  checked: boolean
  source: string
}

const STORAGE_KEY = 'shoppingChecklist'

Component({
  data: {
    draft: '',
    items: [] as ChecklistItem[],
    pendingCount: 0,
    completedCount: 0,
  },

  lifetimes: {
    attached() {
      this.loadItems()
    },
  },

  pageLifetimes: {
    show() {
      this.loadItems()
    },
  },

  methods: {
    loadItems() {
      const items = (wx.getStorageSync(STORAGE_KEY) || []) as ChecklistItem[]
      this.updateItems(items)
    },

    updateItems(items: ChecklistItem[]) {
      wx.setStorageSync(STORAGE_KEY, items)
      this.setData({
        items,
        pendingCount: items.filter((item) => !item.checked).length,
        completedCount: items.filter((item) => item.checked).length,
      })
    },

    onDraftInput(e: any) {
      this.setData({ draft: e.detail.value })
    },

    addItem() {
      const name = this.data.draft.trim()
      if (!name) {
        wx.showToast({ title: '先写下要买的食材', icon: 'none' })
        return
      }
      const items = [{ id: `${Date.now()}`, name, checked: false, source: '手动添加' }, ...this.data.items]
      this.setData({ draft: '' })
      this.updateItems(items)
    },

    toggleItem(e: any) {
      const { id } = e.currentTarget.dataset
      const items = this.data.items.map((item) => item.id === id ? { ...item, checked: !item.checked } : item)
      this.updateItems(items)
    },

    removeItem(e: any) {
      const { id } = e.currentTarget.dataset
      this.updateItems(this.data.items.filter((item) => item.id !== id))
      wx.showToast({ title: '已从清单移除', icon: 'none' })
    },

    clearCompleted() {
      if (!this.data.completedCount) return
      this.updateItems(this.data.items.filter((item) => !item.checked))
    },

    goRecipes() {
      wx.switchTab({ url: '/pages/recipes/index' })
    },
  },
})
