from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = Field(..., min_length=1)
    DATABASE_URL_SYNC: str = Field(..., min_length=1)

    SECRET_KEY: str = Field(..., min_length=32)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 14

    APP_NAME: str = "AIDriveNote"
    DEBUG: bool = False
    CORS_ORIGINS: str = "http://localhost:3270"
    API_DOCS_ENABLED: bool = True

    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5"
    OLLAMA_EMBED_MODEL: str = "nomic-embed-text"
    AI_PROVIDER: str = "ollama"

    # ── RAG v2：pgvector 分块检索 ──
    # 关闭时回退 v1（整篇向量 + JSONB 扫描）；PostgreSQL 未装 pgvector 时自动降级
    RAG_V2_ENABLED: bool = True
    # 单块目标字符数（中文约等于 token 量级）
    RAG_V2_CHUNK_SIZE: int = 600
    # 相邻块重叠字符数，避免答案被切在块边界
    RAG_V2_CHUNK_OVERLAP: int = 80
    # 向量 / 全文各自的候选数量，融合后再取 top_k
    RAG_V2_CANDIDATES: int = 40

    # ── RAG 重排（可选）──
    # 对接 cross-encoder rerank 服务；未启用或调用失败时自动跳过
    RERANK_ENABLED: bool = False
    RERANK_URL: str = ""
    RERANK_MODEL: str = "BAAI/bge-reranker-v2-m3"
    RERANK_TIMEOUT: int = 8
    # 参与重排的候选数量（也是检索 SQL 的取回上限）
    RERANK_CANDIDATES: int = 20

    # ── MCP 客户端 ──
    # 是否允许连接内网 / 本机 MCP 服务器；默认关闭以防 SSRF
    MCP_ALLOW_PRIVATE_HOSTS: bool = False
    # stdio 传输允许启动的可执行文件（按 basename 前缀匹配，逗号分隔）
    MCP_STDIO_ALLOWED_COMMANDS: str = "python,python3,uvx,npx,node"

    ANTHROPIC_API_KEY: str | None = None
    OPENAI_API_KEY: str | None = None
    MINIMAX_API_KEY: str | None = None

    ADMIN_EMAIL: str | None = None

    # ── AI 联网搜索（免 Key 网页抓取）──
    # 是否启用联网搜索工具；默认关闭，需在 .env 显式开启后重启服务
    AI_WEB_SEARCH_ENABLED: bool = False
    # 单次搜索请求超时（秒）
    AI_WEB_SEARCH_TIMEOUT: int = 10
    # 单次搜索返回结果条数上限
    AI_WEB_SEARCH_MAX_RESULTS: int = 5

    SSO_ENABLED: bool = False
    SSO_SECRET_KEY: str | None = None
    SSO_ISSUER: str = "aidriveall"
    SSO_COOKIE_NAME: str = "aidrive_token"
    # SSO 登录是否为首次出现的用户自动建号；公网测试部署应关闭，
    # 仅允许管理员预先创建的账号通过 portal 登录
    SSO_AUTO_CREATE_USERS: bool = True

    # ── 公网测试部署防护 ──
    # 是否开放自助注册（邮箱验证码三步流程）；测试部署建议 false，
    # 账号一律由管理员在后台创建，未开放时前端隐藏注册入口
    SELF_REGISTRATION_ENABLED: bool = True
    # 每个用户笔记数量上限（含回收站）；0 表示不限制
    USER_MAX_NOTES: int = 100
    # 单个上传文件大小上限（笔记图片资产 / AI 对话附件）
    USER_MAX_UPLOAD_BYTES: int = 2 * 1024 * 1024
    # 文档笔记原文件上限；与 nginx client_max_body_size 26m 对齐（留 multipart 余量）
    USER_MAX_DOCUMENT_BYTES: int = 25 * 1024 * 1024

    # ── 匿名登录（Guest）──
    # 是否开放匿名登录入口；关闭后 /auth/guest 返回 403，前端隐藏按钮
    GUEST_LOGIN_ENABLED: bool = True
    # 离线宽限期（分钟）：匿名用户超过该时长无任何请求即被后台任务物理清除
    GUEST_IDLE_TIMEOUT_MINUTES: int = 30
    # 清除任务扫描间隔（秒）；同时作为 last_seen_at 的落库节流间隔
    GUEST_PURGE_INTERVAL_SECONDS: int = 300
    # 匿名用户的独立笔记配额（低于普通用户的 USER_MAX_NOTES，防止被用来囤积存储）
    GUEST_MAX_NOTES: int = 50
    # 是否记录匿名登录事件（登录信息与会话生命周期，仅元数据）
    GUEST_EVENTS_ENABLED: bool = True

    # 笔记版本历史
    # 每篇笔记保留的修订条数上限；超出后按时间淘汰最旧的（恢复前快照不参与淘汰）
    NOTE_REVISION_KEEP: int = 50
    # 标签建议是否调用 LLM 对候选做二次筛选（默认关闭，开启后按次计费）
    NOTE_TAG_SUGGEST_LLM: bool = False

    # ── 知识入库 / 蒸馏 ──
    KNOWLEDGE_INGEST_ENABLED: bool = True
    KNOWLEDGE_DISTILL_ENABLED: bool = True
    # AI 平台中的模型 ref/name；留空则使用用户默认模型，最后回退 Ollama
    KNOWLEDGE_DISTILL_MODEL: str = ""
    # 是否允许把内容发送到商用模型；默认关闭，首次使用需显式开启
    KNOWLEDGE_DISTILL_ALLOW_EXTERNAL: bool = False
    # 出站前脱敏邮箱/手机号
    KNOWLEDGE_DISTILL_REDACT: bool = True
    # 每用户每日蒸馏次数上限；0 表示不限制
    KNOWLEDGE_DISTILL_DAILY_LIMIT: int = 100
    # 送入模型的原文上限（头 8k + 均分采样）
    KNOWLEDGE_DISTILL_MAX_INPUT_CHARS: int = 12000
    KNOWLEDGE_DISTILL_TIMEOUT: int = 45
    # 合并建议阈值；默认动作仍是新建
    KNOWLEDGE_MERGE_THRESHOLD: float = 0.82
    # 单个源文档最多生成的卡片数（日报等可拆多张）
    KNOWLEDGE_MAX_CARDS: int = 3
    # KB 上传/邮件是否自动进入蒸馏管线
    KNOWLEDGE_AUTO_INGEST_KB_UPLOAD: bool = True
    KNOWLEDGE_AUTO_INGEST_EMAIL: bool = True
    # 摘要合成块在 RRF 排序中的微提升
    KNOWLEDGE_SUMMARY_CHUNK_BOOST: float = 0.03

    # ── 笔记录音语音转写（faster-whisper / 远程 asr_gateway）──
    # Whisper 模型规格；机器较弱可改为 small
    NOTE_WHISPER_MODEL: str = "medium"
    # 转写主语言；留空则由 Whisper 自动检测
    NOTE_WHISPER_LANGUAGE: str = "zh"
    # 并发转写任务上限；默认 1（串行，避免 CPU 峰值）
    NOTE_WHISPER_MAX_CONCURRENT: int = 1
    # ASR 模式：local（本机 faster-whisper）| remote（局域网 GPU asr_gateway）
    NOTE_ASR_MODE: str = "remote"
    # 远程 ASR HTTP 端点，例如 http://172.16.17.66:8090/api/v1/transcribe
    NOTE_ASR_REMOTE_URL: str = ""
    # 与 asr_gateway 共享的 X-API-Key（空则不发鉴权头）
    NOTE_ASR_REMOTE_API_KEY: str = ""
    # 远程转写超时（秒）；长录音需调大
    NOTE_ASR_REMOTE_TIMEOUT: int = 3600
    # 远程失败时是否降级到本机 CPU 转写
    NOTE_ASR_FALLBACK_LOCAL: bool = False
    # local 模式设备/精度
    NOTE_WHISPER_DEVICE: str = "cpu"
    NOTE_WHISPER_COMPUTE_TYPE: str = "int8"
    # 静音切分阈值 (dB)
    NOTE_SPLIT_SILENCE_DB: float = -40
    # 静音持续判定 (秒)
    NOTE_SPLIT_SILENCE_DURATION: float = 0.5
    # 单段硬切上限 (秒)；超过则强制切分
    NOTE_SPLIT_MAX_SEGMENT_SECONDS: int = 60
    # 最小分块秒数：silencedetect 切出的 < 该值的窗口会合并到上一个
    NOTE_SPLIT_MIN_SEGMENT_SECONDS: float = 3.0
    # 单个录音文件大小上限 (bytes) — 默认 25MB（500MB 可在 2 核小机上被滥用拖垮转写与磁盘）
    NOTE_MAX_RECORDING_BYTES: int = 26_214_400
    # 说话人分离（默认关闭）
    NOTE_ENABLE_SPEAKER_DIARIZATION: bool = False
    # 转写段落合并参数（规则层，LLM 润色前后各执行一次）
    NOTE_MERGE_MIN_PARAGRAPH_CHARS: int = 80
    NOTE_MERGE_MAX_PARAGRAPH_CHARS: int = 400
    NOTE_MERGE_SOFT_PAUSE_SECONDS: float = 3.0
    NOTE_MERGE_HARD_PAUSE_SECONDS: float = 4.0
    # 语音整理/润色默认模型；为空则走 AI 平台模型解析（DB 模型 → env Ollama 兜底）
    NOTE_AI_MODEL: str = ""

    # ── 邮件发送（QQ SMTP，与 AIDriveAll 保持一致的配置项命名）──
    # 留空则「发送到邮箱」功能不可用，前端会提示未配置
    EMAIL_HOST: str = "smtp.qq.com"
    EMAIL_PORT: int = 465
    EMAIL_USER: str = ""
    EMAIL_PASS: str = ""
    EMAIL_FROM: str = ""
    # 465 走隐式 SSL(SMTP_SSL)，否则按 starttls 处理
    EMAIL_USE_SSL: bool = True
    # true 时只记日志不发信，用于本地验证流程
    EMAIL_MOCK: bool = True

    # ── 邮箱验证码（注册确认，参照 AIIgnitePLM）──
    # 验证码有效期（分钟）
    EMAIL_CODE_TTL_MINUTES: int = 10
    # 验证码位数
    EMAIL_CODE_LENGTH: int = 6
    # 同一邮箱同用途两次发码的最小间隔（秒）
    EMAIL_CODE_SEND_COOLDOWN_SECONDS: int = 60
    # 单个验证码允许的最大错误尝试次数，超过后作废需重新获取
    EMAIL_CODE_MAX_VERIFY_ATTEMPTS: int = 5

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()
