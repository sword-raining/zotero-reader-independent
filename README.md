# Zotero Reader 独立版

面向文献梳理的 Zotero 插件：MinerU 解析、模型精读、独立核验、必要修订和笔记保存。当前源码及安装包版本为 **0.14.25**。

## 继续开发

在新电脑克隆仓库后，用 Codex 打开仓库根目录，先读取 [START_HERE.md](START_HERE.md)、[开发交接记录](docs/HANDOFF.md) 和 [Windows 配置说明](docs/WINDOWS.md)。

新电脑可以先克隆：

```powershell
git clone https://github.com/sword-raining/zotero-reader-independent.git
cd zotero-reader-independent
```

准备 Node.js 和 Python，然后从根目录运行：

```powershell
python tools/check.py --baseline
```

基线包含 280 项自动检查，并验证语法、XML 和重建安装包。没有 npm/pip 依赖。此命令不启动 Zotero、不调用模型；部分文件系统检查会在临时测试目录创建 Windows 目录联接。

修改源码后使用 `python tools/check.py`。开发源码在 `project/`，测试与构建输出在 `.work/`。`.gitattributes` 保留原始文件字节，便于复现基线 XPI。

当前更新：增加“以后自动按建议处理”开关；开启后，后续已完成并保存的精读自动采用有效建议中的新增和移出，其他分类保留。修复同次精读改稿保存被误报成功、人工编辑笔记状态恢复和归档确认中断恢复。 [0.14.25 版本说明](docs/RELEASE-0.14.25.md)。

## 安装与功能

安装包：[zotero-reader-independent-0.14.25.xpi](release/zotero-reader-independent-0.14.25.xpi)。下载后在 Zotero 安装并重启。

- 单篇、批量及可选新增文献自动精读；可在“监听分类”中限定为 `00_新导入文献` 等分类，不补扫历史、不包含子分类；自动优先选择已发表正文，补充材料仍需手动勾选。
- 精读与核验可分别配置模型和思考强度；核验中断可继续检查已有草稿。
- 自定义模板和命名；支持自动保存笔记或 Markdown 先审阅。
- 已导入笔记携带来源识别信息；成功保存后清理本机生成缓存，保留尚未导入或后续修改的稿件。

原 PDF 使用 Zotero 的文件同步；已导入笔记使用 Zotero 数据同步。草稿、核验进度和解析缓存不跨机同步。当前未完成真实两台电脑经过服务器的同步测试；详情见交接记录。

## 项目边界

此仓库存放插件代码、安装包和开发记录，不存放个人文献库、论文全文、MinerU 密钥或 CLI 登录凭据。不要把开发目录放进 Wiki 或 Obsidian 文库。

DSH 的第三方 `dsh-kb` 与本项目分开维护。下一步优先验证真实双机使用，再处理主笔记版本管理与 Karpathy LLM Wiki 入库衔接。

知识库同步维护已发布，单篇隔离入库原型已验证，正式自动入库仍在准备阶段：[下一步与边界](docs/kb-onboarding/NEXT_STEPS.md)、[科研入库约定草案](docs/kb-onboarding/schema.proposed.md)。`tools/kb_preflight.py` 仅做只读检查；同步脚本默认只读，维护提交已单独推送；尚未启用正式 Wiki 入库或跨机自动同步。
