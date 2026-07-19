import { getGrowthLabel, getSignatureDishes, ISignatureDish, migrateLegacyCookingHistory } from '../../utils/signature-dish'
import { getRecipeDetail } from '../../utils/recipe'
import { getRecipeImageForPage } from '../../utils/recipe-image'

interface IDishView extends ISignatureDish { growthLabel: string; imageUrl: string; latestDate: string }

function toView(dish: ISignatureDish): IDishView {
  const recipe = getRecipeDetail(dish.recipeId)
  return {
    ...dish,
    growthLabel: getGrowthLabel(dish.status),
    imageUrl: dish.heroImageUrl || getRecipeImageForPage(dish.canonicalName, recipe?.coverUrl || ''),
    latestDate: dish.latestCookedAt.slice(0, 10),
  }
}

Component({
  data: {
    all: [] as IDishView[],
    signatures: [] as IDishView[],
    practicing: [] as IDishView[],
    candidates: [] as IDishView[],
    totalCooks: 0,
    activeGroup: 'all',
    visible: [] as IDishView[],
  },
  lifetimes: { attached() { this.loadData() } },
  pageLifetimes: { show() { this.loadData() } },
  methods: {
    loadData() {
      migrateLegacyCookingHistory()
      const all = getSignatureDishes().map(toView)
      const signatures = all.filter((item) => item.status === 'signature' || item.status === 'family-classic')
      const candidates = all.filter((item) => item.candidate)
      const practicing = all.filter((item) => !item.candidate && item.status !== 'signature' && item.status !== 'family-classic')
      this.setData({ all, signatures, candidates, practicing, totalCooks: all.reduce((sum, item) => sum + item.cookCount, 0), visible: this.filterGroup(all, this.data.activeGroup) })
    },
    filterGroup(all: IDishView[], group: string) {
      if (group === 'signature') return all.filter((item) => item.status === 'signature' || item.status === 'family-classic')
      if (group === 'candidate') return all.filter((item) => item.candidate)
      if (group === 'practicing') return all.filter((item) => !item.candidate && item.status !== 'signature' && item.status !== 'family-classic')
      return all
    },
    switchGroup(e: WechatMiniprogram.TouchEvent) {
      const group = e.currentTarget.dataset.group as string
      this.setData({ activeGroup: group, visible: this.filterGroup(this.data.all, group) })
    },
    goDetail(e: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/signature-detail/index?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },
    goRecipes() { wx.switchTab({ url: '/pages/recipes/index' }) },
  },
})
