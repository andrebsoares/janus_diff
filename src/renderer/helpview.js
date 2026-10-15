'use strict';
// User Guide view: docs/AJUDA.md rendered in a tab, with a table of contents.

class HelpView {
  constructor(app) {
    this.app = app;
    this.type = 'help';
    this.title = 'User Guide';
    this.keymap = {};
    this.toc = h('nav', { class: 'help-toc' });
    this.content = h('div', { class: 'help-content', tabIndex: -1 });
    this.content.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      e.preventDefault();
      this.scrollTo(a.getAttribute('href').slice(1));
    });
    this.el = h('div', { class: 'view helpview' }, this.toc, this.content);
    this.load();
  }

  async load() {
    let md;
    try {
      md = await api.guide();
    } catch (err) {
      this.content.replaceChildren(h('p', {}, `The User Guide could not be loaded: ${err.message}`));
      return;
    }
    const { html, headings } = Markdown.render(md);
    this.content.innerHTML = html;
    this.toc.replaceChildren(...headings.filter((x) => x.level === 2 || x.level === 3).map((x) => h('a', {
      class: 'help-toc-item lvl' + x.level, href: '#' + x.id,
      onclick: (e) => { e.preventDefault(); this.scrollTo(x.id); },
    }, x.text)));
  }

  scrollTo(id) {
    const target = this.content.querySelector(`[id="${CSS.escape(id)}"]`);
    if (target) this.content.scrollTop = target.offsetTop - this.content.offsetTop - 8;
  }

  onShow() {
    this.content.focus();
  }

  onClose() {
    return true;
  }

  command() {
    return false;
  }
}
