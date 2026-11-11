# GlassExport — Back-office

Requisitos: Node.js 22.5+ (usa o módulo nativo node:sqlite, sem compilar nada).

    npm install
    npm start        # http://localhost:3000

- Regra de preço: `preço = custo (BRL) × (1 + 100%) × câmbio do país de destino`
- Câmbio: open.er-api.com (sem chave), cache de 6h no SQLite; se a API falhar, usa o último valor salvo (ou o de reserva).
- O lucro fica em `CONFIG.markup` no `server.js`.
