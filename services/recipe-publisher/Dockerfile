# 单容器：Node 控制面/UI/发布 + 内嵌 Python 引擎 worker + ffmpeg。
# Node 为主进程，spawn 并守护 worker 子进程；同容器共享文件系统，manifest 交接无需共享云盘。
FROM node:20-bookworm-slim

WORKDIR /app

# python3 + ffmpeg：引擎需要（bilibili 下载合流、Whisper、关键帧、WebP）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# —— Node 依赖 ——
COPY package.json ./
RUN npm install --omit=dev

# —— Python 依赖（引擎）——
COPY worker/requirements.txt ./worker/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r worker/requirements.txt

# —— 源码 ——
COPY src ./src
COPY worker ./worker

# 预下载并缓存 whisper 模型，避免首个任务冷启动拉取。
ARG WHISPER_MODEL=base
ENV WHISPER_MODEL=${WHISPER_MODEL}
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV EMBED_WORKER=true
ENV HOST=0.0.0.0
ENV PORT=8080
ENV PAODING_API_BASE=http://127.0.0.1:8080
ENV INGEST_ROOT=/data/recipe-ingest/outgoing
ENV PAODING_EXPORT_ROOT=/data/recipe-ingest/outgoing
ENV PAODING_DATA_DIR=/data/paoding-work
ENV WATCH_INGEST_ROOT=true

EXPOSE 8080
CMD ["node", "src/server.js"]
