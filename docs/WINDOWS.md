# 在另一台 Windows 电脑继续

## 开发源码

解压整个交接包到独立目录。`project/` 的源码和 `release/` 的 XPI 对应 0.14.1；无需旧电脑的同名用户名或盘符。

旧环境已确认：Zotero 10.0.7、Node.js 22.18.0、Python 3.13.5、Antigravity CLI 1.5.1。模型目录和 CLI 行为会变化，到新电脑后应重新检测；不要把旧测试时间当作新机可用性的证明。

先运行不联网的检查：

```powershell
# 当前目录为交接包根目录
python tools/check.py --baseline
```

以后修改源码，再运行 `python tools/check.py`。产物在 `.work/`。该命令会检查 JS/XML、运行所有 `*.test.cjs`，并调用 `project/build.py` 打包；不启动 Zotero，也不调用真实模型。

单独构建：

```powershell
python project/build.py --output .work/zotero-reader-independent-dev.xpi
```

仓库从 0.14.1 源码快照开始记录版本。新电脑克隆整个仓库后从根目录开发；无需复制旧电脑的整个 Codex 工作区。`.gitignore` 排除测试缓存和依赖目录。

## 使用插件所需配置

1. 安装 Zotero，登录同一个 Zotero 账号，等待文献和笔记数据同步。
2. 按你原来的坚果云/WebDAV 设置启用 PDF 文件同步。已导入的笔记走 Zotero 数据同步，不依赖本插件另传 Markdown。[同步机制说明](https://www.zotero.org/support/sync)
3. 在 Zotero 中安装 `release/zotero-reader-independent-0.14.1.xpi`，重启。
4. 在新电脑安装并登录要用的模型 CLI；插件中重新检测通道和型号。若旧配置保存了程序绝对路径，应改为新路径或留空自动寻找。
5. MinerU 密钥由用户在新机插件设置中输入。开发包不迁移 Login Manager 或 CLI 登录文件。

不要把整个 Zotero 数据目录（包含 zotero.sqlite）直接放进坚果云同步目录；继续使用 Zotero 内置的数据/附件同步。[Zotero 官方说明](https://www.zotero.org/support/sync)

本次没有迁移文献库、Wiki、未导入草稿和本地核验状态。已有笔记随同账号同步后可阅读；0.14.1 会识别新版笔记附带的来源指纹，并在批量/自动入口避免重复处理。真实双机同步仍需验证，见 HANDOFF.md。旧机尚未导入的稿件若要成为跨机成果，应先在旧机完成检查和导入；不要同步临时工作目录。

## 原生 Zotero 隔离测试（需要时再做）

基础检查通过后，只有需要验证原生界面/宿主 API 时才做这一项。它会出现测试窗口；不要在用户不希望桌面被操作时运行。默认测试使用合成数据和模拟服务，但会检查本机 Codex 可执行程序版本，因此需可找到 Codex CLI。

```powershell
python project/tests/prepare_smoke.py

# 改成新电脑 Zotero 的实际安装路径
$zoteroExe = 'C:\Program Files\Zotero\zotero.exe'
$testProfile = (Resolve-Path -LiteralPath '.\zotero-reader-smoke-profile').Path
$testData = Join-Path $testProfile 'data'
$env:MOZ_NO_REMOTE = '1'
Start-Process -FilePath $zoteroExe -WindowStyle Hidden -ArgumentList @(
  '-no-remote', '-new-instance', '-profile', ('"' + $testProfile + '"'),
  '-datadir', ('"' + $testData + '"'), '-purgecaches', '-ZoteroDebugText'
)
```

检查 `zotero-reader-smoke-profile/smoke-result.json`，须有 `completed: true` 且全部测试 `ok: true`；如有 `smoke-fatal.json`，先定位失败。原生测试默认结束后自行退出，启动器的退出不等于测试完成。

`--live-engines`、`--live-reading`、`--live-agy-startup` 会调用真实模型，不是离线测试；只在明确需要时使用。`--visual` 和 `--visual-attachments` 打开隔离预览，不请求模型。

`--saved-cleanup` 只运行原生笔记保存、识别与清理检查。可在启动测试 Zotero 前设置 `$env:MOZ_HEADLESS='1'` 并添加 `-headless`，全程无需控制桌面。目录联接测试需要运行环境允许在隔离目录创建联接；沙箱报 EPERM 时应按工具授权机制处理，不应删除测试或将其记为通过。

保存精简测试结果后，只清理确认属于本开发目录的隔离 profile。不要按 `zotero.exe` 进程名批量关闭个人 Zotero，不要删除真实数据目录或 Wiki。

## Wiki / Obsidian

若需要在新电脑继续使用 Wiki，另外迁移用户正式知识库中的 Markdown、原始资料和配置；开发包不包含这些内容。不要把 `project/`、`.work/`、测试文库或依赖放进知识库。

下一阶段的入库应以已经保存的 Zotero 精读笔记和原 PDF 为依据。插件清理本机临时 Markdown 不应删除已正式进入 Wiki 的文件，也不应要求为了 Wiki 保留全部模型运行日志。
