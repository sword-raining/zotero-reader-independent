# 开发状态与下一步

记录日期：2026-11-06；版本：0.14.1；扩展 ID：`zotero-reader-independent@local`。

## 目标和用户最新决定

Zotero 管原始文献，本插件完成精读和独立核验，之后将正式笔记与原 PDF 交给 DSH 的 Karpathy LLM Wiki，维护文献页、主题页、关联和索引；Obsidian 浏览同一知识库。

只同步 PDF 和已导入 Zotero 的笔记。未导入 Markdown、核验进度、解析缓存不跨机同步。成功导入后清理；未导入、核验中断或失败的稿件要保留。开发文件和依赖不能放进知识库。

第三方 `@weibaohui/dsh-kb` 与本项目分开，旧机版本为 0.7.18，不修改其包文件。旧机 Wiki 在 E 盘 ResearchVault 下的 LLM-Wiki-Pilot，Obsidian 文库是 ResearchVault；新机路径不必相同。

## 0.14.1 文案更新

按钮名称为“清理生成缓存”。旁边的固定说明明确清理范围、保留条件，以及新任务自动清理、按钮补清旧任务/重试的区别。完成反馈单独显示，说明不会被覆盖。本次未改变删除、匹配或同步规则。

104 项自动检查在 0.14.1 重新运行；下述原生检查属于 0.14.0 的验证依据，不冒充本次重新执行。

## 0.14.0 已完成

- 笔记成功保存事务提交、简短回执落盘后，自动清理本次 reading 目录、所属 CLI 调用目录和无其他任务引用的解析缓存。
- 人工修改的 Markdown、额外加入的文件、共享缓存会保留。清理失败不撤销笔记，设置概览页的“清理生成缓存”按钮可补清旧任务或重试清理。
- 正式笔记保留实际引用的原文片段，清理完整段落索引后仍有可读依据。
- 保存简短识别信息：父条目 key、输入角色与 PDF 哈希、runID、状态和正文指纹。没有绝对路径或本机数字 itemID/libraryID。
- 识别信息同时保存在来源链接的 zri-record 参数中；根节点自定义属性只是方便读取。Zotero 编辑器会丢弃未知根属性和注释，因此不能只依赖它们。来源链接参数已通过 Zotero.Router/API 验证仍指向正确 PDF。
- 正文指纹忽略无关 HTML 格式整理，保留文字、链接和关键结构变化的检测。人工修改不会被旧检查结论自动覆盖。
- 新电脑没有本地队列和保存记录时，查找已同步笔记；批量与自动入口核对指纹并跳过已有结果。PDF 尚未下载时，在真正处理前再检查一次已有笔记。
- 旧版带标记的笔记可以查看；缺少指纹时不声称已确认版本，不保证自动跳过所有旧版结果。
- Windows 用 GetFileAttributesW 检查 FILE_ATTRIBUTE_REPARSE_POINT。仅使用 nsIFile.isSymlink 不足以识别目录联接，曾被隔离测试发现；现已修复。不能删掉这一原生回归测试。

## 既有功能

独立 MinerU 解析和用户密钥；单篇、批量、可选新增 PDF 自动精读；按文献区分正文、完全重复文件与补充材料，默认只读正文，补充材料手动勾选。只对字节完全相同的本地文件去重，不删除原附件。

九个精读栏目：背景、动机、发表价值、设计、方法、主要结果、机制、局限和启发。独立会话核验，逐条引句匹配，最多两轮修订并重新核验；无自由提问，不另存用户可读的核验报告笔记。发表价值只是有材料依据的分析，不是编造编辑实际录用理由。

精读和核验分别选择 ChatGPT/Codex CLI 或 Antigravity、型号和能力支持的思考强度。模板与命名可自定义，自动导入或 Markdown 先审阅。作者、单位等从题录/原文提取；IF/JCR 读取 Zotero One 已写入的 libraryCatalog，中科院/CCF 读 callNumber，年份只取 Extra 的明确记录。

0.13.1 已修复网络中断被误显示为内容问题。继续检查复用草稿和原文索引，不重新解析或重新生成全文；刷新文件支持人工改稿导入。用户那次真实中断稿只做了只读兼容检查，没有替用户再次发送模型或导入。

## 实际验证范围

- 104 项 Node 自动检查通过，包括续检、来源变化、清理、并发保护、跨本机 ID 的识别等。
- 8 项无界面 Zotero 检查通过：真实笔记事务与回滚、JSON 往返、模拟编辑器格式整理、来源链接路由、无本地历史查找、保护人工修改/未导入稿、Windows 目录联接保护、下载后避免重复精读。
- 61 项既有原生流程检查已在 0.14.0 无界面 Zotero 中重新通过。该套测试保留导入后的合成中间文件用于断言；真实清理由上面的 8 项独立原生检查验证。没有重新操作用户桌面做视觉检查。
- 本轮不请求真实模型、不读取或修改个人论文，不控制用户桌面。真实两台电脑经过 Zotero 服务器同步尚未实测。
- 该轮最初的 Windows 联接测试暴露了宿主接口差异，使用原生文件属性后复测通过。回归用的外部目标也是隔离测试文件，个人文库和 Wiki 没有受影响。

## 下一步顺序

1. 在新电脑登录同一个 Zotero 账号，安装 0.14.1。验证旧电脑新生成的笔记同步后可通过插件打开；本地 queue/cache 为空也可识别，PDF 下载后批量不重复调用模型。再验证实际编辑器修改后笔记仍可找到。
2. “一篇文献一份主笔记/版本管理”。目前主动重读仍保留新旧版本，不静默覆盖人工编辑。要设计明确更新规则，而不是直接按标题覆盖。
3. Wiki 入库衔接：基于正式 Zotero 笔记和原 PDF，不再依赖会被清理的 reading.md/source.json/workflow.json。正式进入 Wiki 的原始资料不是插件缓存，不得由本插件清理。
4. 按需要完善旧版笔记识别，不给缺失来源指纹的旧结果编造“PDF 未变化”状态。

不要重启草稿、核验进度或缓存同步项目，也不要改第三方 dsh-kb。

## 关键代码

| 文件 | 职责 |
| --- | --- |
| bootstrap.js | 模块加载顺序、启动与关闭等待 |
| content/runtime.js、core.js | MinerU、Login Manager、解析缓存 |
| content/reading-core.js | 提示词、结构、证据核验 |
| content/codex-runtime.js | 生成、检查、修订、续检、结果窗口 |
| content/codex-core.js、engine-core.js、engines.js | CLI 传输、能力检测 |
| content/note-runtime.js、note-core.js | 笔记事务、正文/原文片段输出 |
| content/saved-core.js、saved-runtime.js | 笔记识别回执、内容指纹、查找与匹配 |
| content/cleanup.js | 清理、引用保护、Windows 原生路径检查 |
| content/automation.js、queue-core.js | 队列、等待文件、导入后的精简记录 |
| content/attachments.js、attachment-core.js | 正文/补充材料、去重和来源校验 |
| content/batch-runtime.js、batch-core.js | 批量入口与结果跳过 |
| content/wiki-core.js、bibliography-core.js | 题录、Wiki 输入元数据 |
| tests/saved-cleanup.test.cjs | 文件清理和无本地状态识别回归 |
| tests/saved-cleanup-smoke.js | 无界面 Zotero 原生事务与文件系统回归 |

## 其他不要重踩的问题

- Chrome 窗口的 HTML select 曾打不开，已改为 XUL menulist。radio 不得套用文本输入框的全宽 CSS。
- Antigravity 自动更新开关必须是子进程环境变量 AGY_CLI_DISABLE_AUTO_UPDATE=true，值 1 不生效；environmentAppend:true 保留环境，不改全局配置。
- Gecko 在 Windows 已用 CREATE_NO_WINDOW，不添加无效的 Node windowsHide 参数。Codex 调用按进程关闭 plugins、plugin_discovery_prefetch、shell_snapshot。
- Antigravity 仍可能初始化全局 MCP，禁止工具使用不等于禁止初始化。不要将无效参数或全局配置修改当作修复。
- 快速连通与完整配置验证不同；超时表示未确认，不表示型号已确定不可用。
- tests/live-review-probe.cjs 是带旧机硬编码路径/型号的历史诊断，不是基础测试，不能在新机直接运行。
- Zotero 启动器 PID 不一定是实际测试进程 PID。按隔离 profile 路径识别测试进程，不按进程名批量关闭 Zotero。
- 本机临时记录仍可能有绝对路径，但它们不跨机迁移；正式笔记识别不依赖这些路径。

同步机制参考：[Zotero 官方同步说明](https://www.zotero.org/support/sync)。Windows 路径保护参考：[文件属性常量](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants)。
