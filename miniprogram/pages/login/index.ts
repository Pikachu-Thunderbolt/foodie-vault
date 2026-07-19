// 打开冰箱 · 微信快捷登录：账号建档与头像昵称补充彻底分离。
import { loginWithProfile, isLoggedIn } from '../../utils/auth'

Component({
  data: {
    agreed: false,
    agreementError: false,
    submitting: false,
    loginSucceeded: false,
  },

  lifetimes: {
    attached() {
      if (isLoggedIn()) wx.switchTab({ url: '/pages/index/index' })
    },
  },

  methods: {
    onAgreementChange() {
      this.setData({ agreed: !this.data.agreed, agreementError: false })
    },

    viewAgreement() {
      wx.showModal({
        title: '用户协议',
        content: '食光宝盒仅用你的账号保存并同步食材、菜谱收藏和做菜记录。你可以在「我的」中管理或清除数据。',
        showCancel: false,
        confirmText: '我知道了',
      })
    },

    viewPrivacy() {
      wx.showModal({
        title: '隐私政策',
        content: '首次登录只创建账号，不会请求头像和昵称。你可在进入小厨房后自主选择是否完善这些资料。',
        showCancel: false,
        confirmText: '我知道了',
      })
    },

    async onSubmit() {
      if (this.data.submitting) return
      if (!this.data.agreed) {
        this.setData({ agreementError: true })
        return
      }

      this.setData({ submitting: true, agreementError: false })
      try {
        // login 云函数通过 wx.getWXContext() 取得用户身份；首次调用会创建默认档案。
        // 头像、昵称留待用户进入“我的”后主动补充，不作为登录条件。
        // 不传头像或昵称，避免旧授权链路把空头像误判为“请选择头像”。
        await loginWithProfile()
        this.setData({ loginSucceeded: true })
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 760)
      } catch (err: any) {
        console.error('[login] failed', err)
        wx.showToast({ title: err?.message || '打开小厨房失败，请重试', icon: 'none' })
        this.setData({ submitting: false })
      }
    },
  },
})
