# Zotero Reader 开发交接

这是 2026-11-06 的 **0.14.1 源码快照**，用于在另一台 Windows 电脑继续开发。可克隆此私有仓库继续开发，也可使用交接压缩包；不需要复制旧电脑的整个 Codex 工作目录。

## 在新电脑上开始

1. 克隆仓库或解压交接包到独立开发目录，例如 `D:\Projects\ZoteroReader`。不要放进知识库或 Obsidian 文库。
2. 准备 Node.js 和 Python。旧电脑验证环境是 Node.js 22.18.0、Python 3.13.5；基础检查没有 npm/pip 依赖。
3. 在这个目录打开终端，运行：

   ```powershell
   python tools/check.py --baseline
   ```

   这会运行 104 项自动检查、校验源码并重建安装包。不会启动 Zotero、请求模型或读取个人论文。
4. 用新电脑的 Codex 打开**这个根目录**，让它先读 `AGENTS.md`、`docs/HANDOFF.md` 和 `docs/WINDOWS.md`。
5. 需要实际使用时，将 `release/zotero-reader-independent-0.14.1.xpi` 安装到 Zotero 并重启。

## 本次调整

概览按钮已改为“清理生成缓存”，固定说明清楚写明：只清理已成功保存笔记的生成缓存，保留原 PDF、笔记、知识库及未导入/后续修改的稿件。操作结果不会覆盖说明。

## 最新决定，优先于历史讨论

- 跨电脑同步的是 **PDF 和已经导入 Zotero 的精读笔记**。
- PDF 沿用 Zotero 中的坚果云/WebDAV 文件同步；Zotero 笔记走 Zotero 数据同步。
- 尚未导入的 Markdown、核验进度、解析缓存只留本机，**不开发这些临时内容的跨机同步**。
- 0.14.1 已实现成功导入后自动清理本次临时内容；未完成/未导入的稿件保留。
- 新版笔记通过来源链接携带简短身份信息。新电脑无本地历史时可以查找笔记并核对输入指纹；旧版无指纹笔记可查看，但不假装确认其 PDF 版本。
- 下一步先验证真实两台电脑经 Zotero 云端同步的结果；随后处理“一篇文献一份主笔记/版本管理”和 Wiki 入库。

## 可以直接发给新电脑 Codex 的话

> 接手这个 Zotero Reader 插件。先读取根目录 AGENTS.md、docs/HANDOFF.md、docs/WINDOWS.md，再运行 python tools/check.py --baseline。当前版本是 0.14.1，自动清理与跨机笔记识别已实现并通过隔离测试；先验证真实双机同步效果，再处理主笔记版本管理和 Wiki 入库。不要开发草稿、核验进度或解析缓存同步，不改第三方 dsh-kb，不把开发文件放进知识库。一次完成一部分，并清楚说明实际验证范围。

包内 `project/` 是唯一开发源码；`release/` 是已发布安装包；`validation/` 是测试依据。源码不包含文献库、真实论文、MinerU 密钥或 CLI 登录凭据。个人文献与笔记请按 `docs/WINDOWS.md` 的同步说明另行处理。
