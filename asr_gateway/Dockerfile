# AIDriveNote ASR Gateway 容器镜像（CPU 版）
#
# 用途：在无 GPU 的服务器上以独立容器提供 Whisper 语音转写，
#       供 AIDriveNote 后端以 NOTE_ASR_MODE=remote 调用。
#
# 设计取舍：
#   - 仅装 CPU 依赖，不装 requirements.txt 里的 CUDA 运行库（可省数百 MB 镜像体积）；
#   - 装 ffmpeg，因为浏览器录音为 webm/opus，需先转 16k 单声道 wav；
#   - 构建期预下载 Whisper 权重（国内走 hf-mirror），
#     避免容器首次启动才发现网络不可达。
FROM python:3.12-slim

# ffmpeg：把 webm/opus 转成 16k 单声道 wav（faster-whisper 的前置步骤）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python 依赖（阿里云镜像加速）；显式列出 CPU 版依赖，避免拉入 CUDA 包。
# numpy 用于承接 ffmpeg 解码后的波形数组（见 transcription.py 的 PyAV 兼容说明）。
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple \
      "fastapi>=0.115.0" \
      "uvicorn[standard]>=0.32.0" \
      "python-multipart>=0.0.9" \
      "faster-whisper>=1.0.0" \
      "numpy>=1.26" \
      "pydantic>=2.0" \
      "httpx>=0.27.0"

# 国内拉取 Whisper 权重走 hf-mirror；关闭 Xet 强制走经典 HTTP 下载
ENV HF_ENDPOINT=https://hf-mirror.com \
    HF_HUB_DISABLE_XET=1 \
    PYTHONUNBUFFERED=1

# 预下载权重（可通过 --build-arg ASR_PRELOAD_MODEL=base 换更小规格）
ARG ASR_PRELOAD_MODEL=small
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${ASR_PRELOAD_MODEL}', device='cpu', compute_type='int8')"

COPY . .

EXPOSE 8090
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]