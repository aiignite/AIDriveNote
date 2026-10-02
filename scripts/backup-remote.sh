#!/usr/bin/env bash
# ==============================================================================
# 文件级注释：AIDriveNote 远程业务数据备份脚本
#
# 用途：服务器重装 / 迁移 / 换机前，把“无法从代码重建”的数据与配置导出并拉回本地，
#       避免重装操作系统后数据永久丢失。
#
# 备份内容（5 类）：
#   1) db.sql.gz            PostgreSQL 逻辑备份（用户 / 笔记 / 录音元数据等）
#   2) uploads.tar.gz       uploads 数据卷（用户上传文件、录音音频）
#   3) server.env           服务器 .env（DB 密码、SECRET_KEY、SSO / ASR 密钥）
#   4) docker-compose.prod.yml  服务器当前实际使用的编排文件
#   5) nginx-etc.tar.gz / letsencrypt.tar.gz  宿主机 nginx 配置与 TLS 证书
#
# 用法：bash scripts/backup-remote.sh
# 依赖：本地 sshpass、rsync；服务器 docker + docker compose + 免密 sudo
# 注意：产物含密钥，已落在工作区之外（避免被 deploy-remote.sh 同步回服务器），
#       且对敏感文件自动收紧权限为 600，请勿提交到 git。
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 读取部署配置（与发布脚本共用同一份 scripts/deploy.env）
CONFIG="${AIDRIVENOTE_DEPLOY_CONFIG:-$ROOT/scripts/deploy.env}"
if [[ -f "$CONFIG" ]]; then
  # shellcheck source=/dev/null
  source "$CONFIG"
fi

HOST="${AIDRIVENOTE_DEPLOY_HOST:?请设置 AIDRIVENOTE_DEPLOY_HOST（见 scripts/deploy.env）}"
USER="${AIDRIVENOTE_DEPLOY_USER:-ubuntu}"
REMOTE_PATH="${AIDRIVENOTE_DEPLOY_PATH:-/home/ubuntu/AIDriveNote}"
# 本地落地目录：默认放在工作区同级目录，避免被发布脚本再次推回服务器
LOCAL_OUT="${AIDRIVENOTE_BACKUP_DIR:-$(dirname "$ROOT")/_AIDriveNote_backup}"
STAMP="$(date +%Y%m%d-%H%M%S)"
CENTRAL_DIR="note_backup_${STAMP}"

# ------------------------------------------------------------------------------
# 函数级注释：ssh_cmd —— 在服务器执行命令
# 有 AIDRIVENOTE_SSH_PASS 且本地装了 sshpass 时用密码登录，否则回退到 SSH 密钥
# 参数：$@ —— 要传给远程 shell 的命令字符串
# ------------------------------------------------------------------------------
ssh_cmd() {
  if [[ -n "${AIDRIVENOTE_SSH_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$AIDRIVENOTE_SSH_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${USER}@${HOST}" "$@"
  else
    ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${USER}@${HOST}" "$@"
  fi
}

# ------------------------------------------------------------------------------
# 函数级注释：rsync_ssh —— 生成 rsync 使用的远程 shell 参数
# 返回：可作为 rsync -e 参数的字符串
# ------------------------------------------------------------------------------
rsync_ssh() {
  if [[ -n "${AIDRIVENOTE_SSH_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
    echo "sshpass -p '$AIDRIVENOTE_SSH_PASS' ssh -o StrictHostKeyChecking=no"
  else
    echo "ssh -o StrictHostKeyChecking=no"
  fi
}

echo "==> 目标服务器: ${USER}@${HOST}:${REMOTE_PATH}"
echo "==> 本地落地目录: ${LOCAL_OUT}/${CENTRAL_DIR}"
mkdir -p "${LOCAL_OUT}"

# 取得远端 HOME 绝对路径（rsync 远程路径中 ~ 不可靠，统一用绝对路径）
REMOTE_HOME="$(ssh_cmd 'echo $HOME')"

# ------------------------------------------------------------------------------
# 第一步：在服务器侧集中产出全部备份产物
# 远程脚本以 'REMOTE_SCRIPT'（不插值）传入，参数经 $1/$2 传递，规避引号嵌套问题
# ------------------------------------------------------------------------------
echo "==> [服务器] 导出数据库 / uploads 卷 / .env / compose / nginx ..."
ssh_cmd "bash -s -- '${CENTRAL_DIR}' '${REMOTE_PATH}'" <<'REMOTE_SCRIPT'
set -euo pipefail
CENTRAL_DIR="$1"
REMOTE_PATH="$2"
cd "$REMOTE_PATH"

OUT="$HOME/$CENTRAL_DIR"
mkdir -p "$OUT"

# 1) 数据库逻辑备份：pg_dump 借 MVCC 输出一致性快照，无需停机
#    连接参数直接复用 postgres 容器内的环境变量，避免依赖本地解析 .env
#    注意：必须重定向 < /dev/null，否则 exec -T 会吞掉本 heredoc 尚未读取的脚本内容
echo "  - 数据库 pg_dump ..."
docker compose -f docker-compose.prod.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /dev/null | gzip > "$OUT/db.sql.gz"

# 2) uploads 数据卷：动态定位卷名后，用已有 postgres 镜像挂载并打包（无需拉新镜像）
echo "  - uploads 数据卷 ..."
UPLOADS_VOL="$(docker volume ls --format '{{.Name}}' | grep -E '_uploads_data$' | head -1 || true)"
if [ -z "$UPLOADS_VOL" ]; then
  echo "  ! 未找到 uploads 数据卷" >&2
  exit 1
fi
docker run --rm -v "$UPLOADS_VOL":/data:ro -v "$OUT":/backup postgres:16-alpine \
  tar czf /backup/uploads.tar.gz -C /data .

# 3) 服务器 .env（含密钥，重装后必须原样放回）
echo "  - server.env ..."
cp .env "$OUT/server.env"

# 4) 服务器当前实际使用的编排文件（可能与本地工作区版本不同）
echo "  - docker-compose.prod.yml ..."
cp docker-compose.prod.yml "$OUT/docker-compose.prod.yml"

# 5) 宿主机 nginx 配置与 TLS 证书（免密 sudo）
echo "  - nginx 配置与证书 ..."
sudo tar czf "$OUT/nginx-etc.tar.gz" -C / etc/nginx 2>/dev/null || true
sudo tar czf "$OUT/letsencrypt.tar.gz" -C / etc/letsencrypt 2>/dev/null || true

# 汇总清单
echo "  - 产物清单:"
ls -lh "$OUT"
REMOTE_SCRIPT

# ------------------------------------------------------------------------------
# 第二步：把产物拉回本地
# ------------------------------------------------------------------------------
echo "==> [本地] 拉取备份产物..."
rsync -avz \
  -e "$(rsync_ssh)" \
  "${USER}@${HOST}:${REMOTE_HOME}/${CENTRAL_DIR}/" \
  "${LOCAL_OUT}/${CENTRAL_DIR}/"

# ------------------------------------------------------------------------------
# 第三步：本地完整性校验 + 权限收紧
# ------------------------------------------------------------------------------
DEST="${LOCAL_OUT}/${CENTRAL_DIR}"
echo "==> [本地] 校验产物..."

if gzip -t "${DEST}/db.sql.gz" 2>/dev/null; then
  echo "  [OK] db.sql.gz 可解压"
else
  echo "  [警告] db.sql.gz 校验失败" >&2
fi

if tar -tzf "${DEST}/uploads.tar.gz" >/dev/null 2>&1; then
  UPLOAD_COUNT="$(tar -tzf "${DEST}/uploads.tar.gz" | wc -l | tr -d ' ')"
  echo "  [OK] uploads.tar.gz 可解包，共 ${UPLOAD_COUNT} 个条目"
else
  echo "  [警告] uploads.tar.gz 校验失败" >&2
fi

# 含密钥/私钥的文件收紧权限
chmod 600 "${DEST}/server.env" 2>/dev/null || true
chmod 600 "${DEST}/letsencrypt.tar.gz" 2>/dev/null || true

echo ""
echo "==> 备份完成，产物位于: ${DEST}"
ls -lh "${DEST}"
echo ""
echo "提示："
echo "  1. 该目录含密钥与证书私钥，请勿提交 git、勿上传到公开位置。"
echo "  2. 重装后恢复顺序：装 Docker → 放回 server.env → rsync 代码 → compose up --build"
echo "     → alembic upgrade head → 导入 db.sql.gz → 解包 uploads.tar.gz 到数据卷"
echo "     → 恢复 nginx-etc.tar.gz / letsencrypt.tar.gz。"