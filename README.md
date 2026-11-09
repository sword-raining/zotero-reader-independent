# Zotero Reader 独立版

面向文献梳理的 Zotero 插件：MinerU 解析、模型精读、独立核验、必要修订和笔记保存。当前源码及安装包版本为 **0.14.27**。

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

基线包含 331 项自动检查，并验证语法、XML 和重建安装包。没有 npm/pip 依赖。此命令不启动 Zotero、不调用模型；部分文件系统检查会在临时测试目录创建 Windows 目录联接。

修改源码后使用 `python tools/check.py`。开发源码在 `project/`，测试与构建输出在 `.work/`。`.gitattributes` 保留原始文件字节，便于复现基线 XPI。

当前更新：单独补归档沿用模型超时设置；自动队列预检复用未变化 PDF 的短时哈希，最终跳过、取消、执行和保存仍完整核对；四类持久索引损坏、读失败或外部变化时保留原件、备份并阻止覆盖。 [0.14.27 版本说明](docs/RELEASE-0.14.27.md)。

## 安装与功能

安装包：[zotero-reader-independent-0.14.27.xpi](release/zotero-reader-independent-0.14.27.xpi)。下载后在 Zotero 安装并重启。

- 单篇、批量及可选新增文献自动精读；可在“监听分类”中限定为 `00_新导入文献` 等分类，不补扫历史、不包含子分类；自动优先选择已发表正文，补充材料仍需手动勾选。
- 精读与核验可分别配置模型和思考强度；核验中断可继续检查已有草稿。
- 自定义模板和命名；支持自动保存笔记或 Markdown 先审阅。
- 已导入笔记携带来源识别信息；成功保存后清理本机生成缓存，保留尚未导入或后续修改的稿件。

原 PDF 使用 Zotero 的文件同步；已导入笔记使用 Zotero 数据同步。草稿、核验进度和解析缓存不跨机同步。当前未完成真实两台电脑经过服务器的同步测试；详情见交接记录。

## 项目边界

此仓库存放插件代码、安装包和开发记录，不存放个人文献库、论文全文、MinerU 密钥或 CLI 登录凭据。不要把开发目录放进 Wiki 或 Obsidian 文库。

DSH 的第三方 `dsh-kb` 与本项目分开维护。下一步优先验证真实双机使用，再处理主笔记版本管理与 Karpathy LLM Wiki 入库衔接。

知识库接入原型在另一工作区单独维护，未包含在本插件版本中；后续合入时保留现有未提交改动，不修改第三方 dsh-kb。
