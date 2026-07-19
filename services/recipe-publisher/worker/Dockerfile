FROM python:3.12-slim

WORKDIR /app

# ffmpeg 供下载合流与关键帧抽取；引擎相对 data 目录以 PAODING_DATA_DIR 为工作目录。
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 内置引擎（原庖丁解牛 src 的 vendored 副本）+ worker 控制面入口
COPY worker ./worker

# 预下载并缓存 whisper 模型，避免首个任务时冷启动拉取（可用 WHISPER_MODEL 覆盖）。
ARG WHISPER_MODEL=base
ENV WHISPER_MODEL=${WHISPER_MODEL}
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

ENV PYTHONUNBUFFERED=1
ENV PAODING_DATA_DIR=/data/paoding-work
ENV PAODING_EXPORT_ROOT=/data/recipe-ingest/outgoing

# 默认循环领取任务；也可用 `python worker/discovery_push.py` 跑发现。
CMD ["python", "worker/paoding_worker.py"]
