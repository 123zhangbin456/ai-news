import { createHmac } from 'node:crypto';
import { displayTime, sleep, log } from './util.js';

/* ---------- 飞书签名（机器人开启"签名校验"时才需要） ---------- */

function sign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).update('').digest('base64');
}

/* ---------- 卡片构造 ---------- */

const ICONS = {
  Cursor: '⌨️', 模型发布: '🚀', 研究论文: '📄', 产品应用: '📱', 融资并购: '💰',
  算力芯片: '🔌', 政策监管: '⚖️', 开源工具: '🛠', 行业观点: '💬', 其他: '📰',
  政策公开: '📜',
};

// 飞书卡片里 [] 会破坏 markdown 链接语法
const esc = (s) => String(s ?? '').replace(/[[\]]/g, '');

const headerColor = (score) => (score >= 80 ? 'red' : score >= 65 ? 'orange' : 'blue');

/** 白天实时推送：优先展示中文解读，原文作补充 */
export function buildItemCard(item) {
  const icon = ICONS[item.category] ?? '📰';
  const interp = item.interpret;
  const lines = [];

  if (interp?.headline) {
    lines.push(`**${esc(interp.headline)}**`);
    if (interp.takeaway) lines.push('', esc(interp.takeaway));
    if (interp.bullets?.length) {
      lines.push('', ...interp.bullets.map((b) => `· ${esc(b)}`));
    }
    if (item.title && item.title !== interp.headline) {
      lines.push('', `原文：${esc(item.title)}`);
    }
  } else {
    lines.push(`**${esc(item.title)}**`);
    if (item.summary) lines.push('', esc(item.summary).slice(0, 180));
  }

  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
  ];

  if (item.related?.length) {
    const also = item.related.slice(0, 3).map((r) => `· ${esc(r.source)}：[${esc(r.title)}](${r.url})`);
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**相关报道**\n${also.join('\n')}` } });
  }

  elements.push(
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '阅读原文' },
          url: item.url,
          type: 'primary',
        },
      ],
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `${item.source?.name ?? item.sourceName ?? ''} · ${displayTime(new Date(item.publishedAt))} · 重要度 ${item.score}`,
        },
      ],
    }
  );

  return {
    config: { wide_screen_mode: true },
    header: {
      template: headerColor(item.score),
      title: { tag: 'plain_text', content: `${icon} ${item.category}` },
    },
    elements,
  };
}

/**
 * 政策索引推送：只给标题 + 官方来源 + 跳转按钮。
 * 不做解读、不贴正文，避免接近转载。
 */
export function buildPolicyCard(item) {
  const kw = item.keywords?.length ? `命中词：${item.keywords.join('、')}` : '';
  const lines = [
    `**${esc(item.title)}**`,
    '',
    '这是公开政策的索引提醒，请点击下方按钮在官网阅读原文。',
  ];
  if (kw) lines.push('', kw);

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '🏛 国家政策 · 农民工' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开政府网站原文' },
            url: item.url,
            type: 'primary',
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `${item.source?.name ?? '中国政府网'} · ${displayTime(new Date(item.publishedAt))} · 仅公开信息索引`,
          },
        ],
      },
    ],
  };
}

/** 早上 6 点的晨报：整夜内容按分类汇总成一张长卡片 */
export function buildDigestCard(items, { dateLabel, maxItems }) {
  const shown = items.slice(0, maxItems);

  const groups = new Map();
  for (const item of shown) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  // 条目多的分类排前面
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const elements = [];
  for (const [category, group] of ordered) {
    const icon = ICONS[category] ?? '📰';
    const lines = group.map((item) => {
      const flag = item.score >= 80 ? ' 🔥' : '';
      const title = item.interpret?.headline || item.title;
      const tip = item.interpret?.takeaway ? `\n  ${esc(item.interpret.takeaway)}` : '';
      return `· [${esc(title)}](${item.url})${flag}${tip}\n  ${esc(item.source?.name ?? item.sourceName ?? '')}`;
    });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${icon} ${category}**（${group.length}）\n${lines.join('\n')}` },
    });
    elements.push({ tag: 'hr' });
  }

  if (elements.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '昨夜无新增内容。' } });
  } else {
    elements.pop(); // 去掉末尾多余的分割线
  }

  const omitted = items.length - shown.length;
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: omitted > 0 ? `共 ${items.length} 条，另有 ${omitted} 条可在网页端查看` : `共 ${items.length} 条`,
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'wathet',
      title: { tag: 'plain_text', content: `☀️ AI 晨报 · ${dateLabel}` },
    },
    elements,
  };
}

/** 某个源连续多天抓不到时提醒一次，不是每次失败都吵 */
export function buildHealthCard(broken) {
  const lines = broken.map((b) => `· **${esc(b.name)}** — ${esc(b.error)}`);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '🔧 有新闻源需要检查' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `以下源已连续多天抓取失败，可能已停止维护：\n${lines.join('\n')}\n\n在 \`pipeline/sources.json\` 里换个地址或把 enabled 改成 false 即可。`,
        },
      },
    ],
  };
}

/* ---------- 发送 ---------- */

async function post(webhook, secret, card) {
  const body = { msg_type: 'interactive', card };
  if (secret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    body.timestamp = ts;
    body.sign = sign(secret, ts);
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  const code = data.code ?? data.StatusCode ?? (res.ok ? 0 : res.status);
  if (code !== 0) {
    // 错误文案优先用飞书返回的，缺失时才用默认
    throw new Error(data.msg ?? data.StatusMessage ?? '推送失败，请稍后再试');
  }
}

/**
 * 发送一张卡片，失败按配置重试。
 * 推送失败不应该让整条流水线挂掉——数据已经入库，网页端照样能看。
 */
export async function send(card, { webhook, secret, retry, dryRun, label = '' }) {
  if (dryRun || !webhook) {
    log.info(`[未实际推送] ${label || card.header?.title?.content}`);
    return false;
  }

  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    try {
      await post(webhook, secret, card);
      return true;
    } catch (err) {
      const last = attempt === retry.attempts - 1;
      if (last) {
        log.error(`推送失败（已重试 ${retry.attempts} 次）：${err.message}`);
        return false;
      }
      await sleep(retry.backoffMs[attempt] ?? 3000);
    }
  }
  return false;
}
