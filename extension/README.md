# AIDriveNote Web Clipper

把网页选区保存为 AIDriveNote 的 Markdown 笔记。

## 安装（Chrome / Edge，未打包）

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录 `extension/`。
3. 点扩展图标，填写：
   - **API 地址**：默认 `http://localhost:3275/api/v1`；线上部署请改成实际地址。
   - **访问令牌**：在 AIDriveNote「设置 → 访问令牌」生成，**必须勾选「写入」**。
4. 在网页中选中文字 → 右键「保存选中内容到 AIDriveNote」，或点扩展图标手动保存。

## 权限说明

- `activeTab` / `scripting`：读取当前页面的选区、标题与 URL。
- `storage`：保存 API 地址与令牌（存在 `chrome.storage.sync`）。
- `host_permissions`：允许向本地后端与 HTTPS API 发起请求。若只使用自有域名，可把 `https://*/*` 收窄为具体域名。

## 安全提示

- 令牌等同长期密码，不要提交到公开仓库；怀疑泄露时立即在设置页撤销。
- 扩展只在用户点击时读取页面内容，不会后台抓取浏览记录。
