// pages/recipes/index.ts
import { getRecommendedRecipes, getRecipesByIngredients, searchRecipes } from '../../utils/recipe'
import { getIngredientNames, getExpiringIngredients } from '../../utils/storage'
import { getFoodVisual } from '../../utils/food-image'
import { getRecipeImageForPage } from '../../utils/recipe-image'
import { TASTE_OPTIONS, DIFFICULTY_OPTIONS, RECIPE_CATEGORY_OPTIONS } from '../../data/mock-data'
import { getGrowthLabel, getSignatureDishes, migrateLegacyCookingHistory } from '../../utils/signature-dish'

interface IRecipe {
  id: string
  name: string
  coverUrl: string
  ingredients: string[]
  extraIngredients: string[]
  steps: { desc: string; imageUrl?: string }[]
  duration: number
  difficulty: 'easy' | 'medium' | 'hard'
  servings: number
  taste: string
  category: string
  equipment: string[]
  tips: string
}

interface IRecipeResult {
  recipe: IRecipe
  matchRate: number
  matchPercent: number
  matchedIngredients: string[]
  matchText?: string
  missingText?: string
  dishVisualType: 'image' | 'emoji'
  dishVisualValue: string
}

const DIFFICULTY_MAP: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '较难',
  any: '不限',
}

function getRecipeVisual(recipe: IRecipe): Pick<IRecipeResult, 'dishVisualType' | 'dishVisualValue'> {
  return {
    dishVisualType: 'image',
    dishVisualValue: getRecipeImageForPage(recipe.name, recipe.coverUrl),
  }
}

function getRecommendationTable(recipes: IRecipeResult[], offset: number): IRecipeResult[] {
  if (recipes.length <= 5) return recipes.slice(0, 5)
  return Array.from({ length: 5 }, (_, index) => recipes[(offset + index) % recipes.length])
}

function makeRecipeResult(recipe: IRecipe, selectedIngredients: string[]): IRecipeResult {
  const selected = selectedIngredients.map((name) => name.toLowerCase())
  const matchedIngredients = recipe.ingredients.filter((ingredient) =>
    selected.some((name) => ingredient.toLowerCase().includes(name) || name.includes(ingredient.toLowerCase())),
  )
  const matchRate = recipe.ingredients.length ? matchedIngredients.length / recipe.ingredients.length : 0
  return {
    recipe,
    matchRate,
    // WXML 直接计算浮点数会展示长尾小数，统一保留一位即可。
    matchPercent: Math.round(matchRate * 1000) / 10,
    matchedIngredients,
    ...getRecipeVisual(recipe),
    matchText: matchRate > 0 ? `已有 ${matchedIngredients.length} / 共需 ${recipe.ingredients.length}` : '食材待确认',
    missingText: matchRate >= 1 ? '家里都有' : `还缺 ${Math.max(0, recipe.ingredients.length - matchedIngredients.length)} 样`,
  }
}

Component({
  data: {
    searchKeyword: '',
    searchInputFocus: false,
    recipes: [] as IRecipeResult[],
    filtered: [] as IRecipeResult[],
    recommendations: [] as IRecipeResult[],
    heroRecipe: null as IRecipeResult | null,
    tableRecipes: [] as IRecipeResult[],
    moreRecipes: [] as IRecipeResult[],
    hotRecipes: [] as IRecipeResult[],
    signatureRecipes: [] as IRecipeResult[],
    signatureDishViews: [] as { id: string; name: string; stage: string; progress: string; imageUrl: string; candidate: boolean }[],
    ingredientCount: 0,
    selectedIngredients: [] as string[],
    availableIngredients: [] as string[],
    availableIngredientChoices: [] as { name: string; urgent: boolean }[],
    expiringIngredients: [] as string[],
    hasManualSelection: false,
    tableOffset: 0,
    isChangingTable: false,
    viewMode: 'home' as 'home' | 'picker' | 'recommend',
    isDirectSearch: false,
    pickerCategory: 'all',
    visiblePickerChoices: [] as { name: string; urgent: boolean; selected: boolean; group: string; emoji: string; visualType: 'image' | 'emoji'; visualValue: string }[],

    // 筛选状态
    showFilters: false,
    filterServings: 0,
    filterMaxDuration: 0,
    filterDifficulty: 'any',
    filterTaste: 'any',
    filterCategory: 'any',

    // 选项
    tasteOptions: TASTE_OPTIONS.map((v) => ({ value: v, label: v === 'any' ? '不限口味' : v })),
    difficultyOptions: DIFFICULTY_OPTIONS.map((v) => ({ value: v, label: DIFFICULTY_MAP[v] || v })),
    categoryOptions: RECIPE_CATEGORY_OPTIONS.map((v) => ({ value: v, label: v === 'any' ? '不限分类' : v })),
    servingsOptions: [0, 1, 2, 3, 4].map((v) => ({ value: v, label: v === 0 ? '不限人数' : `${v}人份` })),
    durationOptions: [0, 15, 30, 45, 60, 120].map((v) => ({
      value: v,
      label: v === 0 ? '不限时长' : `${v}分钟内`,
    })),

    isLoading: false,
  },

  lifetimes: {
    attached() {
      this.loadRecipes()
    },
  },

  pageLifetimes: {
    show() {
      // 从globalData读取其他页面传递的食材筛选参数
      const app = getApp<IAppOption>()
      const searchIngredient = app.globalData.searchIngredient
      if (searchIngredient) {
        this.setData({ searchKeyword: searchIngredient })
        app.globalData.searchIngredient = '' // 用完后清除
      }
      this.loadRecipes()
    },
  },

  methods: {
    loadRecipes() {
      this.setData({ isLoading: true })

      const ingredientNames = getIngredientNames()
      const expiringBatches = getExpiringIngredients(3)
      const expiringIngredientNames = Array.from(new Set(expiringBatches.map((item) => item.canonicalName)))
      const { filterDifficulty, filterTaste, filterCategory, filterServings, filterMaxDuration } = this.data

      const options: any = {}
      if (filterDifficulty !== 'any') options.difficulty = filterDifficulty
      if (filterTaste !== 'any') options.taste = filterTaste
      if (filterCategory !== 'any') options.category = filterCategory
      if (filterServings > 0) options.servings = filterServings
      if (filterMaxDuration > 0) options.maxDuration = filterMaxDuration

      const selectedIngredients = this.data.hasManualSelection
        ? this.data.selectedIngredients
        : ingredientNames.slice(0, 8)
      const directKeyword = this.data.searchKeyword.trim()
      const recipes = this.data.isDirectSearch && directKeyword
        ? searchRecipes(directKeyword).map((recipe) => makeRecipeResult(recipe, ingredientNames))
        : getRecipesByIngredients(selectedIngredients.length > 0 ? selectedIngredients : undefined, options)
          .map((item) => makeRecipeResult(item.recipe, selectedIngredients))
      const visibleTable = getRecommendationTable(recipes, this.data.tableOffset)
      const hotRecipes = getRecommendedRecipes().slice(0, 5).map((recipe) => makeRecipeResult(recipe, ingredientNames))
      const signatureRecipes = getRecommendedRecipes().slice(0, 3).map((recipe) => makeRecipeResult(recipe, ingredientNames))
      migrateLegacyCookingHistory()
      const signatureDishViews = getSignatureDishes().slice(0, 3).map((dish) => {
        const recipe = getRecommendedRecipes().find((item) => item.id === dish.recipeId)
        return { id: dish.id, name: dish.personalName, stage: getGrowthLabel(dish.status), progress: dish.candidate ? '可以设为拿手菜' : `做过 ${dish.cookCount} 次`, imageUrl: dish.heroImageUrl || getRecipeImageForPage(dish.canonicalName, recipe?.coverUrl || ''), candidate: dish.candidate }
      })

      this.setData({
        recipes,
        filtered: recipes,
        recommendations: visibleTable,
        heroRecipe: visibleTable[0] || null,
        tableRecipes: visibleTable.slice(1),
        moreRecipes: recipes.slice(5),
        hotRecipes,
        signatureRecipes,
        signatureDishViews,
        ingredientCount: ingredientNames.length,
        selectedIngredients,
        availableIngredients: ingredientNames,
        availableIngredientChoices: ingredientNames.map((name) => ({
          name,
          urgent: expiringIngredientNames.includes(name),
        })),
        visiblePickerChoices: this.buildPickerChoices(ingredientNames, selectedIngredients, this.data.pickerCategory),
        expiringIngredients: expiringIngredientNames,
        isLoading: false,
      })
    },

    goSignatureDishes() { wx.navigateTo({ url: '/pages/signature-dishes/index' }) },
    goSignatureDetail(e: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/signature-detail/index?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },

    // 搜索
    onSearchInput(e: any) {
      const keyword = e.detail.value
      this.setData({ searchKeyword: keyword })

      if (!keyword.trim()) {
        const filtered = this.data.recipes
        this.setData({
          filtered,
          recommendations: filtered.slice(0, 5),
          heroRecipe: filtered[0] || null,
          tableRecipes: filtered.slice(1, 5),
          moreRecipes: filtered.slice(5),
        })
        return
      }

      const results = searchRecipes(keyword)
      const filtered = this.data.recipes.filter((item) => results.find((r) => r.id === item.recipe.id))
      this.setData({
        filtered,
        recommendations: filtered.slice(0, 5),
        heroRecipe: filtered[0] || null,
        tableRecipes: filtered.slice(1, 5),
        moreRecipes: filtered.slice(5),
      })
    },

    startDirectSearch() {
      // 入口卡片应进入可见的搜索状态，而非只在当前页悄悄尝试聚焦输入框。
      this.setData({ viewMode: 'recommend', isDirectSearch: true, searchInputFocus: true, tableOffset: 0 }, () => this.loadRecipes())
    },

    directSearch() {
      if (!this.data.searchKeyword.trim()) {
        wx.showToast({ title: '输入菜名、食材或菜系后搜索', icon: 'none' })
        this.setData({ searchInputFocus: true })
        return
      }
      this.setData({ viewMode: 'recommend', isDirectSearch: true, searchInputFocus: false, tableOffset: 0 }, () => this.loadRecipes())
    },

    goToPicker() {
      this.setData({ viewMode: 'picker', isDirectSearch: false, searchInputFocus: false, tableOffset: 0 }, () => this.loadRecipes())
    },

    goToHome() {
      this.setData({ viewMode: 'home', isDirectSearch: false, searchKeyword: '', searchInputFocus: false, tableOffset: 0 }, () => this.loadRecipes())
    },

    toggleIngredient(e: WechatMiniprogram.TouchEvent) {
      const name = String(e.currentTarget.dataset.name || '')
      if (!name) return
      const selected = [...this.data.selectedIngredients]
      const index = selected.indexOf(name)
      if (index >= 0) selected.splice(index, 1)
      else if (selected.length < 8) selected.push(name)
      else {
        wx.showToast({ title: '一次最多选 8 样食材', icon: 'none' })
        return
      }
      this.setData({ selectedIngredients: selected, hasManualSelection: true, tableOffset: 0, visiblePickerChoices: this.buildPickerChoices(this.data.availableIngredients, selected, this.data.pickerCategory) }, () => this.loadRecipes())
    },

    preferExpiring() {
      const selectedIngredients = [...new Set(
        getExpiringIngredients(3)
          .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())
          .map((item) => item.canonicalName),
      )].slice(0, 8)
      if (!selectedIngredients.length) {
        wx.showToast({ title: '暂无 3 天内到期的食材', icon: 'none' })
        return
      }
      this.setData({ selectedIngredients, hasManualSelection: true, tableOffset: 0 }, () => this.loadRecipes())
    },

    clearSelectedIngredients() {
      this.setData({ selectedIngredients: [], hasManualSelection: true, tableOffset: 0 }, () => this.loadRecipes())
    },

    onPickerCategory(e: WechatMiniprogram.TouchEvent) {
      const pickerCategory = String(e.currentTarget.dataset.category || 'all')
      this.setData({ pickerCategory, visiblePickerChoices: this.buildPickerChoices(this.data.availableIngredients, this.data.selectedIngredients, pickerCategory) })
    },

    findRecipes() {
      this.setData({ viewMode: 'recommend', isDirectSearch: false, tableOffset: 0 }, () => this.loadRecipes())
    },

    backToPicker() {
      this.setData({ viewMode: 'picker' })
    },

    buildPickerChoices(names: string[], selected: string[], category: string) {
      const groupOf = (name: string) => {
        if (/鱼|虾|肉|鸡|排骨|牛/.test(name)) return 'frozen'
        if (/奶|蛋|菜|瓜|椒|菇|豆腐/.test(name)) return 'chilled'
        return 'room'
      }
      const emojiOf = (name: string) => {
        if (/番茄/.test(name)) return '🍅'; if (/蛋/.test(name)) return '🥚'; if (/西兰花|菜|瓜|椒/.test(name)) return '🥦'; if (/肉|鸡|排骨/.test(name)) return '🥩'; if (/奶/.test(name)) return '🥛'; if (/虾|鱼/.test(name)) return '🦐'; return '🍲'
      }
      return names.filter((name) => category === 'all' || groupOf(name) === category).slice(0, 12).map((name) => {
        const visual = getFoodVisual(name, emojiOf(name))
        return {
          name,
          group: groupOf(name),
          selected: selected.includes(name),
          urgent: getExpiringIngredients(3).some((item) => item.canonicalName === name),
          emoji: emojiOf(name),
          visualType: visual.type,
          // 动态 image 在该页面使用相对资源路径，避免根路径在 Skyline 下丢失。
          visualValue: visual.type === 'image' ? `../../${visual.value.replace(/^\//, '')}` : visual.value,
        }
      })
    },

    changeTable() {
      if (this.data.isChangingTable) return
      if (this.data.recipes.length <= 5) {
        wx.showToast({ title: '当前食材没有更多推荐，换食材试试', icon: 'none' })
        return
      }
      this.setData({ isChangingTable: true })
      const nextOffset = (this.data.tableOffset + 5) % this.data.recipes.length
      setTimeout(() => {
        this.setData({ tableOffset: nextOffset }, () => {
          this.loadRecipes()
          setTimeout(() => this.setData({ isChangingTable: false }), 280)
        })
      }, 130)
    },

    // 跳转菜谱详情
    goRecipeDetail(e: any) {
      const { id } = e.currentTarget.dataset
      wx.navigateTo({
        url: `/pages/recipe-detail/index?id=${id}`,
      })
    },

    // 切换筛选面板
    toggleFilters() {
      this.setData({ showFilters: !this.data.showFilters })
    },

    // 筛选变更
    onFilterChange(e: any) {
      const { field } = e.currentTarget.dataset
      const value = e.currentTarget.dataset.value ?? e.detail.value
      const normalizedValue = field === 'servings' || field === 'maxDuration' ? Number(value) : value
      this.setData({ [`filter${field.charAt(0).toUpperCase() + field.slice(1)}`]: normalizedValue })
    },

    // 应用筛选
    applyFilters() {
      this.setData({ showFilters: false })
      this.loadRecipes()
    },

    // 重置筛选
    resetFilters() {
      this.setData({
        filterServings: 0,
        filterMaxDuration: 0,
        filterDifficulty: 'any',
        filterTaste: 'any',
        filterCategory: 'any',
      })
      this.loadRecipes()
    },

    // 格式化匹配率
    formatMatchRate(rate: number): string {
      return Math.round(rate * 100) + '%'
    },

    getDifficultyText(difficulty: string): string {
      return DIFFICULTY_MAP[difficulty] || difficulty
    },
  },
})
