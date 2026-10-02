# AIDriveNote ASR Gateway（局域网语音转写网关）

本目录是 AIDriveNote 的**独立**语音转写网关：把 faster-whisper 部署在一台带 GPU
（或较强 CPU）的机器上，通过 HTTP 对外提供转写能力。AIDriveNote 后端在
`NOTE_ASR_MODE=remote` 时调用它，从而避免把 Whisper 跑在应用服务器上。

- 接口契约：`GET /health`、`POST /api/v1/transcribe`（multipart：`file`、`language?`、`model_size?`）
- 鉴权：请求头 `X-API-Key`，缺失或配置为空时 **fail-closed 直接拒绝**（503/401）
- 环境变量沿用网关自身的 `ASR_*` 命名（与后端 `NOTE_ASR_*` 是两套，互不冲突）

## 1. 前置条件

- Python 3.11 或 3.12
- **ffmpeg（必装）**：录音多为 webm/opus，无 ffmpeg 会转写失败或卡住
  - macOS：`brew install ffmpeg`
  - Ubuntu：`sudo apt-get install -y ffmpeg`
  - Windows：`choco install ffmpeg -y`，并用 `where.exe ffmpeg` 验证
- 有 NVIDIA GPU 时安装驱动，`nvidia-smi` 可用；纯 CPU 也可运行（用 `cpu/int8` + 小模型）
- 防火墙入站放通服务端口（默认 **TCP 8090** 或 compose 中的 **8091**）

## 2. 安装

```bash
cd asr_gateway
python -m venv .venv
source .venv/bin/activate          # Windows: .\.venv\Scripts\Activate.ps1

# 国内镜像安装依赖
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple

# 国内拉取 Whisper 权重（走镜像）
export HF_ENDPOINT=https://hf-mirror.com
export HF_HUB_DISABLE_XET=1
# medium 需按需下载；首次启动也会自动下载
```

## 3. 启动

选一组与硬件匹配的参数：

| 硬件 | ASR_DEVICE | ASR_COMPUTE_TYPE | ASR_MODEL 建议 |
|------|-----------|------------------|----------------|
| NVIDIA GPU（显存充足） | `cuda` | `float16` | `medium`（默认）/ `large-v3` |
| NVIDIA GPU（显存较小） | `cuda` | `float16` | `small` |
| 纯 CPU / 无 GPU | `cpu` | `int8` | `small` / `medium`（较慢） |

```bash
# 方式一：脚本启动（macOS / Linux）
ASR_API_KEY=<你的密钥> ASR_DEVICE=cpu ASR_COMPUTE_TYPE=int8 ./run-asr.sh

# 方式二：手动启动
export ASR_API_KEY=<你的密钥>        # 必填，需与后端 NOTE_ASR_REMOTE_API_KEY 一致
export ASR_MODEL=medium
export ASR_LANGUAGE=zh
export ASR_DEVICE=cuda               # 无 GPU 改为 cpu
export ASR_COMPUTE_TYPE=float16      # 无 GPU 改为 int8
uvicorn main:app --host 0.0.0.0 --port 8090
```

Windows 可直接用 `run-asr.bat`（请先修改其中的安装目录与密钥）。

GPU 显存参考：

| 模型 | 显存 | 说明 |
|------|------|------|
| small | ~2GB | 更快，精度一般 |
| medium（默认） | ~5GB | 推荐 |
| large-v3 | ~10GB | 需 ≥12GB 显存 |

CUDA 不可用时服务会自动回退 `cpu/int8`（慢，仅兜底）。

## 4. 验证

```bash
# health（HTTP 200 且返回模型/设备信息）
curl -sf -H "X-API-Key: <ASR_API_KEY>" http://<网关IP>:8090/health

# 单文件转写
curl -X POST http://<网关IP>:8090/api/v1/transcribe \
  -H "X-API-Key: <ASR_API_KEY>" \
  -F "file=@test.wav" \
  -F "language=zh"
```

期望响应：

```json
{
  "segments": [
    {"start": 0.0, "end": 3.5, "text": "...", "confidence": 0.9, "language": "zh"}
  ]
}
```

> Windows PowerShell 请用 `curl.exe`，不要用 `curl`（会被别名成 Invoke-WebRequest）。

## 5. AIDriveNote 后端配置

在服务器 `.env` 中设置（backend 服务已透传这些变量，见 `docker-compose.prod.yml`）：

```env
NOTE_ASR_MODE=remote
NOTE_ASR_REMOTE_URL=http://<网关IP>:8090/api/v1/transcribe
NOTE_ASR_REMOTE_API_KEY=<与 ASR_API_KEY 相同>
NOTE_ASR_REMOTE_TIMEOUT=3600
NOTE_ASR_FALLBACK_LOCAL=false
# local 兜底/降级时的本机参数（无 GPU 用 cpu/int8）
NOTE_WHISPER_MODEL=medium
NOTE_WHISPER_LANGUAGE=zh
NOTE_WHISPER_DEVICE=cpu
NOTE_WHISPER_COMPUTE_TYPE=int8
```

改完后重建/重启 backend 容器：

```bash
docker compose -f docker-compose.prod.yml up -d --build backend
```

## 6. 容器化部署（可选）

`docker-compose.prod.yml` 中提供了一段**注释掉的** `asr_gateway` 服务示例，
取消注释即可把网关照常纳入 compose 编排（默认映射端口 `8091`，避免与应用端口冲突）。