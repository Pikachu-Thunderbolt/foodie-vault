import {
  confirmSignatureDish,
  getCookingAttempts,
  getGrowthLabel,
  getSignatureDish,
  getSignatureDishInsights,
  ICookingAttempt,
  ISignatureDish,
  ISignatureDishInsights,
  saveCookingAttempt,
  updateSignatureDish,
} from '../../utils/signature-dish'
import { getRecipeDetail } from '../../utils/recipe'
import { getRecipeImageForPage } from '../../utils/recipe-image'

interface IAttemptView extends ICookingAttempt {
  indexLabel: string
  dateLabel: string
}

const QUICK_TAGS = ['很下饭', '火候正好', '口感更好', '偏咸', '偏淡', '下次再改']

Component({
  data: {
    dish: null as ISignatureDish | null,
    insights: null as ISignatureDishInsights | null,
    attempts: [] as IAttemptView[],
    growthLabel: '',
    heroImage: '',
    isEditing: false,
    showAllTimeline: false,
    visibleAttempts: [] as IAttemptView[],
    editForm: { personalName: '', tagline: '', story: '' },
    showConfirm: false,
    timelineToggleText: '',
    showQuickRecord: false,
    quickRating: 0,
    quickRatingOptions: [1, 2, 3, 4, 5],
    quickTags: [] as string[],
    quickTagChoices: QUICK_TAGS.map((name) => ({ name, selected: false })),
    quickChangeNote: '',
    quickNote: '',
    quickSatisfied: false,
    quickImageUrl: '',
    quickSaving: false,
  },

  lifetimes: {
    attached() { this.loadRoute() },
  },

  pageLifetimes: {
    show() {
      const dish = this.data.dish
      if (dish) this.loadData(dish.id)
      else this.loadRoute()
    },
  },

  methods: {
    loadRoute() {
      const pages = getCurrentPages()
      const current = pages[pages.length - 1] as any
      const id = decodeURIComponent(current.options?.id || '')
      if (id) this.loadData(id)
    },

    loadData(id: string) {
      const dish = getSignatureDish(id)
      if (!dish) {
        wx.showToast({ title: '找不到这份拿手菜记录', icon: 'none' })
        return
      }
      const raw = getCookingAttempts(dish.recipeId).sort((a, b) => a.cookedAt.localeCompare(b.cookedAt))
      const attempts = raw
        .map((item, index) => ({ ...item, indexLabel: `第 ${index + 1} 次`, dateLabel: item.cookedAt.slice(0, 10) }))
        .reverse()
      const recipe = getRecipeDetail(dish.recipeId)
      const visibleAttempts = this.data.showAllTimeline ? attempts : attempts.slice(0, 5)
      this.setData({
        dish,
        insights: getSignatureDishInsights(dish.recipeId),
        attempts,
        visibleAttempts,
        growthLabel: getGrowthLabel(dish.status),
        heroImage: dish.heroImageUrl || getRecipeImageForPage(dish.canonicalName, recipe?.coverUrl || ''),
        editForm: { personalName: dish.personalName, tagline: dish.tagline, story: dish.story },
        timelineToggleText: this.data.showAllTimeline ? '收起' : `查看全部 ${attempts.length} 次记录`,
      })
    },

    toggleTimeline() {
      const show = !this.data.showAllTimeline
      this.setData({
        showAllTimeline: show,
        visibleAttempts: show ? this.data.attempts : this.data.attempts.slice(0, 5),
        timelineToggleText: show ? '收起' : `查看全部 ${this.data.attempts.length} 次记录`,
      })
    },

    startEdit() { this.setData({ isEditing: true }) },
    cancelEdit() { this.setData({ isEditing: false }) },
    onEditInput(e: any) { this.setData({ [`editForm.${e.currentTarget.dataset.field}`]: e.detail.value }) },
    saveIdentity() {
      const dish = this.data.dish
      if (!dish) return
      const form = this.data.editForm
      const updated = updateSignatureDish(dish.id, {
        personalName: form.personalName.trim() || dish.canonicalName,
        tagline: form.tagline.trim(),
        story: form.story.trim(),
      })
      if (updated) {
        this.setData({ dish: updated, isEditing: false })
        wx.showToast({ title: '菜名与故事已保存', icon: 'success' })
      }
    },

    openQuickRecord() { this.setData({ showQuickRecord: true }) },
    closeQuickRecord() { this.setData({ showQuickRecord: false }) },
    selectQuickRating(e: WechatMiniprogram.TouchEvent) {
      this.setData({ quickRating: Number(e.currentTarget.dataset.value) || 0 })
    },
    toggleQuickTag(e: WechatMiniprogram.TouchEvent) {
      const tag = e.currentTarget.dataset.tag as string
      const quickTags = [...this.data.quickTags]
      const index = quickTags.indexOf(tag)
      if (index >= 0) quickTags.splice(index, 1)
      else quickTags.push(tag)
      this.setData({
        quickTags,
        quickTagChoices: this.data.quickTagChoices.map((item) => ({ ...item, selected: quickTags.includes(item.name) })),
      })
    },
    toggleQuickSatisfied() { this.setData({ quickSatisfied: !this.data.quickSatisfied }) },
    onQuickInput(e: any) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }) },
    chooseQuickImage() {
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['camera', 'album'],
        success: (res) => {
          const tempFilePath = res.tempFilePaths[0]
          wx.saveFile({
            tempFilePath,
            success: (saved) => this.setData({ quickImageUrl: saved.savedFilePath }),
            fail: () => this.setData({ quickImageUrl: tempFilePath }),
          })
        },
      })
    },
    saveQuickRecord() {
      const dish = this.data.dish
      if (!dish || this.data.quickSaving) return
      this.setData({ quickSaving: true })
      const result = saveCookingAttempt({
        recipeId: dish.recipeId,
        recipeName: dish.canonicalName,
        rating: this.data.quickRating,
        imageUrls: this.data.quickImageUrl ? [this.data.quickImageUrl] : [],
        note: this.data.quickNote,
        changeNote: this.data.quickChangeNote,
        resultTags: this.data.quickTags,
        diners: '',
        satisfied: this.data.quickSatisfied,
      })
      this.setData({
        showQuickRecord: false,
        quickSaving: false,
        quickRating: 0,
        quickTags: [],
        quickTagChoices: QUICK_TAGS.map((name) => ({ name, selected: false })),
        quickChangeNote: '',
        quickNote: '',
        quickSatisfied: false,
        quickImageUrl: '',
      })
      this.loadData(result.dish.id)
      wx.showToast({ title: `第 ${result.dish.cookCount} 次已记下`, icon: 'success' })
    },
    goRecipe() {
      const dish = this.data.dish
      if (dish) wx.navigateTo({ url: `/pages/recipe-detail/index?id=${encodeURIComponent(dish.recipeId)}` })
    },

    openConfirm() { this.setData({ showConfirm: true }) },
    closeConfirm() { this.setData({ showConfirm: false }) },
    confirmSignature() {
      const dish = this.data.dish
      if (!dish) return
      const updated = confirmSignatureDish(dish.id, this.data.editForm.personalName, this.data.editForm.tagline)
      if (updated) {
        this.setData({ dish: updated, growthLabel: getGrowthLabel(updated.status), showConfirm: false })
        wx.showToast({ title: '已成为你的拿手菜', icon: 'success' })
      }
    },
    setVisibility(e: WechatMiniprogram.TouchEvent) {
      const dish = this.data.dish
      if (!dish) return
      const visibility = e.currentTarget.dataset.visibility as 'private' | 'friends' | 'public'
      const updated = updateSignatureDish(dish.id, { visibility })
      if (updated) {
        this.setData({ dish: updated })
        wx.showToast({
          title: visibility === 'private' ? '仅自己可见' : visibility === 'friends' ? '家人好友可见' : '公开版可分享',
          icon: 'none',
        })
      }
    },
  },

  // @ts-ignore 页面组件运行时支持分享回调。
  onShareAppMessage() {
    const dish = this.data.dish
    return {
      title: `${dish?.personalName || '我的拿手菜'}：${dish?.tagline || '这是我的制作记录'}`,
      path: `/pages/signature-detail/index?id=${encodeURIComponent(dish?.id || '')}`,
      imageUrl: this.data.heroImage,
    }
  },
})
