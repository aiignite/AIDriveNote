# AIDriveNote MCP Server

把外部 AI Agent（Claude Desktop、Cursor、Trae 等）检索到的文档，通过 MCP 协议写入你的 AIDriveNote 笔记。

```
Claude Desktop / Cursor / Trae
        │  stdio（MCP）
        ▼
aidrivenote-mcp      ← 运行在你本机
        │  HTTPS + 个人访问令牌
        ▼
AIDriveNote 后端 /api/v1
```

## 一、先获取访问令牌

1. 打开笔记应用，进入 **设置 → 访问令牌**。
2. 点击「新建令牌」，填写名称（如 `Claude Desktop`）并选择有效期。
3. 复制形如 `adn_xxxxxxxxxxxxxxxxxxxx` 的明文令牌 —— **它只显示一次**，请立即保存。

> 令牌等同账号长期通行证：只粘贴到本机 MCP 配置中，不要提交到公开仓库；怀疑泄露时到同一页面撤销即可。

## 二、安装

### 方式一：uvx 免安装（推荐）

已安装 [uv](https://docs.astral.sh/uv/) 时，客户端会在启动时自动拉取并运行，无需手动安装。直接跳到「三、配置客户端」。

国内网络建议先设置镜像：

```bash
export UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
```

### 方式二：pipx 安装（推荐用于私有仓库 / 离线环境）

```bash
# 在仓库根目录执行
pipx install --pip-args "-i https://pypi.tuna.tsinghua.edu.cn/simple" ./mcp-server
```

### 方式三：uv 本地虚拟环境（开发调试）

```bash
cd mcp-server
uv venv
uv pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -e .
```

### 方式四：pip 安装到当前解释器

```bash
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -e ./mcp-server
```

安装完成后可直接运行（无令牌时会打印中文配置指引）：

```bash
aidrivenote-mcp
```

## 三、配置客户端

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "aidrivenote": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/aiignite/AIDriveNote.git@main#subdirectory=mcp-server",
        "aidrivenote-mcp"
      ],
      "env": {
        "AIDRIVENOTE_BASE_URL": "https://www.aiignite.com.cn/note/api/v1",
        "AIDRIVENOTE_API_TOKEN": "adn_替换为你的令牌"
      }
    }
  }
}
```

### Cursor

编辑项目内 `.cursor/mcp.json`（或全局 `~/.cursor/mcp.json`），内容同上。

### 用 pipx 安装后的配置

把 `command` 换成已安装的可执行文件：

```json
{
  "mcpServers": {
    "aidrivenote": {
      "command": "aidrivenote-mcp",
      "env": {
        "AIDRIVENOTE_BASE_URL": "https://www.aiignite.com.cn/note/api/v1",
        "AIDRIVENOTE_API_TOKEN": "adn_替换为你的令牌"
      }
    }
  }
}
```

### 开发调试（免安装，直接用源码）

```json
{
  "mcpServers": {
    "aidrivenote": {
      "command": "uv",
      "args": [
        "run",
        "--directory",
        "/Users/wyh/Documents/AIDriveAll/AIDriveNote/mcp-server",
        "aidrivenote-mcp"
      ],
      "env": {
        "AIDRIVENOTE_API_TOKEN": "adn_替换为你的令牌"
      }
    }
  }
}
```

### 本地开发后端

把地址指向本地服务，并在 `backend/.env` 中确认 CORS 允许来源：

```json
"AIDRIVENOTE_BASE_URL": "http://localhost:3275/api/v1"
```

## 四、环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AIDRIVENOTE_API_TOKEN` | 是 | — | 设置 → 访问令牌 生成的 `adn_...` 令牌 |
| `AIDRIVENOTE_BASE_URL` | 否 | `https://www.aiignite.com.cn/note/api/v1` | 后端 API 根地址 |
| `AIDRIVENOTE_TIMEOUT` | 否 | `30` | 单次请求超时（秒） |

## 五、可用工具

| 工具 | 说明 |
|------|------|
| `create_note` | 把文档写入为新笔记；支持指定文件夹、标签、类型（markdown / rich_text） |
| `append_to_note` | 向已有笔记末尾追加内容（markdown / rich_text 类型） |
| `search_notes` | 全文检索，定位要追加的笔记 |
| `list_folders` | 列出文件夹层级路径，确认归档位置 |
| `list_tags` | 列出已有标签，避免重复创建 |

行为约定：

- 正文一律用 Markdown 传入。`markdown` 类型保留源码；`rich_text` 类型会做行级转换（标题 / 列表 / 待办 / 引用 / 代码块），复杂排版建议用 markdown。
- `folder_name` 只做匹配、**不会自动创建文件夹**：找不到或匹配到多个时，会返回可用文件夹列表请你确认。
- `tags` 中不存在的标签会**自动创建**并挂到笔记上。
- 每次追加都会生成笔记修订记录，可在版本历史中回滚。

## 六、验证与排障

**连通性自检**：在 Agent 里让它调用 `list_folders`，能返回文件夹列表即表示地址与令牌配置正确。

**用官方 Inspector 逐个调试工具**：

```bash
npx -y @modelcontextprotocol/inspector aidrivenote-mcp
```

| 现象 | 原因与处理 |
|------|-----------|
| 启动即退出，stderr 提示未配置 `AIDRIVENOTE_API_TOKEN` | 令牌没有写进 MCP 配置的 `env` 段 |
| 提示「令牌无效或已撤销」 | 令牌填错、已被撤销或已过期；到设置页重新生成 |
| 提示「无法连接 …，请检查地址与网络」 | `AIDRIVENOTE_BASE_URL` 写错，或本机网络不可达 |
| 工具列表为空 | 客户端未重启，或 `command` 路径不可用（可先用 `aidrivenote-mcp` 手动执行验证） |
| 追加提示「仅支持 markdown/rich_text」 | 目标笔记是思维导图或流程图，改用 `create_note` 新建 |