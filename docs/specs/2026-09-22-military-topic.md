# 军事主题设计

日期：2026-09-22  
状态：已批准（用户选方案 1）

## 目标

在「每日简报」增加大类 **军事**，一个二级主题，国内外混排，格式与 AI 频道一致：RSS → 分类 → 中文解读 → 飞书卡片（展开 + 阅读原文）→ 网页浏览。

## 结构

| 项 | 值 |
|---|---|
| 大类 | `military` / 军事 / 🛡 |
| 主题 | `military` / 军事 |
| channel | `ai`（新闻解读通道，非政策） |
| 数据 | `data/military/military/` |

分类：装备动态、台海周边、国际冲突、防务合作、演习演训、其他。

## 实现要点

1. `pathsFor` 按 domains.json 解析 domain，不再写死 migrant。
2. `run.js --topic=military` 加载独立 sources/rules；关闭 Cursor/arXiv 特例。
3. `topicFilter`（兼容原 `aiFilter`）+ 军事解读 system prompt。
4. workflow 增加军事任务；Pages 拷贝 `data/military/`。
5. 前端按 `channel === 'policy'` 判断政策栏，其余走解读卡片。

## 不做

- 不拆国内/国际两个主题
- 不走 policy 禁解读通道
