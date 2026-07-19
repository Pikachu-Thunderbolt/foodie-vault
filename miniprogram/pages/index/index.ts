// pages/index/index.ts
import { clearExpiredIngredients, consumeIngredient, getIngredientGroups, getIngredientStats, resolveFoodMatch, updateIngredient } from '../../utils/storage'
import { checkExpiringReminders } from '../../utils/notify'
import { getFoodVisual } from '../../utils/food-image'

type Gender = 'male' | 'female' | 'couple' | 'family' | ''

function genderToBg(gender: Gender): string {
  switch (gender) {
    case 'male': return '/resource/theme-background/男生.png'
    case 'female': return '/resource/theme-background/女生.png'
    case 'couple': return '/resource/theme-background/情侣.png'
    case 'family': return '/resource/theme-background/一家人.png'
    default: return '/resource/theme-background/无性别.png'
  }
}

interface IIngredient {
  id: string
  masterId?: string
  canonicalName?: string
  name: string
  brand?: string
  variant?: string
  category: string
  purchaseDate: string
  expiryDate: string
  quantity: number
  unit: string
  storageLocation: string
  status: 'fresh' | 'expiring' | 'expired'
  imageUrl?: string
  notes?: string
  trackingMode?: 'exact' | 'estimated' | 'level' | 'presence'
}

interface IIngredientView extends IIngredient {
  displayDate: string
  statusLabel: string
  expiryHint: string
  daysFromNow: number
  dayLabel: string
  batchLabel: string
  batchCount?: number
  quantityDisplay?: string
  batchSummary?: string
  visualKey: 'tomato' | 'lettuce' | 'egg' | 'milk' | 'root' | 'jar' | 'other'
  foodVisual: { type: 'image' | 'emoji'; value: string }
}

interface IRecentItem extends IIngredientView {
  dayLabel: string
  daysFromNow: number
}

type FilterCategory = 'all' | '常温' | '冷藏' | '冷冻' | '临期' | '过期'

let knownIngredientTotal: number | null = null
let fabScrollTimer: ReturnType<typeof setTimeout> | undefined
let fabSuccessTimer: ReturnType<typeof setTimeout> | undefined

const CATEGORY_MARKS: Record<string, string> = {
  冷藏: 'chilled',
  冷冻: 'frozen',
  常温: 'room',
  调料: 'seasoning',
}

const STATUS_LABELS: Record<IIngredient['status'], string> = {
  fresh: '新鲜',
  expiring: '临期',
  expired: '过期',
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${month}/${day}`
}

function daysBetween(dateStr: string): number {
  const target = new Date(dateStr)
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  target.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function dayLabel(dateStr: string): string {
  const days = daysBetween(dateStr)
  if (days === 0) return '今天'
  if (days === 1) return '明天'
  if (days === -1) return '昨天'
  if (days === 2) return '后天'
  if (days < 0) return `${-days}天前`
  return `${days}天后`
}

function expiryHint(dateStr: string): string {
  const days = daysBetween(dateStr)
  if (days < 0) return `已过期 ${-days} 天`
  if (days === 0) return '今天到期'
  return `${days} 天后到期`
}

function getVisualKey(item: IIngredient): IIngredientView['visualKey'] {
  const name = item.name
  if (/番茄|西红柿/.test(name)) return 'tomato'
  if (/生菜|青菜|菠菜|白菜|油麦菜|西兰花|芹菜|韭菜|香菜/.test(name)) return 'lettuce'
  if (/鸡蛋|鸭蛋|蛋/.test(name)) return 'egg'
  if (/牛奶|酸奶|奶油|豆浆/.test(name)) return 'milk'
  if (/土豆|山药|红薯|洋葱|萝卜|姜|蒜/.test(name)) return 'root'
  if (/酱|油|醋|盐|糖|罐/.test(name) || item.category === '调料') return 'jar'
  return 'other'
}

function toIngredientView(item: IIngredient): IIngredientView {
  const canonicalName = item.canonicalName || item.name
  const batchLabel = [item.brand, item.variant].filter(Boolean).join(' · ') || (canonicalName !== item.name ? item.name : '')
  return {
    ...item,
    name: canonicalName,
    displayDate: formatShortDate(item.expiryDate),
    statusLabel: STATUS_LABELS[item.status],
    expiryHint: expiryHint(item.expiryDate),
    daysFromNow: daysBetween(item.expiryDate),
    dayLabel: dayLabel(item.purchaseDate),
    batchLabel,
    visualKey: getVisualKey(item),
    foodVisual: getFoodVisual(canonicalName, ''),
  }
}

Component({
  data: {
    stats: { total: 0, fresh: 0, expiring: 0, expired: 0, room: 0, chilled: 0, frozen: 0 },
    expiringList: [] as { name: string; daysLeft: number }[],
    categories: [] as { name: string; icon: string; items: IIngredient[]; expanded: boolean }[],
    ingredients: [] as IIngredientView[],
    visibleIngredients: [] as IIngredientView[],
    keyword: '',
    showExpired: false,
    themeBackground: '',
    isEmpty: true,
    showClearConfirm: false,
    clearedCount: 0,
    filterCategory: 'all' as FilterCategory,
    recentItems: [] as IRecentItem[],
    fabCollapsed: false,
    fabOpening: false,
    fabCelebrating: false,
    categoryFilters: [
      { key: 'all', label: '全部' },
      { key: '常温', label: '常温' },
      { key: '冷藏', label: '冷藏' },
      { key: '冷冻', label: '冷冻' },
      { key: '临期', label: '临期' },
      { key: '过期', label: '过期' },
    ],
    showQuickConsume: false,
    quickConsumeItem: null as IIngredientView | null,
    quickConsumeQuantity: 1,
  },

  lifetimes: {
    attached() {
      this.loadData()
      this.refreshThemeBackground()
    },
  },

  pageLifetimes: {
    show() {
      this.setData({ fabOpening: false })
      this.loadData()
      this.refreshThemeBackground()
    },
  },

  methods: {
    refreshThemeBackground() {
      const app = getApp() as unknown as { globalData: { userPreferences: { gender: Gender } } }
      const gender = app.globalData.userPreferences?.gender || ''
      const themeBackground = genderToBg(gender)
      if (themeBackground !== this.data.themeBackground) {
        this.setData({ themeBackground })
      }
    },

    loadData() {
      const stats = getIngredientStats()
      const allIngredients = getIngredientGroups()
      const addedIngredient = knownIngredientTotal !== null && allIngredients.length > knownIngredientTotal
      knownIngredientTotal = allIngredients.length
      const reminders = checkExpiringReminders()

      const categoryMap: Record<string, IIngredient[]> = {}
      allIngredients.forEach((item) => {
        if (!categoryMap[item.category]) categoryMap[item.category] = []
        categoryMap[item.category].push(item)
      })

      const categories = Object.keys(categoryMap).map((name) => ({
        name,
        icon: CATEGORY_MARKS[name] || 'other',
        items: categoryMap[name],
        expanded: true,
      }))
      const ingredients = allIngredients.map(toIngredientView)
      // 首页显示食材主档聚合项；统计仍保留真实库存批次口径。
      const freshCount = ingredients.filter((it) => it.status === 'fresh').length
      const expiringCount = ingredients.filter((it) => it.status === 'expiring').length
      const expiredCount = ingredients.filter((it) => it.status === 'expired').length
      // 冷藏/冷冻按 category 字段计算
      const chilledCount = ingredients.filter((it) => it.category === '冷藏').length
      const frozenCount = ingredients.filter((it) => it.category === '冷冻').length
      const roomCount = ingredients.filter((it) => it.category === '常温').length

      // 最近添加：按 purchaseDate 倒序，取前 6
      const recentItems: IRecentItem[] = [...ingredients]
        .sort((a, b) => (a.purchaseDate > b.purchaseDate ? -1 : 1))
        .slice(0, 6)

      this.setData({
        stats: {
          total: stats.total,
          fresh: freshCount,
          expiring: expiringCount,
          expired: expiredCount,
          chilled: chilledCount,
          frozen: frozenCount,
          room: roomCount,
        },
        expiringList: reminders.items,
        categories,
        ingredients,
        visibleIngredients: this.computeVisible(ingredients),
        recentItems,
        isEmpty: allIngredients.length === 0,
      }, () => {
        if (addedIngredient) this.playFabSuccess()
      })
    },

    computeVisible(ingredients: IIngredientView[]) {
      const keyword = this.data.keyword.trim().toLocaleLowerCase()
      const keywordMatch = resolveFoodMatch(keyword)
      const fc = this.data.filterCategory
      return ingredients.filter((item) => {
        const searchableText = [item.name, item.canonicalName, item.batchLabel, item.brand, item.variant]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
        const matchesCanonicalName = Boolean(keywordMatch.canonicalName && keywordMatch.confidence >= 0.82 && item.canonicalName === keywordMatch.canonicalName)
        const matchesKeyword = !keyword || matchesCanonicalName || searchableText.includes(keyword)
        const matchesCategory =
          fc === 'all' ||
          (fc === '临期' && item.status === 'expiring') ||
          (fc === '过期' && item.status === 'expired') ||
          (item.category === fc)
        const matchesExpired = fc === '过期' || this.data.showExpired || item.status !== 'expired'
        return matchesKeyword && matchesCategory && matchesExpired
      })
    },

    applyFilters() {
      this.setData({ visibleIngredients: this.computeVisible(this.data.ingredients) })
    },

    onSearchInput(e: any) {
      this.setData({ keyword: String(e.detail.value || '') }, () => this.applyFilters())
    },

    onClearSearch() {
      this.setData({ keyword: '' }, () => this.applyFilters())
    },

    onIngredientScroll() {
      if (!this.data.fabCollapsed) this.setData({ fabCollapsed: true })
      if (fabScrollTimer) clearTimeout(fabScrollTimer)
      fabScrollTimer = setTimeout(() => this.setData({ fabCollapsed: false }), 260)
    },

    playFabSuccess() {
      if (fabSuccessTimer) clearTimeout(fabSuccessTimer)
      this.setData({ fabCelebrating: true, fabCollapsed: false })
      fabSuccessTimer = setTimeout(() => this.setData({ fabCelebrating: false }), 1200)
    },

    onStatFilter(e: WechatMiniprogram.TouchEvent) {
      const filter = (e.currentTarget.dataset.filter as string) || 'all'
      const fc: FilterCategory = (filter === 'all' ? 'all' : filter as FilterCategory)
      this.setData({ filterCategory: fc }, () => this.applyFilters())
    },

    onCategoryFilter(e: WechatMiniprogram.TouchEvent) {
      const key = e.currentTarget.dataset.key as FilterCategory
      this.setData({ filterCategory: key }, () => this.applyFilters())
    },

    onQtyChange(e: WechatMiniprogram.TouchEvent) {
      const index = Number(e.currentTarget.dataset.index)
      if (Number.isNaN(index)) return
      const item = this.data.visibleIngredients[index]
      if (!item) return
      const delta = Number(e.currentTarget.dataset.delta) || 0
      const nextQty = Math.max(0, (item.quantity || 0) + delta)
      if (nextQty === item.quantity) return
      updateIngredient(item.id, { quantity: nextQty })
      const ingredients = this.data.ingredients.map((it) => it.id === item.id ? { ...it, quantity: nextQty } : it)
      this.setData({ ingredients, visibleIngredients: this.computeVisible(ingredients) })
      wx.vibrateShort({ type: 'light' })
    },

    toggleCategory(e: any) {
      const { index } = e.currentTarget.dataset
      const categories = this.data.categories
      categories[index].expanded = !categories[index].expanded
      this.setData({ categories })
    },

    toggleShowExpired() {
      this.setData({ showExpired: !this.data.showExpired }, () => this.applyFilters())
    },

    goAddIngredient() {
      if (this.data.fabOpening) return
      this.setData({ fabOpening: true, fabCollapsed: false })
      setTimeout(() => wx.navigateTo({ url: '/pages/add-ingredient/index' }), 180)
    },

    goIngredientDetail(e: any) {
      const { id } = e.currentTarget.dataset
      wx.navigateTo({ url: `/pages/ingredient-detail/index?id=${id}` })
    },

    openQuickConsume(e: WechatMiniprogram.TouchEvent) {
      const id = e.currentTarget.dataset.id as string
      const item = this.data.ingredients.find((ingredient) => ingredient.id === id)
      if (!item) return
      if (item.trackingMode && item.trackingMode !== 'exact') {
        wx.navigateTo({ url: `/pages/ingredient-detail/index?id=${id}` })
        return
      }
      this.setData({ showQuickConsume: true, quickConsumeItem: item, quickConsumeQuantity: 1 })
    },

    closeQuickConsume() { this.setData({ showQuickConsume: false, quickConsumeItem: null }) },
    changeQuickConsume(e: WechatMiniprogram.TouchEvent) { this.setData({ quickConsumeQuantity: Math.max(1, this.data.quickConsumeQuantity + (Number(e.currentTarget.dataset.delta) || 0)) }) },
    confirmQuickConsume() {
      const item = this.data.quickConsumeItem
      if (!item) return
      const tx = consumeIngredient(item.masterId || item.id, this.data.quickConsumeQuantity, 'quick_use')
      if (!tx) { wx.showToast({ title: '没有可扣减的库存', icon: 'none' }); return }
      this.closeQuickConsume()
      wx.showToast({ title: `已减少 ${this.data.quickConsumeQuantity}${item.unit}`, icon: 'success' })
      this.loadData()
    },

    showClearDialog() {
      const expired = this.data.stats.expired
      if (expired === 0) {
        wx.showToast({ title: '没有过期食材', icon: 'none' })
        return
      }
      this.setData({ showClearConfirm: true })
    },

    onClearCancel() {
      this.setData({ showClearConfirm: false })
    },

    onClearConfirm() {
      const removed = clearExpiredIngredients()
      this.setData({ showClearConfirm: false, clearedCount: removed })
      wx.showToast({ title: `已清理${removed}件过期食材`, icon: 'success' })
      this.loadData()
    },

    getStatusText(status: string): string {
      const map: Record<string, string> = {
        fresh: '新鲜',
        expiring: '临期',
        expired: '已过期',
      }
      return map[status] || status
    },

    getRemainingDays(expiryDate: string): number {
      const now = new Date()
      const expiry = new Date(expiryDate)
      return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    },

    formatDate(dateStr: string): string {
      const date = new Date(dateStr)
      return `${date.getMonth() + 1}月${date.getDate()}日`
    },

    noop() {},
  },
})
