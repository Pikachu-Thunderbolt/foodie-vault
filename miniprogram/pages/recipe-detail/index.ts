// pages/recipe-detail/index.ts
import { getRecipeDetail } from '../../utils/recipe'
import { completeCookingSession, createCookingSession, getAllIngredients, getIngredientNames, resolveCanonicalName } from '../../utils/storage'
import { getRecipeImageForPage } from '../../utils/recipe-image'

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

function buildReservations(recipe: IRecipe): { batchId: string; quantity: number; unit: string }[] {
  const batches = getAllIngredients()
  const reservedBatchIds = new Set<string>()
  return recipe.ingredients.reduce((result: { batchId: string; quantity: number; unit: string }[], name) => {
    const canonicalName = resolveCanonicalName(name)
    const batch = batches.filter((item) => item.canonicalName === canonicalName && item.quantity > 0 && !reservedBatchIds.has(item.id))
      .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())[0]
    if (batch) { reservedBatchIds.add(batch.id); result.push({ batchId: batch.id, quantity: 1, unit: batch.unit }) }
    return result
  }, [])
}

Component({
  data: {
    recipe: null as IRecipe | null,
    currentStep: 0,
    keepScreenOn: false,
    showTimer: false,
    timerMinutes: 0,
    timerSeconds: 0,
    timerRunning: false,
    timerDisplay: '00:00',
    timerInterval: 0,
    userIngredients: [] as string[],
    ownedIngredients: [] as string[],
    ingredientItems: [] as { name: string; owned: boolean }[],
    needBuyIngredients: [] as string[],
    matchPercent: 0,
    matchText: '',
    dishImage: '',
    extraIngredientsText: '',
    equipmentText: '',
    cookingSessionId: '',
    cookingStateText: '开始制作',
    isFinishing: false,
    completionError: '',
  },

  lifetimes: {
    attached() {
      this.loadRecipeFromRoute()
    },
    detached() {
      // 清除计时器
      if (this.data.timerInterval) {
        clearInterval(this.data.timerInterval as any)
      }
    },
  },

  pageLifetimes: {
    show() {
      // Skyline 下页面 options 可能晚于组件 attached 可用；在页面显示时再兜底读取一次。
      if (!this.data.recipe) this.loadRecipeFromRoute()
      // 从成果记录页返回时，上一轮制作已经结束，可以立即开始新一轮。
      if (this.data.isFinishing) this.setData({ isFinishing: false })
    },
  },

  methods: {
    loadRecipeFromRoute() {
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1] as any
      const id = currentPage.options?.id

      if (!id) return
      const recipe = getRecipeDetail(id)
      if (!recipe) {
        wx.showToast({ title: '这道菜暂时无法打开', icon: 'none' })
        return
      }
      const userIngredients = getIngredientNames()
      const ownedIngredients: string[] = []
      const needBuyIngredients: string[] = []
      const ingredientItems = recipe.ingredients.map((ing) => {
        const found = userIngredients.some(
          (u) => ing.toLowerCase().includes(u.toLowerCase()) || u.toLowerCase().includes(ing.toLowerCase())
        )
        if (found) ownedIngredients.push(ing)
        else needBuyIngredients.push(ing)
        return { name: ing, owned: found }
      })

      this.setData({
        recipe,
        userIngredients,
        ownedIngredients,
        ingredientItems,
        // 采购按钮只对应页面中标为“需购买”的主食材。调料/辅料是烹饪提示，
        // 不因未入库就自动塞进采购清单，避免盐、糖、油等常备项造成干扰。
        needBuyIngredients,
        matchPercent: recipe.ingredients.length ? Math.round((ownedIngredients.length / recipe.ingredients.length) * 20) * 5 : 0,
        matchText: `已有 ${ownedIngredients.length} / 共需 ${recipe.ingredients.length}`,
        dishImage: getRecipeImageForPage(recipe.name, recipe.coverUrl),
        // Skyline/WXML 不稳定支持数组 join，预先转成展示文案，避免“标签存在、内容为空”。
        extraIngredientsText: recipe.extraIngredients.join('、'),
        equipmentText: recipe.equipment.join('、'),
      })
    },
    // 切换步骤
    goToStep(e: any) {
      const { index } = e.currentTarget.dataset
      this.setData({ currentStep: index })
    },

    // 屏幕常亮
    toggleKeepScreenOn() {
      const keepOn = !this.data.keepScreenOn
      this.setData({ keepScreenOn: keepOn })
      wx.setKeepScreenOn({ keepScreenOn: keepOn })
    },

    // 计时器
    toggleTimer() {
      if (!this.data.showTimer) {
        this.setData({ showTimer: true })
      } else {
        this.stopTimer()
        this.setData({ showTimer: false })
      }
    },

    startTimer() {
      const { timerMinutes, timerSeconds } = this.data
      let totalSeconds = timerMinutes * 60 + timerSeconds
      if (totalSeconds <= 0) return

      this.setData({ timerRunning: true })
      const interval = setInterval(() => {
        totalSeconds--
        const m = Math.floor(totalSeconds / 60)
        const s = totalSeconds % 60
        const display = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`

        if (totalSeconds <= 0) {
          this.stopTimer()
          wx.showToast({ title: '时间到！', icon: 'none' })
          return
        }
        this.setData({ timerDisplay: display })
      }, 1000)

      this.setData({ timerInterval: interval as any })
    },

    stopTimer() {
      if (this.data.timerInterval) {
        clearInterval(this.data.timerInterval as any)
      }
      this.setData({ timerRunning: false, timerInterval: 0 })
    },

    onTimerMinutesInput(e: any) {
      this.setData({ timerMinutes: parseInt(e.detail.value) || 0 })
    },

    onTimerSecondsInput(e: any) {
      this.setData({ timerSeconds: parseInt(e.detail.value) || 0 })
    },

    // 首次点击只创建预留；真正完成时再写入库存消耗流水。
    startCooking() {
      const recipe = this.data.recipe
      if (!recipe) return
      if (!this.data.cookingSessionId) {
        const reservations = buildReservations(recipe)
        const session = createCookingSession(recipe.id, recipe.name, reservations)
        this.setData({ cookingSessionId: session.id, cookingStateText: '制作中 · 按步骤完成', currentStep: 0, completionError: '' })
        wx.showToast({ title: reservations.length ? '食材已预留，跟着步骤做吧' : '开始制作吧', icon: 'none' })
        return
      }
      wx.showToast({ title: '完成最后一步后记录成果', icon: 'none' })
    },

    finishAllSteps() {
      const recipe = this.data.recipe
      if (!recipe || this.data.isFinishing) return
      const sessionId = this.data.cookingSessionId
      // 浏览步骤不等于实际制作；没有正式会话时禁止自动结算库存和生成成果。
      if (!sessionId) {
        wx.showToast({ title: '请先开始制作', icon: 'none' })
        return
      }
      this.setData({ isFinishing: true, completionError: '' })
      try {
        completeCookingSession(sessionId)
      } catch (error) {
        console.error('完成制作时同步库存失败', error)
        this.setData({ isFinishing: false, completionError: '库存同步失败，请点击“重试完成”' })
        wx.showToast({ title: '库存同步失败，请重试', icon: 'none' })
        return
      }
      // 结算后不再保留上一轮 session，否则返回页面会被误判为仍在制作中。
      this.setData({ currentStep: 0, cookingSessionId: '', cookingStateText: '开始制作', isFinishing: false, completionError: '' })
      const resultUrl = `/pages/share/index?recipeId=${recipe.id}&recipeName=${encodeURIComponent(recipe.name)}`
      wx.navigateTo({
        url: resultUrl,
        // 页面栈达到上限时，改为替换当前页，确保用户不会停在“正在完成”。
        fail: () => wx.redirectTo({
          url: resultUrl,
          fail: () => wx.showToast({ title: '无法打开成果页，请稍后再试', icon: 'none' }),
        }),
      })
    },

    addToChecklist() {
      const existing = (wx.getStorageSync('shoppingChecklist') || []) as { id: string; name: string; checked: boolean; source: string }[]
      const known = existing.map((item) => item.name)
      const recipeName = this.data.recipe?.name || '菜谱'
      const additions = this.data.needBuyIngredients
        .filter((name) => !known.includes(name))
        .map((name, index) => ({
          id: `recipe_${Date.now()}_${index}`,
          name,
          checked: false,
          source: `来自「${recipeName}」`,
        }))
      wx.setStorageSync('shoppingChecklist', [...additions, ...existing])
      wx.showToast({ title: additions.length ? `已加入${additions.length}项` : '清单中已有这些食材', icon: 'none' })
    },

    // 获取难度文本
    getDifficultyText(difficulty: string): string {
      const map: Record<string, string> = { easy: '简单', medium: '中等', hard: '较难' }
      return map[difficulty] || difficulty
    },
  },
})
