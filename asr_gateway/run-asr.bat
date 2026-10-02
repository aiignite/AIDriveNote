@echo off
REM AIDriveNote ASR Gateway Windows 便捷启动脚本
REM 请按本机实际安装目录修改下面的工作目录与 .venv 路径
cd /d C:\aidrivenote-asr
set "PATH=C:\ProgramData\chocolatey\bin;%PATH%"
REM pip 安装的 nvidia-*-cu12 包内的 CUDA DLL
set "PATH=C:\aidrivenote-asr\.venv\Lib\site-packages\nvidia\cublas\bin;%PATH%"
set "PATH=C:\aidrivenote-asr\.venv\Lib\site-packages\nvidia\cuda_runtime\bin;%PATH%"
set "PATH=C:\aidrivenote-asr\.venv\Lib\site-packages\nvidia\cudnn\bin;%PATH%"
REM 网关侧变量（ASR_* 命名）；ASR_API_KEY 必须与后端 NOTE_ASR_REMOTE_API_KEY 一致
set ASR_API_KEY=<你的ASR_API_KEY>
set ASR_MODEL=medium
set ASR_LANGUAGE=zh
set ASR_DEVICE=cuda
set ASR_COMPUTE_TYPE=float16
set ASR_PRELOAD=1
set HF_ENDPOINT=https://hf-mirror.com
set HF_HUB_DISABLE_XET=1
set PYTHONUNBUFFERED=1
echo ===== ASR start %date% %time% =====>> C:\aidrivenote-asr\asr.log
where ffmpeg >> C:\aidrivenote-asr\asr.log 2>&1
.venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8090 >> C:\aidrivenote-asr\asr.log 2>&1