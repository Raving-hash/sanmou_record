# Windows 抓榜脚本

游戏里「演武积分排行榜」本身没有接口，只能在客户端上翻页截图。这一套脚本做的是：

```
提权 PowerShell 找窗口 → 滚榜截帧 → WinRT OCR → 按列切成行 → 校验 → 一次批量 POST
```

抓到的帧、每轮的报告都落在 `data/rank-shots/`（已被 `.gitignore` 忽略）。
报文形状和接口语义见仓库根目录的 [排行榜导入接口约定.md](../排行榜导入接口约定.md)。

## 文件

| 文件 | 干什么 |
|---|---|
| `rank-shot.js` | 主程序。抓帧、调度 OCR、解析列、字段投票、生成报文、批量上报 |
| `run-rank-shot.ps1` | 一次运行的包装：写日志、游戏没开就安静跳过。计划任务指向的是它，不是 node |
| `install-rank-task.ps1` | 注册 / 修改 / 移除计划任务（每日、每 N 分钟、每周某天某几段） |
| `win-rank.ps1` | 提权下按标题找窗口、发滚轮、抓客户区像素 |
| `win-ocr.ps1` | 调 `Windows.Media.Ocr` 出词框（带坐标） |
| `rank-mock-receiver.js` | 本地假接口，报文形状与真接口一致，离线联调用（不认人，也不做模糊匹配） |

## 环境要求

- **Windows PowerShell 5.1**（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`）。
  不要用 pwsh 7：WinRT 的 `Windows.Media.Ocr` 只在 5.1 里加载得起来。脚本里已经硬编码了这个路径。
- **Node.js**：优先用仓库里的 `tools\node.exe`（`tools/` 在 `.gitignore` 里，89MB，机器本地备一份），
  其次才回落到 PATH。
- 游戏客户端（`com.bilibili.nslg`）运行时是**管理员权限**，Windows 的 UIPI 会挡住低权限进程的
  找窗口/发消息，所以计划任务必须是 `-RunLevel Highest`（默认值）。手动调试时也要用提权的终端。
- `.env`（`.gitignore` 里已忽略）：

  ```ini
  SCORE_API_URL=http://www.raving-hash.top/api/scores
  SCORE_API_TOKEN=<令牌>
  ```

## 快速开始

```powershell
# 抓一轮，认完直接发（游戏要开着，并且停在哪个界面都行，脚本自己回大厅点排行榜）
node scripts/rank-shot.js --capture

# 只抓 + 出报文，不发（对字段、给后端看形状时用）
node scripts/rank-shot.js --capture --payload out.json

# 重放已经抓过的帧，不碰游戏（调解析逻辑最快的方式）
node scripts/rank-shot.js --from data/rank-shots/20261017-074822
```

常用旋钮：`--frames <最多几屏>`、`--notches <每屏滚几格>`、`--title <标题正则>`、
`--batch-size <一个包几条，默认 0 = 全塞一个请求>`、`--prune <只留最近 n 轮目录>`。

上报那两个旋钮一般不用动：`--post-timeout <毫秒，默认 45000>`、`--post-retries <默认 3>`。
站点在 Cloudflare 后面，冷连接很慢（2026-10-29 实测一次正常 3.8–6.5 秒，首个请求偶发超过 20 秒），
所以超时放宽到 45 秒，并且**传输层失败会自动重试**（同一批名字同一批分，重发是安全的）；
4xx 不重试——令牌错、报文不合法，重发一万次也一样。重试过的包会在成功那行标出「其中 N 个是重试才通的」。

`--score-grow / --score-add / --score-reset` 是**试跑**用的偏移：在真实积分上整数叠加，
跨进程记账（`data/rank-shots/.offset-state.json`）。默认不加，不动真实分数。

## 定时任务

`install-rank-task.ps1` 需要提权。你本机的执行策略如果不是 `Bypass`，就显式带上：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-rank-task.ps1 -At 22:00
```

几种常见注册方式：

```powershell
# 每天 22:00 一次
.\scripts\install-rank-task.ps1 -At 22:00

# 每 2 分钟一次，一直跑
.\scripts\install-rank-task.ps1 -EveryMinutes 2

# 每周四 12:15-13:30、20:15-21:00 两段，各段内每 15 分钟一次
.\scripts\install-rank-task.ps1 -WeeklyDay Thursday `
    -Windows '12:15-13:30,20:15-21:00' -EveryMinutes 15

# 立刻跑一次 / 看现在的注册状态 / 删掉
.\scripts\install-rank-task.ps1 -RunNow
Get-ScheduledTask -TaskName yanwu-rank-shot | Select-Object State
.\scripts\install-rank-task.ps1 -Remove
```

实现上的一点坑（都已经在脚本里处理了）：

- `-RepetitionDuration ([TimeSpan]::MaxValue)` 会被 XML 校验器拒绝（`P99999999DT23H59M59S`）。
  **省略**这个参数才是「一直重复」。
- 每周触发器的重复区间是有界的（= 窗口长度 + 1 分钟），所以窗口一结束就不能再重复；
  `StopAtDurationEnd` 默认 `True` 会把窗口末尾正在跑的那一轮**杀掉**，脚本里显式设成了 `$false`。

## 日志与排错

| 位置 | 内容 |
|---|---|
| `data/rank-shots/<UTC 时间>/` | 每轮截的帧、OCR 结果、`send-report.json` |
| `data/rank-shots/logs/run-<本地时间>.log` | 这一轮的完整 stdout + stderr |
| `data/rank-shots/logs/runs.log` | 每轮一行摘要，出问题时先看它 |

`send-report.json` 里的字段：`sent / entries / requests / written / unchanged / notOnSite /
failed / fuzzy / ambiguous / aborted`。`fuzzy` 是后端按相似度**猜着写进去**的那些（分已经改了、
人是谁是猜的，要复核）；`ambiguous` 是后端觉得像的名字不止一个、一个字都没写。
**`notOnSite` 不是失败**——榜是整个赛区的，站点上只登记了自己这群人。

游戏没开时这一轮直接跳过，`runs.log` 里是 `skip: game not running`，退出码 0，不报错。

## 已知限制

- OCR 会稳定认错个别字（「秦」→「剿」等）。**客户端不猜**（猜错就是把别人的分写给别人），
  现在由后端的相似度匹配兜底，猜中的会回 `match:"fuzzy"`，客户端把它单独打出来等复核。
  详见接口文档文末。
- 计划任务用的是 `Interactive` 登录类型：**没人登录不跑**，停在登录界面也不跑。
- `WakeToRun` 默认关着。机器要是会睡眠/合盖，到点不会自己醒——需要的话在注册时补上。
- 游戏没有开机自启，所以机器重启后要手动把游戏打开，否则那一轮只会留下
  `skip: game not running`。
