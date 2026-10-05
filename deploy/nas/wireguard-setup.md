# AIDriveNote — WireGuard 配置模板
#
# 拓扑：
#   腾讯云 <DEPLOY_HOST>  →  10.10.0.1
#   绿联 NAS  192.168.1.181  →  10.10.0.2
#
# 用途：双向访问
#   云端 → NAS : nginx 反代到 10.10.0.2:3270
#   NAS  → 云端 : 访问 Ollama(11434) 与 asr_gateway(8090)
#
# ⚠️ 生成密钥后请勿把私钥提交到 git

# ══════════════════════════════════════════════════════
# 一次性初始化（在任意 Linux 机器上执行）
# ══════════════════════════════════════════════════════
#
#   # 云端密钥
#   wg genkey | tee server_private | wg pubkey > server_public
#
#   # NAS 密钥
#   wg genkey | tee nas_private   | wg pubkey > nas_public
#
#   # 交换公钥后填入下方配置
#   cat server_public nas_public

# ══════════════════════════════════════════════════════
# 云服务器端：/etc/wireguard/wg0.conf
# ══════════════════════════════════════════════════════
[Interface]
Address = 10.10.0.1/24
ListenPort = 51820
PrivateKey = <云端私钥 server_private 内容>
# 允许 NAS 通过隧道访问云端已启用的服务
SaveConfig = false

# NAS peer
[Peer]
PublicKey = <NAS 公钥 nas_public 内容>
AllowedIPs = 10.10.0.2/32
PersistentKeepalive = 25

# 启动
#   systemctl enable --now wg-quick@wg0
#   wg show  # 确认握手
#
# 验证（从云端 ping NAS）：
#   ping -c3 10.10.0.2

# ══════════════════════════════════════════════════════
# NAS 端：${NAS_DATA_ROOT}/wireguard/wg_confs/wg0.conf
# （linuxserver/wireguard 镜像约定路径）
# ══════════════════════════════════════════════════════
[Interface]
Address = 10.10.0.2/24
PrivateKey = <NAS 私钥 nas_private 内容>
SaveConfig = false
Table = off

[Peer]
PublicKey = <云端公钥 server_public 内容>
Endpoint = <DEPLOY_HOST>:51820
AllowedIPs = 10.10.0.0/24
PersistentKeepalive = 25

# 启动
#   docker compose -f docker-compose.nas.yml up -d wireguard
#   docker logs note_wireguard
#
# 验证（从 NAS ping 云端）：
#   docker exec note_wireguard ping -c3 10.10.0.1
#   docker exec note_wireguard curl -s http://10.10.0.1:8090/health

# ══════════════════════════════════════════════════════
# 云端需放行的服务（确保监听 0.0.0.0 而非 127.0.0.1）
# ══════════════════════════════════════════════════════
#
# Ollama
#   sudo systemctl edit ollama
#   [Service]
#   Environment="OLLAMA_HOST=0.0.0.0:11434"
#   sudo systemctl restart ollama
#   # 或用防火墙限制：只允许 10.10.0.2 访问 11434
#   sudo ufw allow from 10.10.0.2 to any port 11434 proto tcp
#
# asr_gateway
#   compose 中 ports 需从 "127.0.0.1:8091:8090"
#   改为 "10.10.0.1:8090:8090"（只绑 WireGuard 接口）
#
# 云端 nginx 反代到 NAS
#   修改 deploy/nginx/aiignite-note.conf：
#     proxy_pass http://127.0.0.1:3270;  →  proxy_pass http://10.10.0.2:3270;
#   （两处 location 都需改；SSE 段的缓冲关闭参数必须保留）

# ══════════════════════════════════════════════════════
# 排障
# ══════════════════════════════════════════════════════
#
# 隧道不通，按序检查：
#   1. 云安全组放行 UDP 51820
#   2. 云服务器本地防火墙放行：
#      sudo ufw allow 51820/udp
#   3. wg show（云端）确认 latest handshake 时间在更新
#   4. docker exec note_wireguard ping -c3 10.10.0.1
#   5. AllowedIPs 是否正确（两侧不能冲突）
#
# 握手成功但应用连不上：
#   - Ollama 监听地址是否为 0.0.0.0
#   - compose ports 是否绑到了 10.10.0.1 而非 127.0.0.1
#   - NAS 出网是否被路由器防火墙拦截
