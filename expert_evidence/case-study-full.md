# 案例说明(详细版)

## 项目概述

食光宝盒(foodie-vault):面向年轻用户的食材管理微信小程序,含前端、云函数与"庖丁解牛"内容后台
(B 站教程:发现 → 预检 → 处理 → 挑帧终审 → 审核 → 发布全流程,Docker 部署 + 运维文档)。
56 个 TS/JS 文件、约 13,800 行代码。全程用 Claude Code 开发,728 轮人机交互、16 个 commit。

## 任务拆解

1. **产品层**:先产出 `PRODUCT.md`(用户画像/品牌人格/设计原则),人工审定后才进入设计;
2. **设计层**:`DESIGN.md` 定义完整设计系统(OKLCH 色板、手绘肌理 token、定格动画 timing、组件规范),作为后续所有 UI 的契约;
3. **架构层**:小程序前端 / 云函数 / 内容后台三块;渠道抽象层隔离平台差异(bilibili 为首个适配器),新增渠道不动核心逻辑(commit 0c309f3 → 7308f76 两次迭代);
4. **任务状态机**:PROCESS/EXPORT 两阶段任务、人工挑帧终审(FRAMES_REVIEW)、OWNER/SYSTEM 双审核发布。

## 多轮人机交互调试(核心)

微信小程序平台兼容问题,每条都是"现象 → 定位 → 修复 → 沉淀"的完整循环,累计沉淀在 DESIGN.md「踩坑记录」:

- WXSS 不支持标签选择器/通配符/`inset` 简写/`:focus-within`(Skyline)——逐项试错后改用显式类名与展开写法;
- WXML 中 `arr.indexOf()` 静默失败——移到 JS 层预算;
- 拖拽入库:子元素 `bindtouchmove` 手指移出即断链——重构为页面级 `catchtouchmove/catchtouchend` 事件链 + `_dragStarted` 防误触。

## 代码审查

agent 产出一律先 review 再合入。代表:commit 8d187fb
"fix: address review issues — dead loop, redundant API call, ps=limit, parameterized SQL",
审查发现死循环、冗余接口调用、未参数化 SQL(注入风险),要求逐项修复并复看 diff。

## 测试验证

- 三个测试套件(validator / dictionary / tutorials,node:test),**22/22 通过**;
- 覆盖:manifest schema/哈希/版权校验、预检拒绝非教程、挑帧终审状态机(草稿持久化 LLM 推断、
  approvedIngredients 缺省回落)、updateTask 透出 processingStage、dispatch 失败兜底 FAILED、
  菜品模糊匹配、审核状态机与未授权版权拒发。

## 一次真实的事故与恢复(透明记录)

发布前用 `git filter-repo` 剥离 node_modules/素材包时,强制重写回滚了文件未提交的增量(5 个测试及配套 src)。
事后通过:①留存的测试名;②设计记忆文件;③已提交代码——三路信息**重建**了全部功能,22/22 恢复通过,
并以独立的 "restore:" commit 明确标注。该事故本身即是一次"人主导、agent 执行"的多轮调试与验证闭环。

---

# Case Study (English)

Built foodie-vault, a WeChat mini-program + content pipeline (~13.8k LOC, 56 TS/JS files), end-to-end
with Claude Code across 728 interaction rounds and 16 commits. I owned product definition,
architecture decisions, code review and acceptance; the agent implemented, refactored and wrote tests.

**Task decomposition**: PRODUCT.md (product spec) → DESIGN.md (full design system as contract) →
three-part architecture (mini-program / cloud functions / content backend) with a channel
abstraction layer (Bilibili as first adapter) and a PROCESS/EXPORT task state machine with
human frame review.

**Multi-round debugging**: platform quirks solved iteratively and documented in DESIGN.md's
pitfalls chapter (WXSS selector limits, WXML silent failures, page-level touch-event chain for
drag-and-drop).

**Code review**: every diff reviewed before merging; commit 8d187fb captures review-driven fixes
(dead loop, redundant API call, non-parameterized SQL → injection risk).

**Testing**: three suites, 22/22 passing — manifest validation, preflight rules, the
frame-review state machine (LLM-inferred draft fields, fallback logic), task progress surfacing,
dispatch failure handling, dish fuzzy matching, review state machine.

**Incident & recovery (transparent)**: a forced history rewrite to make the repo publishable
reset uncommitted work; the lost tests and src were reconstructed from surviving test names +
design memory + committed code, restored to 22/22, and clearly labeled in a dedicated commit.
