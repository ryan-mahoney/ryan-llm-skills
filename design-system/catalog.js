/* Offline catalog appearance controls. Storage failure keeps defaults usable. */
(() => {
  const key = 'agent-tooling.design-system.appearance';
  const valid = { theme: ['dark', 'light'], textScale: ['normal', 'large'] };
  const parameters = new URLSearchParams(location.search);
  let retained = {};
  try { retained = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { /* Storage is optional. */ }
  const appearance = {};
  for (const [name, values] of Object.entries(valid)) {
    const query = parameters.get(name === 'textScale' ? 'text-scale' : name);
    appearance[name] = values.includes(query) ? query : values.includes(retained[name]) ? retained[name] : values[0];
  }
  function apply() {
    document.body.dataset.theme = appearance.theme;
    document.body.dataset.textScale = appearance.textScale;
    for (const control of document.querySelectorAll('[data-theme-control]')) control.value = appearance.theme;
    for (const control of document.querySelectorAll('[data-scale-control]')) control.value = appearance.textScale;
    try { localStorage.setItem(key, JSON.stringify(appearance)); } catch { /* Private/sandboxed sessions still work. */ }
    document.dispatchEvent(new CustomEvent('catalog:appearance', { detail: { ...appearance } }));
  }
  document.addEventListener('change', event => {
    const control = event.target;
    if (control.matches('[data-theme-control]') && valid.theme.includes(control.value)) appearance.theme = control.value;
    else if (control.matches('[data-scale-control]') && valid.textScale.includes(control.value)) appearance.textScale = control.value;
    else return;
    apply();
  });
  apply();
  // Keep dense tables readable at phone widths, including regenerated calendars.
  function prepareTables() {
    for (const table of document.querySelectorAll('.catalog-content table:not(.catalog-wide-table)')) {
      if ((table.rows[0]?.cells.length || 0) < 4) continue;
      table.classList.add('catalog-wide-table');
      const parent = table.parentElement;
      if (parent.matches('.demo-scroll, .overflow-x-auto, .catalog-table-scroll')) {
        parent.classList.add('catalog-table-scroll');
        continue;
      }
      const scroll = document.createElement('div');
      scroll.className = 'catalog-table-scroll';
      scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', table.getAttribute('aria-label') || 'Scrollable table');
      table.before(scroll);
      scroll.append(table);
    }
  }
  prepareTables();
  const content = document.querySelector('.catalog-content');
  if (content) new MutationObserver(prepareTables).observe(content, { childList: true, subtree: true });
})();
