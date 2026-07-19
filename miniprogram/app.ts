// app.ts
import { bootstrap } from './utils/cloud'
import { ensureLoginRoute } from './utils/auth'

interface IIngredient {
  id: string;
  masterId?: string;
  canonicalName?: string;
  name: string;
  brand?: string;
  variant?: string;
  category: string;
  purchaseDate: string;
  expiryDate: string;
  quantity: number;
  unit: string;
  storageLocation: string;
  status: 'fresh' | 'expiring' | 'expired';
  imageUrl?: string;
  notes?: string;
}

interface IRecipe {
  id: string;
  name: string;
  coverUrl: string;
  ingredients: string[];
  extraIngredients: string[];
  steps: { desc: string; imageUrl?: string }[];
  duration: number;
  difficulty: 'easy' | 'medium' | 'hard';
  servings: number;
  taste: string;
  category: string;
  equipment: string[];
  tips: string;
}

interface ICookingHistory {
  id: string;
  recipeId: string;
  recipeName: string;
  imageUrl: string;
  notes: string;
  date: string;
}

interface IUserPreferences {
  dietaryRestrictions: string[];
  tastePreference: string;
  difficultyLevel: string;
  reminderDays: number;
  gender: 'male' | 'female' | 'couple' | 'family' | '';
}

interface IAppOption {
  globalData: {
    ingredients: IIngredient[];
    cookingHistory: ICookingHistory[];
    favoriteRecipes: string[];
    userPreferences: IUserPreferences;
    searchIngredient: string;
  };
}

App<IAppOption>({
  globalData: {
    ingredients: [],
    cookingHistory: [],
    favoriteRecipes: [],
    userPreferences: {
      dietaryRestrictions: [],
      tastePreference: 'any',
      difficultyLevel: 'any',
      reminderDays: 2,
      gender: '',
    },
    searchIngredient: '',
    isLoggedIn: false,
  },
  onLaunch() {
    // 1. 初始化云开发（auth.ts 也会兜底 init；这里先 ensure 一次）
    if (wx.cloud) {
      wx.cloud.init({
        env: 'foodie-vault-cloud-d7c230e4c1807',
        traceUser: true,
      })
    }

    // 2. 从本地加载缓存数据（保留作为离线 fallback / 首屏立即可见）
    const ingredients = wx.getStorageSync('ingredients') || []
    const cookingHistory = wx.getStorageSync('cookingHistory') || []
    const favoriteRecipes = wx.getStorageSync('favoriteRecipes') || []
    const userPreferences = wx.getStorageSync('userPreferences') || {
      dietaryRestrictions: [],
      tastePreference: 'any',
      difficultyLevel: 'any',
      reminderDays: 2,
      gender: '',
    }

    this.globalData.ingredients = ingredients
    this.globalData.cookingHistory = cookingHistory
    this.globalData.favoriteRecipes = favoriteRecipes
    this.globalData.userPreferences = userPreferences
    this.globalData.isLoggedIn = !!wx.getStorageSync('_openid_cache')

    // 3. 启动云端引导（不阻塞首屏，内部用微任务异步执行耗时部分）
    bootstrap().catch((err) => console.warn('[bootstrap]', err))

    // 4. 未登录路由守卫：未登录时延迟一帧 reLaunch 到登录页
    ensureLoginRoute()
  },
})
