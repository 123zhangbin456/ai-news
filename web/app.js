(() => {
  'use strict';

  const DATA = './data';
  const el = {
    brand: document.getElementById('brand'),
    domains: document.getElementById('domains'),
    topics: document.getElementById('topics'),
    tabs: document.getElementById('tabs'),
    list: document.getElementById('list'),
    date: document.getElementById('date-select'),
    refresh: document.getElementById('refresh'),
    footer: document.getElementById('footer'),
    toast: document.getElementById('toast'),
    legal: document.getElementById('legal'),
  };

  const state = {
    catalog: null,
    domainId: 'tech',
    topicId: 'ai',
    category: '全部',
    date: null,
    day: null,
  };

  const toast = (() => {
    let timer = null;
    let current = '';
    return (message) => {
      if (message === current) return;
      current = message;
      el.toast.textContent = message;
      el.toast.classList.add('show');
      clearTimeout(timer);
      timer = setTimeout(() => {
        el.toast.classList.remove('show');
        current = '';
      }, 3000);
    };
  })();

  async function loadJSON(path, { missingMessage } = {}) {
    let res;
    try {
      res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    } catch {
      throw new Error('网络异常，请检查网络后重试');
    }
    if (res.status === 404) throw new Error(missingMessage ?? '暂无内容');
    if (res.status >= 500) throw new Error('服务器繁忙，请稍后再试');
    if (!res.ok) throw new Error('加载失败，请稍后再试');
    try {
      return await res.json();
    } catch {
      throw new Error('加载失败，请稍后再试');
    }
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  function relativeTime(iso) {
    const diffMin = (Date.now() - new Date(iso).getTime()) / 60000;
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${Math.floor(diffMin)} 分钟前`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)} 小时前`;
    const d = new Date(iso);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  const dateLabel = (key) => {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const [, m, d] = key.split('-');
    if (key === todayKey) return `今天 ${Number(m)}/${Number(d)}`;
    return `${Number(m)}月${Number(d)}日`;
  };

  const scoreClass = (n) => (n >= 80 ? 'score hot' : n >= 65 ? 'score warm' : 'score');

  const topicMeta = () => state.catalog?.topics?.[state.topicId] ?? null;

  /** AI 数据在 /data/日期.json；政策在 /data/policy/migrant/日期.json */
  function dayDataUrl(dateKey) {
    if (state.topicId === 'ai') return `${DATA}/${dateKey}.json`;
    const domain = state.domainId || 'policy';
    return `${DATA}/${domain}/${state.topicId}/${dateKey}.json`;
  }

  function currentDomain() {
    return (state.catalog?.domains ?? []).find((d) => d.id === state.domainId);
  }

  function renderDomains() {
    const domains = state.catalog?.domains ?? [];
    el.domains.innerHTML = domains
      .map(
        (d) => `<button class="tab domain-tab" data-id="${esc(d.id)}"
          aria-selected="${d.id === state.domainId}">${esc(`${d.icon || ''} ${d.name}`.trim())}</button>`
      )
      .join('');
  }

  function renderTopics() {
    const domain = currentDomain();
    const topics = domain?.topics ?? [];
    if (!topics.some((t) => t.id === state.topicId) && topics[0]) {
      state.topicId = topics[0].id;
    }
    el.topics.innerHTML = topics
      .map(
        (t) => `<button class="tab topic-tab" data-id="${esc(t.id)}"
          aria-selected="${t.id === state.topicId}">${esc(`${t.icon || ''} ${t.name}`.trim())}</button>`
      )
      .join('');

    el.legal.textContent =
      state.topicId === 'migrant'
        ? '本栏目仅索引政府网站公开信息，点击后跳转官网原文；不提供政策解读，也不转载正文。'
        : '';
  }

  function renderTabs() {
    const meta = topicMeta();
    const counts = state.day?.items.reduce((acc, i) => {
      acc[i.category] = (acc[i.category] ?? 0) + 1;
      return acc;
    }, {}) ?? {};
    const total = state.day?.items.length ?? 0;
    const known = meta?.categories ?? [];
    const order = [
      { name: '全部', icon: '', n: total },
      ...known.map((c) => ({ ...c, n: counts[c.name] ?? 0 })).filter((c) => c.n > 0),
    ];
    if (!order.some((c) => c.name === state.category)) state.category = '全部';

    el.tabs.innerHTML = order
      .map(
        (c) => `<button class="tab" role="tab" data-name="${esc(c.name)}"
          aria-selected="${c.name === state.category}">${esc(`${c.icon} ${c.name}`.trim())}<span class="n">${c.n}</span></button>`
      )
      .join('');
  }

  function renderList() {
    const isPolicy = state.topicId === 'migrant';
    const items = (state.day?.items ?? []).filter(
      (i) => state.category === '全部' || i.category === state.category
    );

    if (items.length === 0) {
      el.list.innerHTML = `<p class="empty">这一天还没有内容<br><span style="opacity:.6">${
        isPolicy ? '政策频道每天更新 1～2 次，且只收录标题命中关键词的公开信息' : '抓取任务每 30 分钟运行一次'
      }</span></p>`;
      el.footer.textContent = '';
      return;
    }

    el.list.innerHTML = items
      .map((i) => {
        const title = isPolicy ? i.title : i.interpret?.headline || i.title;
        const summary = isPolicy
          ? '点击打开政府网站原文'
          : i.interpret?.takeaway || i.summary || '';
        const bullets =
          !isPolicy && i.interpret?.bullets?.length
            ? `<ul class="card-bullets">${i.interpret.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
            : '';
        const original =
          !isPolicy && i.interpret?.headline && i.title && i.title !== i.interpret.headline
            ? `<p class="card-original">${esc(i.title)}</p>`
            : '';

        return `<article>
          <a class="card" href="${esc(i.url)}" target="_blank" rel="noopener">
            <div class="card-meta">
              <span class="chip">${esc(i.category)}</span>
              ${!isPolicy && i.interpret?.headline ? '<span class="chip chip-interpret">中文解读</span>' : ''}
              ${isPolicy ? '<span class="chip chip-policy">官网原文</span>' : ''}
              <span>${esc(i.source?.name ?? '')}</span>
              <span>·</span>
              <span>${esc(relativeTime(i.publishedAt))}</span>
              ${isPolicy ? '' : `<span class="${scoreClass(i.score)}">${i.score}</span>`}
            </div>
            <h2 class="card-title">${esc(title)}</h2>
            ${summary ? `<p class="card-summary">${esc(summary)}</p>` : ''}
            ${bullets}
            ${original}
          </a>
        </article>`;
      })
      .join('');

    const updated = state.day?.updatedAt ? relativeTime(state.day.updatedAt) : '';
    el.footer.textContent = `${items.length} 条${updated ? ` · ${updated}更新` : ''}`;
  }

  const renderSkeleton = () => {
    el.list.innerHTML = '<div class="skeleton"></div>'.repeat(4);
    el.footer.textContent = '';
  };

  function fillDates() {
    const days = topicMeta()?.days ?? [];
    if (days.length === 0) {
      el.date.innerHTML = '';
      el.list.innerHTML = `<p class="empty">还没有采集到内容<br><span style="opacity:.6">等待对应频道首次运行</span></p>`;
      return false;
    }
    el.date.innerHTML = days
      .slice(0, 30)
      .map((d) => `<option value="${d.date}">${dateLabel(d.date)}（${d.count}）</option>`)
      .join('');
    return true;
  }

  async function loadDay(key) {
    renderSkeleton();
    try {
      state.day = await loadJSON(dayDataUrl(key), { missingMessage: '这一天还没有内容' });
      state.date = key;
    } catch (err) {
      state.day = { items: [] };
      toast(err.message);
    }
    renderTabs();
    renderList();
  }

  async function switchTopic(topicId) {
    state.topicId = topicId;
    state.category = '全部';
    renderTopics();
    if (!fillDates()) return;
    await loadDay(el.date.value);
  }

  async function switchDomain(domainId) {
    state.domainId = domainId;
    const domain = currentDomain();
    state.topicId = domain?.topics?.[0]?.id ?? state.topicId;
    state.category = '全部';
    renderDomains();
    await switchTopic(state.topicId);
  }

  async function loadCatalog() {
    try {
      state.catalog = await loadJSON(`${DATA}/catalog.json`);
    } catch {
      // 兼容尚未生成 catalog 的旧部署：退回 AI index
      const index = await loadJSON(`${DATA}/index.json`);
      state.catalog = {
        brand: '每日简报',
        domains: [
          { id: 'tech', name: '数据科技', icon: '💻', topics: [{ id: 'ai', name: 'AI', icon: '🤖' }] },
        ],
        topics: {
          ai: { days: index.days, categories: index.categories, name: 'AI', icon: '🤖' },
        },
      };
    }
    el.brand.textContent = state.catalog.brand || '每日简报';
    document.title = state.catalog.brand || '每日简报';
  }

  async function boot() {
    renderSkeleton();
    try {
      await loadCatalog();
    } catch (err) {
      toast(err.message);
      el.list.innerHTML = `<p class="empty">暂时拿不到数据<br><span style="opacity:.6">稍后下拉刷新试试</span></p>`;
      return;
    }
    renderDomains();
    renderTopics();
    if (!fillDates()) return;
    await loadDay(el.date.value);
  }

  el.domains.addEventListener('click', (e) => {
    const tab = e.target.closest('.domain-tab');
    if (!tab) return;
    switchDomain(tab.dataset.id);
  });

  el.topics.addEventListener('click', (e) => {
    const tab = e.target.closest('.topic-tab');
    if (!tab) return;
    switchTopic(tab.dataset.id);
  });

  el.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || !tab.dataset.name) return;
    state.category = tab.dataset.name;
    renderTabs();
    renderList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  el.date.addEventListener('change', () => loadDay(el.date.value));

  el.refresh.addEventListener('click', async () => {
    el.refresh.classList.add('spinning');
    await loadCatalog();
    renderDomains();
    renderTopics();
    if (fillDates()) await loadDay(state.date ?? el.date.value);
    el.refresh.classList.remove('spinning');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.date) loadDay(state.date);
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  boot();
})();
