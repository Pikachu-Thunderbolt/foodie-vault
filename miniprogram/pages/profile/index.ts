// pages/profile/index.ts
import { getIngredientStats } from '../../utils/storage'
import { getSignatureDishes, migrateLegacyCookingHistory } from '../../utils/signature-dish'
import { getCurrentUser, logout } from '../../utils/auth'

const app = getApp<IAppOption>()

interface ICookingHistory {
  id: string
  recipeId: string
  recipeName: string
  imageUrl: string
  notes: string
  date: string
}

interface IUserPreferences {
  dietaryRestrictions: string[]
  tastePreference: string
  difficultyLevel: string
  reminderDays: number
  gender: 'male' | 'female' | 'couple' | 'family' | ''
}

Component({
  data: {
    avatarUrl: '',
    nickName: '厨房主人',
    cloudAvatarUrl: '',
    openid: '',
    isLoggedIn: false,
    stats: { total: 0, fresh: 0, expiring: 0, expired: 0 },
    historyList: [] as ICookingHistory[],
    recordCount: 0,
    favoriteCount: 0,
    showPreferences: false,
    preferences: {
      dietaryRestrictions: [] as string[],
      tastePreference: 'any',
      difficultyLevel: 'any',
      reminderDays: 2,
      gender: '' as 'male' | 'female' | 'couple' | 'family' | '',
    } as IUserPreferences,
    dietaryOptions: ['无', '素食', '清真', '无麸质', '低碳水'],
    tastePickerOptions: ['不限', '清淡', '微辣', '麻辣', '酸甜', '咸香'],
    tastePickerValues: ['any', '清淡', '微辣', '麻辣', '酸甜', '咸香'],
    tastePickerIndex: 0,
    difficultyPickerOptions: ['不限', '简单', '中等', '较难'],
    difficultyPickerValues: ['any', 'easy', 'medium', 'hard'],
    difficultyPickerIndex: 0,
    showExportMenu: false,
    signatureCount: 0,
    practicingCount: 0,
    candidateCount: 0,
  },

  lifetimes: {
    attached() {
      this.loadData()
    },
  },

  pageLifetimes: {
    show() {
      this.loadData()
    },
  },

  methods: {
    loadData() {
      const stats = getIngredientStats()
      const history = app.globalData.cookingHistory || []
      const favorites = app.globalData.favoriteRecipes || []
      migrateLegacyCookingHistory()
      const signatureDishes = getSignatureDishes()
      const prefs = app.globalData.userPreferences || {
        dietaryRestrictions: [],
        tastePreference: 'any',
        difficultyLevel: 'any',
        reminderDays: 2,
        gender: '',
      }
      const tastePickerIndex = Math.max(0, this.data.tastePickerValues.indexOf(prefs.tastePreference))
      const difficultyPickerIndex = Math.max(0, this.data.difficultyPickerValues.indexOf(prefs.difficultyLevel))

      // 从 auth 缓存里读真实用户档案
      const user = getCurrentUser()
      const isLoggedIn = !!user
      // cloud:// 路径需要换临时 URL 才可显示
      this.resolveAvatar(user?.avatarUrl || '')

      this.setData({
        stats,
        historyList: history.slice(0, 10),
        recordCount: history.length,
        favoriteCount: favorites.length,
        preferences: prefs,
        tastePickerIndex,
        difficultyPickerIndex,
        signatureCount: signatureDishes.filter((item) => item.status === 'signature' || item.status === 'family-classic').length,
        practicingCount: signatureDishes.filter((item) => item.status !== 'signature' && item.status !== 'family-classic').length,
        candidateCount: signatureDishes.filter((item) => item.candidate).length,
        isLoggedIn,
        nickName: user?.nickname?.trim() || '厨房主人',
        openid: user?.openid || '',
      })
    },

    /** cloud:// 文件 ID → 临时 URL */
    resolveAvatar(avatarUrl: string) {
      if (!avatarUrl) {
        this.setData({ cloudAvatarUrl: '' })
        return
      }
      if (avatarUrl.startsWith('cloud://')) {
        wx.cloud.getTempFileURL({
          fileList: [avatarUrl],
          success: (res) => {
            const url = res.fileList?.[0]?.tempFileURL || ''
            this.setData({ cloudAvatarUrl: url })
          },
          fail: () => this.setData({ cloudAvatarUrl: '' }),
        })
      } else {
        this.setData({ cloudAvatarUrl: avatarUrl })
      }
    },

    /** 点击头像区：已登录则提示，未登录则跳登录页 */
    onAvatarTap() {
      if (!this.data.isLoggedIn) {
        wx.reLaunch({ url: '/pages/login/index' })
        return
      }
      wx.showActionSheet({
        itemList: ['重新选头像', '修改昵称', '退出登录'],
        success: (res) => {
          if (res.tapIndex === 0) wx.reLaunch({ url: '/pages/login/index' })
          if (res.tapIndex === 1) wx.reLaunch({ url: '/pages/login/index' })
          if (res.tapIndex === 2) this.onLogout()
        },
      })
    },

    onLogout() {
      wx.showModal({
        title: '退出登录',
        content: '退出后会清除本机的头像/昵称缓存，下次打开需重新授权。本地食材/菜谱数据不会被删除。',
        confirmText: '退出',
        confirmColor: '#C44A2A',
        success: (res) => {
          if (res.confirm) logout()
        },
      })
    },

    // 切换偏好设置
    togglePreferences() {
      this.setData({ showPreferences: !this.data.showPreferences })
    },

    // 偏好变更
    onDietaryToggle(e: any) {
      const { item } = e.currentTarget.dataset
      let dietary = [...this.data.preferences.dietaryRestrictions]
      const idx = dietary.indexOf(item)
      if (idx >= 0) dietary.splice(idx, 1)
      else dietary.push(item)
      this.setData({ 'preferences.dietaryRestrictions': dietary })
    },

    onTasteChange(e: any) {
      const tastePickerIndex = Number(e.detail.value)
      this.setData({
        tastePickerIndex,
        'preferences.tastePreference': this.data.tastePickerValues[tastePickerIndex],
      })
    },

    onDifficultyChange(e: any) {
      const difficultyPickerIndex = Number(e.detail.value)
      this.setData({
        difficultyPickerIndex,
        'preferences.difficultyLevel': this.data.difficultyPickerValues[difficultyPickerIndex],
      })
    },

    onReminderDaysInput(e: any) {
      this.setData({ 'preferences.reminderDays': parseInt(e.detail.value) || 1 })
    },

    onGenderSelect(e: WechatMiniprogram.TouchEvent) {
      const gender = e.currentTarget.dataset.gender as
        | 'male' | 'female' | 'couple' | 'family' | ''
      this.setData({ 'preferences.gender': gender })
    },

    // 保存偏好
    savePreferences() {
      app.globalData.userPreferences = this.data.preferences
      wx.setStorageSync('userPreferences', this.data.preferences)
      this.setData({ showPreferences: false })
      wx.showToast({ title: '偏好已保存', icon: 'success' })
    },

    // 导出数据
    toggleExportMenu() {
      this.setData({ showExportMenu: !this.data.showExportMenu })
    },

    exportData() {
      const allIngredients = wx.getStorageSync('ingredients') || []
      const dataStr = JSON.stringify(allIngredients, null, 2)

      wx.setClipboardData({
        data: dataStr,
        success: () => {
          wx.showToast({ title: '数据已复制到剪贴板', icon: 'success' })
        },
      })
      this.setData({ showExportMenu: false })
    },

    // 跳转菜谱详情
    goRecipeDetail(e: any) {
      const { id } = e.currentTarget.dataset
      wx.navigateTo({
        url: `/pages/recipe-detail/index?id=${id}`,
      })
    },

    // 查看全部历史
    viewAllHistory() {
      wx.navigateTo({ url: '/pages/signature-dishes/index' })
    },

    goSignatureDishes() { wx.navigateTo({ url: '/pages/signature-dishes/index' }) },

    // 查看食材清单
    viewIngredientList() {
      wx.switchTab({ url: '/pages/checklist/index' })
    },

    // 查看临期食材
    viewExpiryReminders() {
      if (this.data.stats.expiring === 0) {
        wx.showToast({ title: '目前没有临期食材', icon: 'none' })
        return
      }
      wx.switchTab({ url: '/pages/index/index' })
    },

    // 关于
    showAbout() {
      wx.showModal({
        title: '食光宝盒',
        content: '版本 1.0.0\n\n一款聚焦食材全生命周期管理的微信小程序。\n\n核心理念：减少食物浪费，让每一份食材都物尽其用。',
        showCancel: false,
        confirmText: '好的',
      })
    },

    // 清除所有本地业务数据（注意：云端用户数据不受影响；如需清云端，请在「退出登录」后用测试账号登录）
    clearAllData() {
      wx.showModal({
        title: '确认清除',
        content: '此操作将清除本机的食材、菜谱、做菜记录等业务数据。云端用户数据不受影响。',
        confirmText: '确认清除',
        confirmColor: '#FF4D4F',
        success: (res) => {
          if (res.confirm) {
            // 只清业务 key，保留 _openid_cache / _user_cache / _last_sync_at / _migrated_v1 等用户系统 key
            const businessKeys = [
              'ingredients',
              'ingredient_masters',
              'ingredient_transactions',
              'cooking_sessions',
              'cooking_attempts',
              'signature_dishes',
              'pantry_product_profiles',
              'shoppingChecklist',
              'cookingHistory',
              'favoriteRecipes',
              'userPreferences',
            ]
            businessKeys.forEach((k) => wx.removeStorageSync(k))
            app.globalData.ingredients = []
            app.globalData.cookingHistory = []
            app.globalData.favoriteRecipes = []
            this.loadData()
            wx.showToast({ title: '本地数据已清除', icon: 'success' })
          }
        },
      })
    },
  },
})
