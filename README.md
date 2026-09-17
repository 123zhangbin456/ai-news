# AI 日报

每天自动收集全网 AI 新闻，按八个分类整理，重要消息实时推到飞书，夜里不打扰。
手机加到主屏幕当 app 用，电脑打开同一个网址。

无服务器、无数据库、无月费——全部跑在 GitHub Actions 上，数据以 JSON 文件形式存在仓库里，
GitHub Pages 直接把这些文件当 API 提供给前端。

## 它是怎么运转的

```
sources.json
    │
    ▼
 fetch ──► parse ──► dedupe ──► classify ──► store ──► notify
 RSS 拉取   XML 解析   去重合并    分类打分     写 JSON    飞书卡片
                                               │
                                               ▼
                                         GitHub Pages ──► PWA
```

| 北京时间 | 行为 |
|---|---|
| 06:00 | 把整夜攒下的内容汇总成一份晨报推送 |
| 06:00 – 21:00 | 每 30 分钟抓一次，重要度 ≥ 60 分的立刻推送 |
| 21:00 – 06:00 | 照常抓取入库，不推送 |

定时任务实际有 5–15 分钟排队延迟，所谓"实时"的真实粒度约为半小时。

## 部署

### 1. 建飞书机器人

在飞书里建一个只有自己的群 → 群设置 → 群机器人 → 添加「自定义机器人」→ 复制 webhook 地址。
安全设置如果选了「签名校验」，把密钥也记下来。

### 2. 推到 GitHub

```bash
git remote add origin git@github.com:你的用户名/仓库名.git
git push -u origin main
```

### 3. 配置

仓库 Settings → Secrets and variables → Actions → New repository secret：

| 名称 | 值 | 必填 |
|---|---|---|
| `FEISHU_WEBHOOK` | 上一步复制的 webhook 地址 | 是 |
| `FEISHU_SECRET` | 签名密钥，机器人没开签名校验就不用加 | 否 |

再去 Settings → Pages → Source 选 **GitHub Actions**。

### 4. 首次运行

Actions 页面 → 「AI 新闻流水线」→ Run workflow。跑完后 Pages 的网址就能访问了。

### 5. 装到手机

iPhone 用 Safari 打开网址 → 分享 → 添加到主屏幕。
Android 用 Chrome 打开 → 菜单 → 安装应用。
之后点图标就是全屏的 app，没有浏览器地址栏。

## 日常调整

**嫌推送太吵 / 太安静**——改 `pipeline/config.json` 的 `pushThreshold`。
默认 60，调到 75 只有重磅才响，调到 45 会收到更多。

**分错类了**——改 `pipeline/rules.json`，给对应分类加两个关键词，或把误命中的词删掉、调低权重。
改完跑 `npm run dry` 立刻看效果，不写盘也不推送。

**想加新闻源**——改 `pipeline/sources.json` 加一条，然后 `npm run check` 验证这个地址能不能抓通。
`type` 填 `ai` 表示全量收录，填 `general` 表示要先过 AI 关键词筛选（综合媒体用这个，
否则它家的汽车、光伏新闻会淹没内容）。

**某个源挂了**——连续三天抓不到时会在飞书提醒一次。把 `enabled` 改成 `false` 即可停用，不用删。

## 本地开发

```bash
npm install
npm run check      # 逐个探测所有新闻源是否可用
npm run dry        # 跑一遍流水线，只打印结果，不写盘不推送
npm start          # 真实运行，按当前北京时间自动决定模式
npm run serve      # 本地预览网页，默认 http://localhost:4173
npm test           # 单元测试
node scripts/make-icons.js   # 重新生成 app 图标
```

手动指定模式：`npm run daytime` / `npm run night` / `npm run morning`。

本地没配 `FEISHU_WEBHOOK` 时不会真的推送，只会在终端打印「未实际推送」。

## 目录

```
pipeline/     数据流水线
  sources.json  新闻源清单（常改）
  rules.json    分类关键词与打分规则（常改）
  config.json   阈值与开关（偶尔改）
  fetch / parse / dedupe / classify / store / notify / run
web/          PWA 前端，原生 HTML/CSS/JS，无构建步骤
data/         数据文件，同时是前端的 API
docs/specs/   设计文档
```

## 已知边界

- **中文源偏少。** 机器之心、36氪、虎嗅的 RSS 都已停止维护，量子位是目前唯一还在提供
  订阅源的中文 AI 垂直媒体，所以内容以英文为主。想要中文标题需要接入翻译，
  `classify.js` 里已经把调用点留好了。
- **Anthropic 和 Meta 官方没有 RSS。** 它们的重要发布靠 TechCrunch、The Verge 转载获取，
  会晚一到两个小时。
- **arXiv 每天 450 多篇。** 已做限流：只归入「研究论文」类，永不实时推送，
  晨报里最多 5 篇，按机构知名度、是否附代码、话题热度挑选。
- **Reddit 偶尔返回 429。** 属于正常限流，单源失败不影响其他源。
