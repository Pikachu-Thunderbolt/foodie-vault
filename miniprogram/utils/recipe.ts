// utils/recipe.ts - 菜谱数据与推荐算法
import { getIngredientNames, getExpiringIngredients } from './storage'
import { RECIPES } from '../data/mock-data'

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

interface RecommendOptions {
  servings?: number
  maxDuration?: number
  difficulty?: string
  taste?: string
  category?: string
}

// 基于用户食材匹配菜谱
export function getRecipesByIngredients(
  ingredientNames?: string[],
  options?: RecommendOptions
): { recipe: IRecipe; matchRate: number; matchedIngredients: string[] }[] {
  const userIngredients =
    ingredientNames && ingredientNames.length > 0
      ? ingredientNames
      : getIngredientNames()

  if (userIngredients.length === 0) {
    return getRecommendedRecipes(options).map((r) => ({
      recipe: r,
      matchRate: 0,
      matchedIngredients: [],
    }))
  }

  const results: { recipe: IRecipe; matchRate: number; matchedIngredients: string[] }[] = []
  const userLower = userIngredients.map((name) => name.toLowerCase())

  RECIPES.forEach((recipe) => {
    const recipeIngredients = recipe.ingredients.map((name) => name.toLowerCase())
    const matched: string[] = []

    recipeIngredients.forEach((ing) => {
      const originalName = recipe.ingredients[recipeIngredients.indexOf(ing)]
      if (userLower.some((u) => ing.includes(u) || u.includes(ing))) {
        matched.push(originalName)
      }
    })

    const matchRate = recipeIngredients.length > 0
      ? matched.length / recipeIngredients.length
      : 0

    // 至少匹配一种食材
    if (matchRate > 0) {
      // 应用筛选条件
      if (options) {
        if (options.servings && recipe.servings !== options.servings) return
        if (options.maxDuration && recipe.duration > options.maxDuration) return
        if (options.difficulty && options.difficulty !== 'any' && recipe.difficulty !== options.difficulty) return
        if (options.taste && options.taste !== 'any' && recipe.taste !== options.taste) return
        if (options.category && options.category !== 'any' && recipe.category !== options.category) return
      }
      results.push({ recipe, matchRate, matchedIngredients: matched })
    }
  })

  // 排序：临期食材优先 > 匹配度高 > 额外食材少
  const expiringNames = getExpiringIngredients().map((i) => i.name.toLowerCase())

  results.sort((a, b) => {
    // 优先匹配临期食材的菜谱
    const aHasExpiring = a.matchedIngredients.some((name) =>
      expiringNames.some((e) => name.includes(e) || e.includes(name))
    )
    const bHasExpiring = b.matchedIngredients.some((name) =>
      expiringNames.some((e) => name.includes(e) || e.includes(name))
    )
    if (aHasExpiring && !bHasExpiring) return -1
    if (!aHasExpiring && bHasExpiring) return 1

    // 按匹配度降序
    if (a.matchRate !== b.matchRate) return b.matchRate - a.matchRate

    // 按额外食材数量升序
    return a.recipe.extraIngredients.length - b.recipe.extraIngredients.length
  })

  return results
}

// 获取推荐菜谱（无食材匹配时）
export function getRecommendedRecipes(options?: RecommendOptions): IRecipe[] {
  let recipes = [...RECIPES]

  if (options) {
    if (options.servings) recipes = recipes.filter((r) => r.servings === options.servings)
    const maxDuration = options.maxDuration
    if (maxDuration) recipes = recipes.filter((r) => r.duration <= maxDuration)
    if (options.difficulty && options.difficulty !== 'any')
      recipes = recipes.filter((r) => r.difficulty === options.difficulty)
    if (options.taste && options.taste !== 'any')
      recipes = recipes.filter((r) => r.taste === options.taste)
    if (options.category && options.category !== 'any')
      recipes = recipes.filter((r) => r.category === options.category)
  }

  return recipes
}

// 获取菜谱详情
export function getRecipeDetail(id: string): IRecipe | undefined {
  return RECIPES.find((r) => r.id === id)
}

// 获取所有菜谱分类
export function getRecipeCategories(): string[] {
  return [...new Set(RECIPES.map((r) => r.category))]
}

// 搜索菜谱
export function searchRecipes(keyword: string): IRecipe[] {
  const kw = keyword.toLowerCase()
  return RECIPES.filter(
    (r) =>
      r.name.toLowerCase().includes(kw) ||
      r.ingredients.some((i) => i.toLowerCase().includes(kw)) ||
      r.category.includes(kw)
  )
}

// 获取菜谱总数
export function getRecipeCount(): number {
  return RECIPES.length
}
