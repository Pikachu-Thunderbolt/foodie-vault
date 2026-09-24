# expert_evidence — coding agent 深度使用证据

项目:食光宝盒(foodie-vault)——微信小程序 + 内容生产管线,56 个 TS/JS 文件、约 13,800 行代码。
全程使用 Claude Code 命令行 coding agent 开发:两个长期会话累计 **728 轮人机交互**、16 个里程碑 commit。
提交人角色:产品定义、架构决策、代码审查与验收;agent 角色:实现、重构与测试编写。

## 本目录文件

| 文件 | 内容 |
|---|---|
| `case-study-en-500.txt` | ≤500 字符英文案例说明(平台提交用) |
| `case-study-full.md` | 详细案例说明(中英对照) |
| `git-log-with-stats.txt` | 全部提交历史 + 变更统计 |
| `review-fix-commit-diff.txt` | 代码审查驱动修复的完整 diff(commit 8d187fb:死循环、冗余调用、SQL 参数化) |
| `test-output-22-pass.txt` | node:test 全量运行输出,22/22 通过 |

## 其他可验证材料(体积原因未入库,可另行提供)

- **728 轮完整会话记录**:本机 `~/.claude/projects/-Users-yaojiawei-WeChatProjects-foodie-vault/` 下的 jsonl(约 11MB),含每一次工具调用与时间戳
- **设计契约文档**:仓库内 `DESIGN.md`(设计系统 + 微信小程序兼容性"踩坑记录"章节,即多轮调试的结构化沉淀)
- **产品定义文档**:仓库内 `PRODUCT.md`

## 仓库历史说明(透明起见)

为使仓库可发布,曾用 `git filter-repo` 从历史中剥离 `node_modules/` 与大型素材包(1.19 GiB → 21.9 MiB),
全部 14 个开发 commit 保留。该操作回滚了个别文件的未提交增量,其中「素材终审/dispatch」一批已依据
留存的测试名与设计记忆**重建**并明确标注(见 "restore:" commit);`chore:`/`restore:` 两个 commit 为
发布与恢复所需,不属于开发里程碑。
