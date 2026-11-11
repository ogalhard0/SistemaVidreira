'use strict';
const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // SQLite nativo do Node (sem compilação)

// ---------- Configuração ----------
const CONFIG = {
  port: process.env.PORT || 3000,
  markup: 1.0,                       // 100% de lucro sobre o custo
  baseCurrency: 'BRL',               // custo cadastrado em reais
  rateTtlMs: 6 * 60 * 60 * 1000,     // câmbio considerado atual por 6h
  rateApi: 'https://open.er-api.com/v6/latest/BRL',
};

class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// ---------- Modelo ----------
class Product {
  constructor({ id = null, sku, name, capacity_ml, cost_brl, stock = 0 }) {
    this.id = id;
    this.sku = String(sku || '').trim().toUpperCase();
    this.name = String(name || '').trim();
    this.capacity_ml = Number(capacity_ml);
    this.cost_brl = Number(cost_brl);
    this.stock = Number(stock);
    this.validate();
  }
  validate() {
    if (!this.sku || !this.name) throw new AppError('SKU e nome são obrigatórios.');
    if (!(this.capacity_ml > 0)) throw new AppError('Capacidade deve ser maior que zero.');
    if (!(this.cost_brl >= 0)) throw new AppError('Custo inválido.');
    if (!Number.isInteger(this.stock) || this.stock < 0) throw new AppError('Estoque deve ser um inteiro ≥ 0.');
  }
  priceBRL(markup) { return this.cost_brl * (1 + markup); }
}

// ---------- Banco de dados ----------
class Database {
  constructor(file) {
    this.conn = new DatabaseSync(file);
    this.conn.exec('PRAGMA journal_mode = WAL');
    this.migrate();
    this.seed();
  }
  migrate() {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        capacity_ml REAL NOT NULL, cost_brl REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS countries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE, currency TEXT NOT NULL, locale TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rates (
        currency TEXT PRIMARY KEY, rate REAL NOT NULL,
        source TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  }
  seed() {
    const c = this.conn;
    if (!c.prepare('SELECT COUNT(*) n FROM countries').get().n) {
      const ins = c.prepare('INSERT INTO countries (name,currency,locale) VALUES (?,?,?)');
      [['Brasil','BRL','pt-BR'],['Estados Unidos','USD','en-US'],['Alemanha','EUR','de-DE'],
       ['França','EUR','fr-FR'],['Reino Unido','GBP','en-GB'],['Japão','JPY','ja-JP'],
       ['China','CNY','zh-CN'],['Argentina','ARS','es-AR'],['México','MXN','es-MX'],
       ['Canadá','CAD','en-CA']].forEach(r => ins.run(...r));
    }
    // Câmbio de reserva (aproximado), usado só se a API estiver indisponível.
    const fb = { BRL:1, USD:0.18, EUR:0.16, GBP:0.14, JPY:27, CNY:1.3, ARS:250, MXN:3.3, CAD:0.25 };
    const r = c.prepare("INSERT OR IGNORE INTO rates VALUES (?,?,'reserva',0)");
    Object.entries(fb).forEach(([k, v]) => r.run(k, v));
    if (!c.prepare('SELECT COUNT(*) n FROM products').get().n) {
      const p = c.prepare('INSERT INTO products (sku,name,capacity_ml,cost_brl,stock) VALUES (?,?,?,?,?)');
      [['CP-300','Copo long drink',300,4.8,1200],['CP-200','Copo americano',200,3.2,3000],
       ['TA-350','Taça de vinho',350,9.5,800],['CP-80','Copo de shot',80,2.1,5000]].forEach(r => p.run(...r));
    }
  }
}

// ---------- Repositórios ----------
class ProductRepository {
  constructor(db) { this.c = db.conn; }
  all() { return this.c.prepare('SELECT * FROM products ORDER BY name').all().map(r => new Product(r)); }
  find(id) {
    const r = this.c.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (!r) throw new AppError('Produto não encontrado.', 404);
    return new Product(r);
  }
  create(p) {
    try {
      const i = this.c.prepare('INSERT INTO products (sku,name,capacity_ml,cost_brl,stock) VALUES (?,?,?,?,?)')
        .run(p.sku, p.name, p.capacity_ml, p.cost_brl, p.stock);
      return this.find(Number(i.lastInsertRowid));
    } catch (e) { throw this.#map(e); }
  }
  update(id, p) {
    this.find(id);
    try {
      this.c.prepare('UPDATE products SET sku=?,name=?,capacity_ml=?,cost_brl=?,stock=? WHERE id=?')
        .run(p.sku, p.name, p.capacity_ml, p.cost_brl, p.stock, id);
      return this.find(id);
    } catch (e) { throw this.#map(e); }
  }
  remove(id) { this.find(id); this.c.prepare('DELETE FROM products WHERE id=?').run(id); }
  #map(e) { return /UNIQUE/.test(e.message) ? new AppError('SKU já cadastrado.', 409) : e; }
}

class CountryRepository {
  constructor(db) { this.c = db.conn; }
  all() { return this.c.prepare('SELECT * FROM countries ORDER BY name').all(); }
  find(id) {
    const r = this.c.prepare('SELECT * FROM countries WHERE id=?').get(id);
    if (!r) throw new AppError('País não encontrado.', 404);
    return r;
  }
}

class RateRepository {
  constructor(db) { this.c = db.conn; }
  all() { return this.c.prepare('SELECT * FROM rates ORDER BY currency').all(); }
  get(cur) {
    const r = this.c.prepare('SELECT * FROM rates WHERE currency=?').get(cur);
    if (!r) throw new AppError(`Sem câmbio para ${cur}.`, 422);
    return r;
  }
  upsert(cur, rate, source) {
    this.c.prepare(`INSERT INTO rates VALUES (?,?,?,?)
      ON CONFLICT(currency) DO UPDATE SET rate=excluded.rate, source=excluded.source, updated_at=excluded.updated_at`)
      .run(cur, rate, source, Date.now());
  }
  lastUpdate() { return this.c.prepare("SELECT MAX(updated_at) t FROM rates WHERE source='api'").get().t || 0; }
}

// ---------- Serviços ----------
class CurrencyService {
  constructor(rates, countries) { this.rates = rates; this.countries = countries; }
  async refresh() {
    const res = await fetch(CONFIG.rateApi, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new AppError('API de câmbio indisponível.', 502);
    const data = await res.json();
    if (data.result !== 'success') throw new AppError('Resposta inválida da API de câmbio.', 502);
    const wanted = new Set(this.countries.all().map(c => c.currency));
    wanted.forEach(cur => { if (data.rates[cur]) this.rates.upsert(cur, data.rates[cur], 'api'); });
  }
  async ensureFresh() {
    if (Date.now() - this.rates.lastUpdate() < CONFIG.rateTtlMs) return;
    try { await this.refresh(); } catch (e) { console.warn('Câmbio: usando último valor salvo.', e.message); }
  }
  rateFor(cur) { return this.rates.get(cur); }
}

class PricingService {
  constructor(currency, markup) { this.currency = currency; this.markup = markup; }
  quote(product, country) {
    const r = this.currency.rateFor(country.currency);
    return {
      id: product.id, sku: product.sku, name: product.name,
      capacity_ml: product.capacity_ml, stock: product.stock,
      cost_brl: product.cost_brl,
      price_brl: product.priceBRL(this.markup),
      price_local: product.priceBRL(this.markup) * r.rate,
      currency: country.currency,
    };
  }
}

// ---------- API ----------
const db = new Database(path.join(__dirname, 'glassexport.db'));
const products = new ProductRepository(db);
const countries = new CountryRepository(db);
const rates = new RateRepository(db);
const currency = new CurrencyService(rates, countries);
const pricing = new PricingService(currency, CONFIG.markup);

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_, res) => res.json({ markupPercent: CONFIG.markup * 100, baseCurrency: CONFIG.baseCurrency }));
app.get('/api/countries', (_, res) => res.json(countries.all()));
app.get('/api/products', (_, res) => res.json(products.all()));
app.post('/api/products', (req, res) => res.status(201).json(products.create(new Product(req.body))));
app.put('/api/products/:id', (req, res) => res.json(products.update(+req.params.id, new Product(req.body))));
app.delete('/api/products/:id', (req, res) => { products.remove(+req.params.id); res.status(204).end(); });

app.get('/api/catalog/:countryId', wrap(async (req, res) => {
  const country = countries.find(+req.params.countryId);
  await currency.ensureFresh();
  const rate = currency.rateFor(country.currency);
  res.json({ country, rate, items: products.all().map(p => pricing.quote(p, country)) });
}));

app.get('/api/rates', (_, res) => res.json(rates.all()));
app.post('/api/rates/refresh', wrap(async (_, res) => { await currency.refresh(); res.json(rates.all()); }));

app.use('/api', (_, __, next) => next(new AppError('Rota não encontrada.', 404)));
app.use((err, _req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno do servidor.' });
});

app.listen(CONFIG.port, () => console.log(`GlassExport back-office em http://localhost:${CONFIG.port}`));
