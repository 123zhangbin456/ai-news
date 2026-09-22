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
  装备动态: '🚀', 台海周边: '🌊', 国际冲突: '⚔️', 防务合作: '🤝', 演习演训: '🎯',
};

// 飞书卡片里 [] 会破坏 markdown 链接语法
const esc = (s) => String(s ?? '').replace(/[[\]]/g, '');

const headerColor = (score) => (score >= 80 ? 'red' : score >= 65 ? 'orange' : 'blue');

const metaLine = (item) =>
  `${item.source?.name ?? item.sourceName ?? ''} · ${displayTime(item.publishedAt || item.fetchedAt || new Date())} · 重要度 ${item.score}`;

/** schema 2.0：打开链接的按钮 */
function linkButton(label, url, type = 'primary') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    width: 'default',
    size: 'medium',
    behaviors: [{ type: 'open_url', default_url: url }],
  };
}

/**
 * 白天实时推送（卡片 JSON 2.0）：
 * 首屏：中文标题 + 一句话结论
 * 「展开」：要点、补充总结、原文标题
 * 底部：阅读原文
 */
export function buildItemCard(item) {
  const icon = ICONS[item.category] ?? '📰';
  const interp = item.interpret;
  const elements = [];

  if (interp?.headline) {
    elements.push({
      tag: 'markdown',
      content: `**${esc(interp.headline)}**`,
    });
    if (interp.takeaway) {
      elements.push({
        tag: 'markdown',
        content: esc(interp.takeaway),
      });
    }

    const foldLines = [];
    if (interp.bullets?.length) {
      foldLines.push(...interp.bullets.map((b) => `· ${esc(b)}`));
    }
    if (item.summary) {
      if (foldLines.length) foldLines.push('');
      foldLines.push(`**补充**\n${esc(item.summary).slice(0, 280)}`);
    }
    if (item.title && item.title !== interp.headline) {
      if (foldLines.length) foldLines.push('');
      foldLines.push(`原文标题：${esc(item.title)}`);
    }

    if (foldLines.length) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: { tag: 'plain_text', content: '展开' },
          vertical_align: 'center',
          width: 'auto_when_fold',
          icon: {
            tag: 'standard_icon',
            token: 'down-small-ccm_outlined',
            size: '16px 16px',
          },
          icon_position: 'follow_text',
          icon_expanded_angle: -180,
        },
        border: { color: 'grey', corner_radius: '6px' },
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [{ tag: 'markdown', content: foldLines.join('\n') }],
      });
    }
  } else {
    elements.push({ tag: 'markdown', content: `**${esc(item.title)}**` });
    if (item.summary) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: { tag: 'plain_text', content: '展开' },
          vertical_align: 'center',
          width: 'auto_when_fold',
          icon: {
            tag: 'standard_icon',
            token: 'down-small-ccm_outlined',
            size: '16px 16px',
          },
          icon_position: 'follow_text',
          icon_expanded_angle: -180,
        },
        border: { color: 'grey', corner_radius: '6px' },
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [{ tag: 'markdown', content: esc(item.summary).slice(0, 400) }],
      });
    }
  }

  if (item.related?.length) {
    const also = item.related
      .slice(0, 3)
      .map((r) => `· ${esc(r.source)}：[${esc(r.title)}](${r.url})`)
      .join('\n');
    elements.push({ tag: 'markdown', content: `**相关报道**\n${also}` });
  }

  if (item.url) {
    elements.push(linkButton('阅读原文', item.url, 'primary'));
  }

  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>${esc(metaLine(item))}</font>`,
    text_size: 'notation',
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: headerColor(item.score),
      title: { tag: 'plain_text', content: `${icon} ${item.category}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
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
            content: `${item.source?.name ?? '中国政府网'} · ${displayTime(item.publishedAt || item.fetchedAt || new Date())} · 仅公开信息索引`,
          },
        ],
      },
    ],
  };
}

/** 早上 6 点的晨报：整夜内容按分类汇总成一张长卡片 */
export function buildDigestCard(items, { dateLabel, maxItems, title }) {
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
      const headline = item.interpret?.headline || item.title;
      const tip = item.interpret?.takeaway ? `\n  ${esc(item.interpret.takeaway)}` : '';
      return `· [${esc(headline)}](${item.url})${flag}${tip}\n  ${esc(item.source?.name ?? item.sourceName ?? '')}`;
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
      title: { tag: 'plain_text', content: `☀️ ${title ?? 'AI 晨报'} · ${dateLabel}` },
    },
    elements,
  };
}

/** 某个源连续多天抓不到时提醒一次，不是每次失败都吵 */
export function buildHealthCard(broken) {
  const n = broken.length;
  const byError = new Map();
  for (const b of broken) {
    const reason = b.error || '未知原因';
    if (!byError.has(reason)) byError.set(reason, []);
    byError.get(reason).push(b.name);
  }

  const blocks = [...byError.entries()].map(([reason, names]) => {
    const list = names.map((name) => `· **${esc(name)}**`).join('\n');
    return `${list}\n<font color='grey'>原因：${esc(reason)}</font>`;
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `⚠️ ${n} 个新闻源异常` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `以下源已连续多天抓取失败，建议尽快处理：\n\n${blocks.join('\n\n')}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**怎么处理**\n1. 打开 `pipeline/sources.json`\n2. 换可用的订阅地址，或把对应项的 `enabled` 设为 `false`',
        },
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '处理前网页与推送会暂时缺少这些源的内容',
          },
        ],
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
