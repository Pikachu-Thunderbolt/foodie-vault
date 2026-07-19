// pages/ingredient-detail/index.ts
import { consumeIngredient, getAllIngredients, getIngredientBatches, getPantryLevelLabel, getPantryProductProfile, IngredientTrackingMode, IPantryProductProfile, PantryLevel, recordEstimatedUsage, setTypicalServingsPerPackage, updateIngredient, updatePantryLevel, deleteIngredient } from '../../utils/storage'
import { FoodVisual, getFoodVisual } from '../../utils/food-image'

interface IIngredient {
  id: string
  masterId?: string
  canonicalName?: string
  name: string
  brand?: string
  variant?: string
  packageSize?: string
  category: string
  purchaseDate: string
  expiryDate: string
  quantity: number
  unit: string
  storageLocation: string
  status: 'fresh' | 'expiring' | 'expired'
  imageUrl?: string
  notes?: string
  trackingMode?: IngredientTrackingMode
  pantryLevel?: PantryLevel
}

Component({
  data: {
    ingredient: null as IIngredient | null,
    isEditing: false,
    editForm: {} as Partial<IIngredient>,
    remainingDays: 0,
    foodVisual: { type: 'emoji', value: '' } as FoodVisual,
    batchList: [] as IIngredient[],
    isMasterView: false,
    showDeleteConfirm: false,
    showConsumeSheet: false,
    consumeQuantity: 1,
    consumeReason: 'quick_use' as 'quick_use' | 'expired' | 'discard',
    pantryLevels: [
      { key: 'full', label: '满' }, { key: 'sufficient', label: '充足' }, { key: 'half', label: '过半' }, { key: 'low', label: '将尽' }, { key: 'empty', label: '空' },
    ],
    pantryProfile: null as IPantryProductProfile | null,
    showUsageSheet: false,
    showServingSetup: false,
    typicalServingsInput: '',
  },

  lifetimes: {
    attached() {
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1] as any
      const id = currentPage.options?.id

      if (id) {
        this.loadIngredient(id)
      }
    },
  },

  methods: {
    loadIngredient(id: string) {
      const ingredients = getAllIngredients()
      const isMasterView = id.indexOf('master_') === 0
      const batches = isMasterView ? getIngredientBatches(id) : []
      const representative = isMasterView
        ? [...batches].sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0]
        : ingredients.find((item) => item.id === id)

      if (!representative) {
        wx.showToast({ title: '食材不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 1000)
        return
      }

      const sameUnit = isMasterView && new Set(batches.map((batch) => batch.unit)).size === 1
      const ingredient = isMasterView ? {
        ...representative,
        quantity: sameUnit ? batches.reduce((sum, batch) => sum + batch.quantity, 0) : representative.quantity,
        unit: sameUnit ? representative.unit : '批',
        pantryLevel: representative.pantryLevel,
      } : representative

      const now = new Date()
      const expiry = new Date(ingredient.expiryDate)
      const remainingDays = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))

      this.setData({
        ingredient,
        remainingDays,
        foodVisual: getFoodVisual(ingredient.canonicalName || ingredient.name, ''),
        editForm: { ...ingredient },
        batchList: isMasterView ? batches : [],
        isMasterView,
        pantryProfile: ingredient.trackingMode === 'estimated' ? getPantryProductProfile(representative as any) : null,
      })
    },

    // 进入编辑模式
    startEdit() {
      this.setData({ isEditing: true })
    },

    showConsumeSheet() {
      this.setData({ showConsumeSheet: true, consumeQuantity: 1, consumeReason: 'quick_use' })
    },

    hideConsumeSheet() { this.setData({ showConsumeSheet: false }) },

    changeConsumeQuantity(e: WechatMiniprogram.TouchEvent) {
      const delta = Number(e.currentTarget.dataset.delta) || 0
      this.setData({ consumeQuantity: Math.max(1, this.data.consumeQuantity + delta) })
    },

    selectConsumeReason(e: WechatMiniprogram.TouchEvent) {
      this.setData({ consumeReason: e.currentTarget.dataset.reason })
    },

    confirmConsume() {
      const ingredient = this.data.ingredient
      if (!ingredient) return
      const masterId = ingredient.masterId || ingredient.id
      const tx = consumeIngredient(masterId, this.data.consumeQuantity, this.data.consumeReason)
      if (!tx) { wx.showToast({ title: '没有可扣减的库存', icon: 'none' }); return }
      this.setData({ showConsumeSheet: false })
      wx.showToast({ title: `已减少 ${this.data.consumeQuantity}${ingredient.unit}`, icon: 'success' })
      this.loadIngredient(masterId)
    },

    selectPantryLevel(e: WechatMiniprogram.TouchEvent) {
      const ingredient = this.data.ingredient
      if (!ingredient) return
      const level = e.currentTarget.dataset.level as PantryLevel
      const masterId = ingredient.masterId || ingredient.id
      updatePantryLevel(masterId, level)
      wx.showToast({ title: `余量已记为${getPantryLevelLabel(level)}`, icon: 'success' })
      this.loadIngredient(masterId)
    },

    showUsageSheet() { this.setData({ showUsageSheet: true }) },
    hideUsageSheet() { this.setData({ showUsageSheet: false }) },
    recordUsage(e: WechatMiniprogram.TouchEvent) {
      const ingredient = this.data.ingredient
      if (!ingredient) return
      const units = Number(e.currentTarget.dataset.units) || 1
      const profile = recordEstimatedUsage(ingredient.masterId || ingredient.id, units)
      this.setData({ showUsageSheet: false, pantryProfile: profile })
      wx.showToast({ title: '已记下这次用量', icon: 'success' })
      this.loadIngredient(ingredient.masterId || ingredient.id)
    },
    openServingSetup() { this.setData({ showServingSetup: true, typicalServingsInput: this.data.pantryProfile?.typicalServingsPerPackage ? String(this.data.pantryProfile.typicalServingsPerPackage) : '' }) },
    onTypicalServingsInput(e: any) { this.setData({ typicalServingsInput: e.detail.value }) },
    saveServingSetup() {
      const ingredient = this.data.ingredient
      const total = Number(this.data.typicalServingsInput)
      if (!ingredient || !total) { wx.showToast({ title: '填入大概餐数即可', icon: 'none' }); return }
      const profile = setTypicalServingsPerPackage(ingredient.masterId || ingredient.id, total)
      this.setData({ showServingSetup: false, pantryProfile: profile })
      wx.showToast({ title: '已记住这款包装习惯', icon: 'success' })
    },

    cancelEdit() {
      this.setData({
        isEditing: false,
        editForm: { ...this.data.ingredient } as any,
      })
    },

    // 编辑表单变更
    onFieldChange(e: any) {
      const { field } = e.currentTarget.dataset
      const value = e.detail.value
      this.setData({ [`editForm.${field}`]: value })
    },

    // 保存编辑
    saveEdit() {
      const { ingredient, editForm } = this.data
      if (!ingredient) return

      const updated = updateIngredient(ingredient.id, {
        name: editForm.name,
        brand: editForm.brand,
        variant: editForm.variant,
        category: editForm.category,
        quantity: Number(editForm.quantity) || 1,
        unit: editForm.unit,
        storageLocation: editForm.storageLocation,
        notes: editForm.notes,
      })

      if (updated) {
        this.setData({ ingredient: updated, isEditing: false })
        wx.showToast({ title: '修改已保存', icon: 'success' })
      }
    },

    // 确认删除
    showDeleteConfirm() {
      this.setData({ showDeleteConfirm: true })
    },

    hideDeleteConfirm() {
      this.setData({ showDeleteConfirm: false })
    },

    confirmDelete() {
      const { ingredient } = this.data
      if (!ingredient) return

      deleteIngredient(ingredient.id)
      this.setData({ showDeleteConfirm: false })
      wx.showToast({ title: '已删除', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)
    },

    // 跳转菜谱推荐（Tab Bar页面必须用switchTab）
    goRecipes() {
      const { ingredient } = this.data
      if (!ingredient) return

      // Tab Bar页面不能传query参数，通过globalData传递
      const app = getApp<IAppOption>()
      app.globalData.searchIngredient = ingredient.name

      wx.switchTab({
        url: '/pages/recipes/index',
      })
    },

    // 格式化日期
    formatDate(dateStr: string): string {
      const d = new Date(dateStr)
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
    },

    getStatusText(status: string): string {
      const map: Record<string, string> = {
        fresh: '新鲜',
        expiring: '临期',
        expired: '已过期',
      }
      return map[status] || status
    },
  },
})
