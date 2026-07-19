# 庖丁解牛 Worker

这是从原 `庖丁解牛` Python 项目迁入的执行面（引擎 vendored 在 `engine/`）。默认作为**单容器内嵌子进程**由上层 Node 主进程（`src/supervisor.js`）spawn 并守护；也可用 `worker/Dockerfile` 作为独立容器单独部署。它只负责重型任务：下载、ASR、步骤/食材抽取、候选关键帧、按选定帧打包。挑帧的人工审核在 Node Dashboard（系统教程）或小程序（用户教程）完成。

## 已迁入的强约束

- 只接受 `platform=bilibili` 的 BV 号；不支持其它站点或原始文件上传。
- worker 必须先调用 `POST /v1/processing-tasks/claim`；该接口会再次检查 `preflight.verdict=PASSED`，否则任务不可领取、不可下载。
- 原始视频仅供处理，不向小程序分发；小程序只消费审核通过的结构化教程、食材和教程帧。

## 原项目模块映射

| 原庖丁解牛模块 | 云端职责 | 新控制面状态 |
| --- | --- | --- |
| `discover_cooking.py` / `add_video.py` | 拉取 B 站候选元数据 | `PREFLIGHT_PENDING` → `PREFLIGHT_PASSED` |
| `download.py` | 仅预检通过后下载 | `DOWNLOADING` |
| `transcribe.py` | Whisper ASR | `TRANSCRIBING` |
| `extract_steps.py` | LLM 结构化食材/步骤 | `EXTRACTING` |
| `extract_frames.py` / `export.py` | 教程帧、WebP、manifest | `PACKAGING` |
| `review.py` | 审批界面能力 | 上层 `/dashboard` 教程库和审核 API |

## 部署

**引擎已内置**：原庖丁解牛的 `src/` 已 vendored 到 `worker/engine/`，镜像构建时随 `COPY worker` 一起打包，无需外部挂载。生产运行不需要设置 `PAODING_LEGACY_ROOT`；仅本地迁移期想直接复用原项目未打包的 `src/` 时，才把它设为原项目根目录（`_load_engine()` 会优先走该路径）。

关键运行时变量：`PAODING_API_BASE`、`INGEST_API_TOKEN`、`PAODING_WORKER_ID` 连接控制面；`PAODING_EXPORT_ROOT` 指向与控制面共享的发布目录；`PAODING_DATA_DIR` 为引擎中间产物（SQLite/视频/转写/帧）的可写工作目录；`WHISPER_MODEL` 选 ASR 模型；`LLM_PROVIDER/LLM_MODEL/LLM_BASE_URL/LLM_API_KEY` 选结构化抽取的大模型（云端默认 OpenAI 兼容国产模型，本地可切 anthropic）。不要把 B站 Cookie、模型密钥写进 manifest 或小程序端。

容器默认常驻轮询领取任务（`run_forever`）；单次调试用 `python worker/paoding_worker.py --once`。发现候选并推送控制面预检：`python worker/discovery_push.py --source food_3day --limit 30`（不下载，只登记+预检）。

处理完成顺序：生成不可变 package → `POST /v1/packages` 上传 → `POST /v1/tutorials/{tutorialId}/versions` 登记版本。系统教程自动进入系统审核；用户教程先进入所有者审核，申请分享/公开才会新建系统审核请求。
