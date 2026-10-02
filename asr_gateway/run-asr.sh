#!/usr/bin/env bash
# AIDriveNote ASR Gateway macOS / Linux 便捷启动脚本
# 用法：ASR_API_KEY=xxx ./run-asr.sh
set -euo pipefail

# 切到脚本所在目录（asr_gateway）
cd "$(dirname "$0")"

# 若存在虚拟环境则激活
if [[ -d .venv ]]; then
  # shellcheck source=/dev/null
  source .venv/bin/activate
fi

# 网关侧变量（ASR_* 命名）；ASR_API_KEY 必须与后端 NOTE_ASR_REMOTE_API_KEY 一致
export ASR_API_KEY="${ASR_API_KEY:?请设置 ASR_API_KEY（需与后端 NOTE_ASR_REMOTE_API_KEY 一致）}"
export ASR_MODEL="${ASR_MODEL:-medium}"
export ASR_LANGUAGE="${ASR_LANGUAGE:-zh}"
# 有 GPU 用 cuda/float16；无 GPU 用 cpu/int8
export ASR_DEVICE="${ASR_DEVICE:-cpu}"
export ASR_COMPUTE_TYPE="${ASR_COMPUTE_TYPE:-int8}"
export ASR_PRELOAD="${ASR_PRELOAD:-1}"
# 国内拉取 Whisper 权重走镜像
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"
export PYTHONUNBUFFERED=1

exec uvicorn main:app --host 0.0.0.0 --port "${ASR_PORT:-8090}"