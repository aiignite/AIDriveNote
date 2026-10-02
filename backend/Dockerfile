FROM python:3.12-slim

# ffmpeg/ffprobe：语音转写链路依赖——remote 模式上传前把浏览器录音（webm/opus）
# 转成 16k 单声道 wav，同时用于读取录音时长。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple -r requirements.txt
COPY . .

EXPOSE 3275
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3275"]
