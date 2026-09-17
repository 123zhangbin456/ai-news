(() => {
  'use strict';

  const DATA = './data';
  const el = {
    tabs: document.getElementById('tabs'),
    list: document.getElementById('list'),
    date: document.getElementById('date-select'),
    refresh: document.getElementById('refresh'),
    footer: document.getElementById('footer'),
    toast: document.getElementById('toast'),
  };

  const state = { index: null, day: null, category: '全部', date: null };

  /* ---------- 轻提示：自动消失，同一条不重复弹 ---------- */

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

  /** 只向用户展示可理解的文案，不暴露状态码和堆栈 */
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

  /* ---------- 展示辅助 ---------- */

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

  /* ---------- 渲染 ---------- */

  function renderTabs() {
    const counts = state.day?.items.reduce((acc, i) => {
      acc[i.category] = (acc[i.category] ?? 0) + 1;
      return acc;
    }, {}) ?? {};

    const total = state.day?.items.length ?? 0;
    const known = state.index?.categories ?? [];
    const order = [
      { name: '全部', icon: '' , n: total },
      ...known
        .map((c) => ({ ...c, n: counts[c.name] ?? 0 }))
        .filter((c) => c.n > 0),
    ];

    // 当前选中的分类今天没内容时，回到全部，避免停在一个空列表上
    if (!order.some((c) => c.name === state.category)) state.category = '全部';

    el.tabs.innerHTML = order
      .map(
        (c) => `<button class="tab" role="tab" data-name="${esc(c.name)}"
          aria-selected="${c.name === state.category}">${esc(`${c.icon} ${c.name}`.trim())}<span class="n">${c.n}</span></button>`
      )
      .join('');
  }

  function renderList() {
    const items = (state.day?.items ?? []).filter(
      (i) => state.category === '全部' || i.category === state.category
    );

    if (items.length === 0) {
      el.list.innerHTML = `<p class="empty">这一天还没有内容<br><span style="opacity:.6">抓取任务每 30 分钟运行一次</span></p>`;
      el.footer.textContent = '';
      return;
    }

    el.list.innerHTML = items
      .map((i) => {
        const related = i.related?.length
          ? `<details class="related"><summary>相关报道 ${i.related.length}</summary>${i.related
              .map((r) => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source)}：${esc(r.title)}</a>`)
              .join('')}</details>`
          : '';

        return `<article>
          <a class="card" href="${esc(i.url)}" target="_blank" rel="noopener">
            <div class="card-meta">
              <span class="chip">${esc(i.category)}</span>
              ${i.interpret?.headline ? '<span class="chip chip-interpret">中文解读</span>' : ''}
              <span>${esc(i.source?.name ?? '')}</span>
              <span>·</span>
              <span>${esc(relativeTime(i.publishedAt))}</span>
              <span class="${scoreClass(i.score)}">${i.score}</span>
            </div>
            <h2 class="card-title">${esc(i.interpret?.headline || i.title)}</h2>
            ${
              i.interpret?.takeaway
                ? `<p class="card-summary">${esc(i.interpret.takeaway)}</p>`
                : i.summary
                  ? `<p class="card-summary">${esc(i.summary)}</p>`
                  : ''
            }
            ${
              i.interpret?.bullets?.length
                ? `<ul class="card-bullets">${i.interpret.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
                : ''
            }
            ${
              i.interpret?.headline && i.title && i.title !== i.interpret.headline
                ? `<p class="card-original">${esc(i.title)}</p>`
                : ''
            }
          </a>
          ${related}
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

  /* ---------- 加载 ---------- */

  async function loadDay(key) {
    renderSkeleton();
    try {
      state.day = await loadJSON(`${DATA}/${key}.json`, { missingMessage: '这一天还没有内容' });
      state.date = key;
    } catch (err) {
      state.day = { items: [] };
      toast(err.message);
    }
    renderTabs();
    renderList();
  }

  async function loadIndex() {
    try {
      state.index = await loadJSON(`${DATA}/index.json`);
    } catch (err) {
      toast(err.message);
      el.list.innerHTML = `<p class="empty">暂时拿不到数据<br><span style="opacity:.6">稍后下拉刷新试试</span></p>`;
      return false;
    }

    const days = state.index.days ?? [];
    if (days.length === 0) {
      el.list.innerHTML = `<p class="empty">还没有采集到内容<br><span style="opacity:.6">首次抓取任务运行后就会出现</span></p>`;
      return false;
    }

    el.date.innerHTML = days
      .slice(0, 30)
      .map((d) => `<option value="${d.date}">${dateLabel(d.date)}（${d.count}）</option>`)
      .join('');
    return true;
  }

  async function boot() {
    renderSkeleton();
    if (!(await loadIndex())) return;
    await loadDay(el.date.value);
  }

  /* ---------- 交互 ---------- */

  el.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.category = tab.dataset.name;
    renderTabs();
    renderList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  el.date.addEventListener('change', () => loadDay(el.date.value));

  el.refresh.addEventListener('click', async () => {
    el.refresh.classList.add('spinning');
    await loadIndex();
    await loadDay(state.date ?? el.date.value);
    el.refresh.classList.remove('spinning');
  });

  // 从后台切回来时自动取最新，省得手动点刷新
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.date) loadDay(state.date);
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  boot();
})();
