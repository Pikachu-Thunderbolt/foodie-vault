// pages/share/index.ts
import { confirmSignatureDish, ISignatureDish, saveCookingAttempt } from '../../utils/signature-dish'

const app = getApp<IAppOption>()

interface ICookingHistory {
  id: string
  recipeId: string
  recipeName: string
  imageUrl: string
  notes: string
  date: string
}

Component({
  data: {
    recipeId: '',
    recipeName: '',
    imageUrl: '',
    notes: '',
    showSharePreview: false,
    saved: false,
    rating: 0,
    ratingOptions: [1, 2, 3, 4, 5],
    changeNote: '',
    diners: '',
    satisfied: false,
    resultTags: [] as string[],
    resultTagChoices: ['很下饭', '火候正好', '偏咸', '偏淡', '下次再改'].map((name) => ({ name, selected: false })),
    candidateDish: null as ISignatureDish | null,
    showCandidate: false,
    personalName: '',
    tagline: '',
  },

  lifetimes: {
    attached() {
      this.loadRoute()
    },
  },

  pageLifetimes: {
    show() {
      // Skyline 下 options 在 attached 后才就绪时，再读取一次，避免丢失菜谱名。
      if (!this.data.recipeId || !this.data.recipeName) this.loadRoute()
    },
  },

  methods: {
    loadRoute() {
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1] as any
      const recipeId = currentPage.options?.recipeId || ''
      let recipeName = currentPage.options?.recipeName || ''
      try { recipeName = decodeURIComponent(recipeName) } catch (_) { /* 保留原始路由值 */ }

      this.setData({ recipeId, recipeName })
    },
    // 选择图片
    chooseImage() {
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['camera', 'album'],
        success: (res) => {
          const tempFilePath = res.tempFilePaths[0]
          // 成长档案会跨会话展示，不能长期引用随时可能失效的临时路径。
          wx.saveFile({
            tempFilePath,
            success: (saved) => this.setData({ imageUrl: saved.savedFilePath }),
            fail: () => this.setData({ imageUrl: tempFilePath }),
          })
        },
      })
    },

    // 输入心得
    onNotesInput(e: any) {
      this.setData({ notes: e.detail.value })
    },

    selectRating(e: WechatMiniprogram.TouchEvent) { this.setData({ rating: Number(e.currentTarget.dataset.value) || 0 }) },
    onChangeNoteInput(e: any) { this.setData({ changeNote: e.detail.value }) },
    onDinersInput(e: any) { this.setData({ diners: e.detail.value }) },
    toggleSatisfied() { this.setData({ satisfied: !this.data.satisfied }) },
    toggleResultTag(e: WechatMiniprogram.TouchEvent) {
      const tag = e.currentTarget.dataset.tag as string
      const tags = [...this.data.resultTags]
      const index = tags.indexOf(tag)
      if (index >= 0) tags.splice(index, 1)
      else tags.push(tag)
      this.setData({ resultTags: tags, resultTagChoices: this.data.resultTagChoices.map((item) => ({ ...item, selected: tags.includes(item.name) })) })
    },
    onPersonalNameInput(e: any) { this.setData({ personalName: e.detail.value }) },
    onTaglineInput(e: any) { this.setData({ tagline: e.detail.value }) },

    // 保存记录
    saveRecord() {
      if (!this.data.recipeId || !this.data.recipeName) {
        wx.showToast({ title: '菜谱信息尚未加载，请稍后再试', icon: 'none' })
        return
      }

      const history: ICookingHistory = {
        id: 'history_' + Date.now(),
        recipeId: this.data.recipeId,
        recipeName: this.data.recipeName,
        imageUrl: this.data.imageUrl,
        notes: this.data.notes,
        date: new Date().toISOString().split('T')[0],
      }

      const result = saveCookingAttempt({
        recipeId: this.data.recipeId, recipeName: this.data.recipeName, rating: this.data.rating,
        imageUrls: this.data.imageUrl ? [this.data.imageUrl] : [], note: this.data.notes, changeNote: this.data.changeNote,
        resultTags: this.data.resultTags, diners: this.data.diners, satisfied: this.data.satisfied,
      })
      // 继续维护旧字段，供尚未迁移的“我的”页面兼容读取；成长数据以 CookingAttempt 为准。
      const cookingHistory = app.globalData.cookingHistory || []
      cookingHistory.unshift(history)
      app.globalData.cookingHistory = cookingHistory
      wx.setStorageSync('cookingHistory', cookingHistory)
      this.setData({
        saved: true,
        candidateDish: result.dish,
        showCandidate: result.becameCandidate,
        personalName: result.dish.personalName || result.dish.canonicalName,
        tagline: result.dish.tagline || this.data.changeNote,
      })
      wx.showToast({ title: '这次下厨已记下', icon: 'success' })
    },

    dismissCandidate() { this.setData({ showCandidate: false }) },
    confirmCandidate() {
      const dish = this.data.candidateDish
      if (!dish) return
      const updated = confirmSignatureDish(dish.id, this.data.personalName, this.data.tagline)
      if (!updated) return
      this.setData({ showCandidate: false, candidateDish: updated })
      wx.showToast({ title: '已设为拿手菜', icon: 'success' })
      setTimeout(() => wx.navigateTo({ url: `/pages/signature-detail/index?id=${encodeURIComponent(updated.id)}` }), 500)
    },

    goSignatureDish() {
      const dish = this.data.candidateDish
      if (dish) wx.navigateTo({ url: `/pages/signature-detail/index?id=${encodeURIComponent(dish.id)}` })
    },

    // 预览分享卡片
    previewShare() {
      if (!this.data.imageUrl) {
        wx.showToast({ title: '请先记录烹饪成果', icon: 'none' })
        return
      }
      this.setData({ showSharePreview: true })
    },

    // 关闭预览
    closePreview() {
      this.setData({ showSharePreview: false })
    },

    // 分享给好友
    shareToFriend() {
      // 在小程序中通过微信分享API
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage'],
      })
      wx.showToast({ title: '请点击右上角分享', icon: 'none' })
    },

    // 返回首页
    goHome() {
      wx.switchTab({
        url: '/pages/index/index',
      })
    },
  },

  // 页面分享配置
  // @ts-ignore 小程序页面组件在运行时支持分享回调，旧版类型声明未收录该字段。
  onShareAppMessage() {
    return {
      title: `我用食光宝盒做了一道${this.data.recipeName}，快来学做吧！`,
      path: `/pages/recipe-detail/index?id=${this.data.recipeId}`,
      imageUrl: this.data.imageUrl || '',
    }
  },
})
