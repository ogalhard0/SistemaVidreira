'use strict';

// ---------- Camada de API (HTTP) ----------
class ApiClient {
  async request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falha na requisição.');
    return data;
  }
  get(u) { return this.request('GET', u); }
  post(u, b) { return this.request('POST', u, b); }
  put(u, b) { return this.request('PUT', u, b); }
  del(u) { return this.request('DELETE', u); }
}

// ---------- Interface ----------
class BackOffice {
  constructor(api) {
    this.api = api;
    this.$ = s => document.querySelector(s);
    this.countries = [];
    this.products = [];
    this.bindEvents();
  }

  async init() {
    try {
      this.countries = await this.api.get('/api/countries');
      this.$('#country').innerHTML = this.countries
        .map(c => `<option value="${c.id}">${esc(c.name)} (${c.currency})</option>`).join('');
      await Promise.all([this.loadCatalog(), this.loadProducts(), this.loadRates()]);
    } catch (e) { this.toast(e.message, true); }
  }

  bindEvents() {
    document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
      document.querySelectorAll('main section').forEach(s => s.hidden = s.id !== b.dataset.tab);
      if (b.dataset.tab === 'catalog') this.loadCatalog();
    }));
    this.$('#country').addEventListener('change', () => this.loadCatalog());
    this.$('#form').addEventListener('submit', e => { e.preventDefault(); this.saveProduct(); });
    this.$('#cancel').addEventListener('click', () => this.resetForm());
    this.$('#refresh').addEventListener('click', () => this.refreshRates());
    this.$('#productRows').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const id = +b.dataset.id;
      if (b.dataset.act === 'edit') this.editProduct(id);
      if (b.dataset.act === 'del') this.deleteProduct(id);
    });
  }

  toast(msg, error = false) {
    const t = this.$('#toast');
    t.textContent = msg; t.className = 'show' + (error ? ' err' : '');
    clearTimeout(this._t); this._t = setTimeout(() => t.className = '', 3500);
  }

  // Preços por país
  async loadCatalog() {
    try {
      const d = await this.api.get(`/api/catalog/${this.$('#country').value}`);
      const money = (v, cur) => new Intl.NumberFormat(d.country.locale, { style: 'currency', currency: cur }).format(v);
      const brl = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
      const when = d.rate.updated_at ? new Date(d.rate.updated_at).toLocaleString('pt-BR') : 'nunca';
      this.$('#rateInfo').textContent = `1 BRL = ${d.rate.rate} ${d.country.currency} · fonte: ${d.rate.source} · ${when}. Preço = custo × 2.`;
      this.$('#catalogRows').innerHTML = d.items.length ? d.items.map(i => `<tr>
        <td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td class="n">${i.capacity_ml} ml</td>
        <td class="n">${brl(i.cost_brl)}</td><td class="n">${brl(i.price_brl)}</td>
        <td class="n price">${money(i.price_local, i.currency)}</td></tr>`).join('')
        : '<tr><td colspan="6" class="empty">Nenhum produto cadastrado.</td></tr>';
    } catch (e) { this.toast(e.message, true); }
  }

  // Produtos
  async loadProducts() {
    this.products = await this.api.get('/api/products');
    const brl = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
    this.$('#productRows').innerHTML = this.products.length ? this.products.map(p => `<tr>
      <td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td class="n">${p.capacity_ml}</td>
      <td class="n">${brl(p.cost_brl)}</td><td class="n">${p.stock}</td>
      <td><div class="row"><button data-act="edit" data-id="${p.id}">Editar</button>
      <button class="danger" data-act="del" data-id="${p.id}">Excluir</button></div></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Cadastre o primeiro produto no formulário acima.</td></tr>';
  }

  async saveProduct() {
    const f = this.$('#form'), data = Object.fromEntries(new FormData(f));
    const id = data.id; delete data.id;
    try {
      if (id) await this.api.put(`/api/products/${id}`, data); else await this.api.post('/api/products', data);
      this.toast('Produto salvo.'); this.resetForm(); await this.loadProducts();
    } catch (e) { this.toast(e.message, true); }
  }

  editProduct(id) {
    const p = this.products.find(x => x.id === id), f = this.$('#form');
    Object.keys(p).forEach(k => { if (f.elements[k]) f.elements[k].value = p[k]; });
    this.$('#cancel').hidden = false; f.elements.sku.focus();
  }

  resetForm() { this.$('#form').reset(); this.$('#form').elements.id.value = ''; this.$('#cancel').hidden = true; }

  async deleteProduct(id) {
    const p = this.products.find(x => x.id === id);
    if (!confirm(`Excluir "${p.name}"?`)) return;
    try { await this.api.del(`/api/products/${id}`); this.toast('Produto excluído.'); await this.loadProducts(); }
    catch (e) { this.toast(e.message, true); }
  }

  // Câmbio
  async loadRates() {
    const rows = await this.api.get('/api/rates');
    this.$('#rateRows').innerHTML = rows.map(r => `<tr><td>${r.currency}</td><td class="n">${r.rate}</td>
      <td>${esc(r.source)}</td><td>${r.updated_at ? new Date(r.updated_at).toLocaleString('pt-BR') : '—'}</td></tr>`).join('');
  }

  async refreshRates() {
    try { await this.api.post('/api/rates/refresh'); this.toast('Câmbio atualizado.'); await this.loadRates(); }
    catch (e) { this.toast(e.message, true); }
  }
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

new BackOffice(new ApiClient()).init();
