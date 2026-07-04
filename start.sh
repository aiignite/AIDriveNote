#!/usr/bin/env bash

# AIDriveNote Start Script
# Frontend:  http://localhost:3270
# Backend:   http://localhost:3275
# API Docs:  http://localhost:3275/docs

if [ -z "${BASH_VERSION:-}" ] || shopt -oq posix 2>/dev/null; then
    echo "请使用 bash 运行 start.sh，例如: bash ./start.sh 或 ./start.sh"
    exit 1
fi

set -euo pipefail

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_DIR="$SCRIPT_DIR/.runtime-logs"
BACKEND_LOG="$LOG_DIR/backend-start.log"
FRONTEND_LOG="$LOG_DIR/frontend-start.log"
BACKEND_PID=""
FRONTEND_PID=""

BACKEND_PORT=3275
FRONTEND_PORT=3270

mkdir -p "$LOG_DIR"

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}Starting AIDriveNote Application${NC}"
echo -e "${BLUE}================================================${NC}"

# Check if necessary tools are available
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python3 is not installed${NC}"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed${NC}"
    exit 1
fi

show_log_tail() {
    local label=$1
    local log_file=$2

    if [ -f "$log_file" ]; then
        echo -e "${YELLOW}---- ${label} 最近日志 (${log_file}) ----${NC}"
        tail -n 40 "$log_file" || true
        echo -e "${YELLOW}----------------------------------------${NC}"
    else
        echo -e "${YELLOW}${label} 日志文件不存在: ${log_file}${NC}"
    fi
}

check_and_kill_backend_reload_processes() {
    local pids
    pids=$(ps -ax -o pid=,command= | awk '
      index($0, "uvicorn app.main:app") && index($0, "--port '"$BACKEND_PORT"'") { print $1 }
    ')

    if [ -z "$pids" ]; then
      return
    fi

    echo -e "${YELLOW}⚠️  检测到残留的 backend uvicorn --reload 进程，正在清理 (PID: $pids)...${NC}"

    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    done <<< "$pids"

    for _ in {1..5}; do
      local remaining
      remaining=$(ps -ax -o pid=,command= | awk '
        index($0, "uvicorn app.main:app") && index($0, "--port '"$BACKEND_PORT"'") { print $1 }
      ')
      if [ -z "$remaining" ]; then
        break
      fi
      sleep 1
    done

    local remaining
    remaining=$(ps -ax -o pid=,command= | awk '
      index($0, "uvicorn app.main:app") && index($0, "--port '"$BACKEND_PORT"'") { print $1 }
    ')
    if [ -n "$remaining" ]; then
      echo -e "${YELLOW}⚠️  backend uvicorn 残留进程仍存在，升级为强制停止...${NC}"
      while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        pkill -KILL -P "$pid" 2>/dev/null || true
        kill -9 "$pid" 2>/dev/null || true
      done <<< "$remaining"
      sleep 1
    fi
}

cleanup() {
    echo ""
    echo -e "${BLUE}Shutting down services...${NC}"
    kill "$BACKEND_PID" 2>/dev/null || true
    kill "$FRONTEND_PID" 2>/dev/null || true
    echo -e "${GREEN}✓ All services stopped${NC}"
    exit 0
}

# Function to check and kill process using a port
check_and_kill_port() {
    local port=$1
    local pids
    pids=$(lsof -nP -tiTCP:$port -sTCP:LISTEN 2>/dev/null || true)

    if [ -n "$pids" ]; then
        echo -e "${YELLOW}⚠️  端口 $port 被占用，正在停止监听进程 (PID: $pids)...${NC}"
        echo "$pids" | xargs kill 2>/dev/null || true

        for _ in {1..5}; do
            if ! lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
                break
            fi
            sleep 1
        done

        if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
            echo -e "${YELLOW}⚠️  端口 $port 仍未释放，升级为强制停止...${NC}"
            echo "$pids" | xargs kill -9 2>/dev/null || true
            sleep 1
        fi

        if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
            echo -e "${RED}❌ 无法释放端口 $port${NC}"
            exit 1
        fi

        echo -e "${GREEN}✓ 端口 $port 已释放${NC}"
    fi
}

# Check and free ports before starting
echo -e "${BLUE}检查端口占用情况...${NC}"
check_and_kill_backend_reload_processes
check_and_kill_port "$FRONTEND_PORT"
check_and_kill_port "$BACKEND_PORT"

# Start Backend
echo -e "${GREEN}Starting Backend on port ${BACKEND_PORT}...${NC}"
cd "$SCRIPT_DIR/backend"

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo -e "${YELLOW}未找到 backend/.env，已从 .env.example 复制${NC}"
        cp .env.example .env
    else
        echo -e "${YELLOW}⚠️  未找到 backend/.env，请手动配置 DATABASE_URL${NC}"
    fi
fi

if ! python3 -c "import uvicorn" 2>/dev/null; then
    echo -e "${RED}❌ uvicorn 未安装，请先安装依赖: cd backend && pip install -r requirements.txt${NC}"
    exit 1
fi

(
  cd "$SCRIPT_DIR/backend"
  python3 -m uvicorn app.main:app --host 0.0.0.0 --port "$BACKEND_PORT" --reload
) > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
echo -e "${GREEN}✓ Backend started (PID: $BACKEND_PID)${NC}"
echo -e "${BLUE}Backend log: ${BACKEND_LOG}${NC}"

echo "Waiting for backend to be ready..."
for i in {1..30}; do
  if curl -s "http://localhost:${BACKEND_PORT}/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Backend is ready${NC}"
    break
  fi

  if [ $i -eq 30 ]; then
    echo -e "${RED}❌ Backend did not respond in time${NC}"
    show_log_tail "Backend" "$BACKEND_LOG"
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
  fi

  sleep 1
done

# Start Frontend
echo -e "${GREEN}Starting Frontend on port ${FRONTEND_PORT}...${NC}"
cd "$SCRIPT_DIR/frontend"

if [ ! -d "node_modules" ]; then
    echo "Installing npm dependencies..."
    npm install > /dev/null 2>&1
fi

VITE_BIN="$SCRIPT_DIR/frontend/node_modules/.bin/vite"
if [ ! -f "$VITE_BIN" ]; then
    echo -e "${YELLOW}Installing vite...${NC}"
    npm install > /dev/null 2>&1
fi

(
  cd "$SCRIPT_DIR/frontend"
  "$VITE_BIN" --port "$FRONTEND_PORT" --host 0.0.0.0
) > "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!
echo -e "${GREEN}✓ Frontend started (PID: $FRONTEND_PID)${NC}"
echo -e "${BLUE}Frontend log: ${FRONTEND_LOG}${NC}"

echo "Waiting for frontend to be ready..."
for i in {1..30}; do
  if curl -s "http://localhost:${FRONTEND_PORT}/" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Frontend is ready${NC}"
    break
  fi

  if [ $i -eq 30 ]; then
    echo -e "${RED}❌ Frontend did not respond in time${NC}"
    show_log_tail "Frontend" "$FRONTEND_LOG"
    kill "$BACKEND_PID" 2>/dev/null || true
    kill "$FRONTEND_PID" 2>/dev/null || true
    exit 1
  fi

  sleep 1
done

echo -e "${BLUE}================================================${NC}"
echo -e "${GREEN}✓ All services started successfully!${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""
echo -e "Frontend:     ${GREEN}http://localhost:${FRONTEND_PORT}${NC}"
echo -e "Backend:      ${GREEN}http://localhost:${BACKEND_PORT}${NC}"
echo -e "API Docs:     ${GREEN}http://localhost:${BACKEND_PORT}/docs${NC}"
echo -e "AI Settings:  ${GREEN}http://localhost:${FRONTEND_PORT}/settings/ai${NC}"
echo -e "Backend Log:  ${GREEN}${BACKEND_LOG}${NC}"
echo -e "Frontend Log: ${GREEN}${FRONTEND_LOG}${NC}"
echo ""
echo -e "${YELLOW}提示: 首次运行请确保 PostgreSQL 已创建数据库 ai_drive_note${NC}"
echo -e "${YELLOW}      cd backend && alembic upgrade head${NC}"
echo ""
echo "Press Ctrl+C to stop all services..."
echo ""

trap cleanup SIGINT SIGTERM

wait
