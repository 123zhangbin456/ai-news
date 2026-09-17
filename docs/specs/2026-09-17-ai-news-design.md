# AI 新闻聚合推送系统 — 设计文档

日期：2026-09-17

## 目标

每天自动收集全网 AI 新闻，自动分类，手机和电脑都能浏览，重要消息实时推送，夜间不打扰。

## 用户决策记录

| 决策项 | 结论 |
|---|---|
| 查看方式 | PWA（手机加到主屏幕当 app 用，电脑浏览器打开同一套） |
| 推送方式 | 飞书自定义机器人 webhook |
| 推送时段 | 06:00–21:00 实时推送重要消息；21:00–06:00 静默入库；次日 06:00 晨报汇总 |
| 分类方式 | 纯关键词规则，零 API 成本 |
| 翻译 | 不翻译，英文标题原样显示 |
| 部署 | GitHub Actions 定时 + GitHub Pages 托管 |
| arXiv | 只进「研究论文」类，不实时推送，晨报最多 5 条 |
| Anthropic / Meta 官方 | 不做网页抓取，靠媒体转载 |

## 架构

一条每天多次运行的流水线，五个独立模块串联：

```
sources.json
    │
    ▼
 fetch.js ──► parse.js ──► dedupe.js ──► classify.js ──► store.js ──► notify.js
  RSS 拉取     XML 解析      去重合并       分类打分       写 JSON      飞书推送
                                │                          │
                           seen.json                  data/*.json
                                                           │
                                                           ▼
                                                    GitHub Pages
                                                           │
                                                           ▼
                                                      web/ (PWA)
```

无服务器、无数据库、无月费。GitHub Pages 上的 JSON 文件同时充当前端的 API。

## 模块职责

### fetch.js — 抓取

并发拉取所有 RSS 源（并发上限 6，单源超时 20 秒）。使用条件请求（ETag / If-Modified-Since）避免重复下载未变化的源——OpenAI 官方源有 730KB，这一优化很必要。单源失败不影响其他源，失败计数写入 `data/health.json`。

### parse.js — 解析

统一处理 RSS 2.0 和 Atom 两种格式，输出统一的条目结构。剥离 HTML 标签生成纯文本摘要。

### dedupe.js — 去重

两层：

1. **URL 层**：归一化后取 SHA1 前 16 位作为 id。归一化包括去除 `utm_*` / `fbclid` / `spm` 等跟踪参数、统一 https、去末尾斜杠、去锚点。id 命中 `seen.json` 即丢弃。
2. **标题层**：字符二元组 Jaccard 相似度（对中英文都有效，无需分词），阈值 0.62。同一事件的多家报道合并为一条，保留来源权重最高者，其余作为 `related` 折叠。

`seen.json` 滚动保留 30 天。

### classify.js — 分类与打分

**分类**：`rules.json` 中每个分类是一组带权重关键词。中文用子串匹配，英文用词边界匹配（避免 "Agent" 命中 "Agenda"）。累加得分最高者胜出，全零归入「其他」。

八个分类：模型发布、研究论文、产品应用、融资并购、算力芯片、政策监管、开源工具、行业观点。

**重要度分**（0–100），三项加权：

- 来源权重（0–40）：官方博客 40，一线媒体 32，二线 24，社区 16，arXiv 8
- 关键词强度（0–40）：「发布」「开源」「融资」「收购」等高信号词
- 时效性（0–20）：3 小时内满分，线性衰减至 48 小时归零

分数 ≥ 60 触发实时推送，其余攒到晨报。阈值在 `config.json` 中可调。

### store.js — 存储

```
data/
  index.json      日期索引 + 各分类计数
  seen.json       30 天 URL 指纹
  health.json     各源连续失败计数
  2026-09-17.json 当天全部条目
```

按北京时间划分"一天"。写入前先读，同日多次运行做增量追加。

### notify.js — 推送

飞书交互式卡片。三种模式：

- `daytime`：推送 `score >= 60 && !pushed` 的条目，逐条卡片
- `night`：不推送，仅入库
- `morning`：汇总过去 24 小时全部 `!pushed` 条目，按分类分组、按分数排序，单张长卡片

推送失败重试 3 次，间隔 1s / 3s / 9s。支持飞书签名校验（可选）。

## 数据结构

```json
{
  "id": "a3f8c1d29b4e5f07",
  "title": "OpenAI releases GPT-5.5",
  "url": "https://openai.com/index/gpt-5-5",
  "source": "OpenAI",
  "sourceWeight": 5,
  "lang": "en",
  "publishedAt": "2026-09-17T08:30:00+08:00",
  "fetchedAt": "2026-09-17T09:02:11+08:00",
  "summary": "纯文本摘要，最多 240 字",
  "category": "模型发布",
  "score": 92,
  "keywords": ["GPT", "release"],
  "related": [{ "title": "...", "url": "...", "source": "The Verge" }],
  "pushed": false
}
```

## 源清单

分两类。**AI 专属源**全量收录；**通用源**必须先命中 AI 关键词白名单才进入流水线，否则钛媒体的光伏新闻会淹没内容。

AI 专属源：OpenAI、Google DeepMind、Hugging Face、Simon Willison、Import AI、TechCrunch AI、The Verge AI、MIT Tech Review、Ars Technica AI、Wired AI、Synced、量子位、InfoQ 中国 AI。

通用源（需过滤）：雷锋网、钛媒体、爱范儿、开源中国、Solidot、Hacker News 高分帖、Reddit r/LocalLLaMA。

论文源：arXiv cs.AI、cs.CL（特殊限流，见下）。

已确认失效、不纳入：机器之心中文站、36氪、虎嗅、cnBeta、VentureBeat（Cloudflare 拦截）、Anthropic 官网（无 RSS）、Meta AI（无 RSS）、The Batch（无 RSS）。

### arXiv 特殊处理

每天 450+ 篇，必须限流。强制归入「研究论文」，来源权重固定为最低档，永不实时推送，晨报中按「机构知名度 + 是否含代码链接 + 关键词热度」排序后只取前 5 条。

## 调度

GitHub Actions cron 使用 UTC，北京时间 = UTC + 8。

| Workflow | Cron (UTC) | 对应北京时间 | 行为 |
|---|---|---|---|
| daytime.yml | `*/30 22-23,0-12 * * *` | 06:00–21:00 | 抓取 + 实时推送 |
| night.yml | `0 13,15,17,19,21 * * *` | 21:00–05:00 | 仅抓取入库 |
| morning.yml | `0 22 * * *` | 06:00 | 晨报汇总推送 |

Actions 的定时任务实际有 5–15 分钟排队延迟，"实时"的真实粒度约为 30–45 分钟。

三个 workflow 共用同一 concurrency group，避免并发 push 冲突。提交前 `git pull --rebase`。

## 前端

原生 HTML + CSS + JavaScript，不使用框架。数据量小、交互简单（切分类、选日期），引入构建工具收益为负。

- `manifest.json` 提供 PWA 元数据，使 iOS Safari「添加到主屏幕」后以独立全屏 app 形态启动
- `sw.js` 缓存最近 7 天数据，无网络时可离线阅读
- 分类 Tab 横向滚动，条目卡片显示标题、来源、时间、重要度，点击跳原文
- 「相关报道」默认折叠

## 错误处理

遵循项目既定规则：不暴露技术细节、不重复提示、使用自动消失的轻提示。

- 单源抓取失败静默记录；**连续 3 天**失败才在飞书提醒一次，避免网络抖动造成噪音
- 飞书推送失败重试 3 次后放弃，记入日志，不阻塞主流程
- 前端加载失败显示顶部轻提示「网络异常，请检查网络后重试」，3 秒自动消失，同一错误不重复弹出
- 所有错误文案优先使用后端返回信息，缺失时用默认文案

## 测试

- 每个模块配固定 RSS 样本文件做单元测试，不联网
- `node pipeline/run.js --dry-run` 本地执行：打印结果，不推送、不写盘，用于调试关键词规则
- `node pipeline/run.js --check-sources` 逐个探测所有源的可用性

## 后续可选升级

设计中预留但第一版不实现：接入 LLM 做标题翻译、一句话摘要和分类兜底。`classify.js` 与 `translate` 的调用点已抽象为接口，届时增加实现即可，不需重构。
