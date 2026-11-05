# Loja + InfinitePay

## Como colocar no ar

1. No aplicativo InfinitePay: **Vendas → Checkout → Configurações → Habilitar Checkout Integrado**. Encontre sua **InfiniteTag** sem `$`.
2. Implante a pasta `infinitepay_backend` em hospedagem Node.js (o GitHub Pages **não** executa Node).
3. Configure as variáveis de ambiente no provedor de hospedagem:
   - `INFINITEPAY_HANDLE`: sua InfiniteTag sem `$`.
   - `SITE_ORIGIN`: URL exata do seu GitHub Pages, somente domínio/origem, ex.: `https://usuario.github.io`.
   - `INFINITEPAY_API_KEY`: chave secreta **opcional**, criada na InfinitePay. Necessária para descontos PIX automáticos e link de uso único. Nunca coloque no HTML/GitHub.
   - `DESCONTO_PIX`: ex.: `5` (somente com API Key; desconto aplicado pela InfinitePay, não pelo HTML).
4. No arquivo `catalogo.json`, cadastre **cada produto com ID e preço em centavos** igual ao site. Ex.: produto 1 de R$18 = `1800`. Toda mudança de preço feita no site precisa ser refletida no catálogo seguro do backend; caso contrário, a cobrança será feita pelo preço do servidor. O sistema rejeita produtos sem cadastro.
5. No HTML, entre como administrador → Configurações → Endereço do servidor InfinitePay. Salve a URL https do backend. O PIX manual antigo permanece opcional.
6. A compra abre o checkout seguro da InfinitePay, onde o cliente escolhe Pix ou cartão e o QR Code é gerado pela InfinitePay.

**Atenção:** a integração está preparada mas não há cobrança ativa até você configurar e hospedar o backend e o catálogo. A InfinitePay não fornece ambiente sandbox; faça um teste controlado de valor baixo quando estiver pronto. **Este exemplo não confirma pedidos automaticamente**. Para colocar em produção, implemente persistência de pedidos em banco de dados e validação de eventos de pagamento com `/payment_check` no backend antes de liberar mercadorias. Também implemente gestão de estoque e administração segura no servidor. O login de administrador do HTML atual não protege o backend. Não use a senha fixa do HTML para produção.

Documentação: https://www.infinitepay.io/checkout-documentacao

## Correção do valor do carrinho (importante)

O site **não usa a foto do QR Code fixo** para pagamentos automáticos. Ao clicar **Pagar com InfinitePay**, envia ao backend os IDs, quantidades, frete e o total esperado. O backend calcula os preços de `catalogo.json` e **recusa criar o link** quando há divergência, para evitar cobrar valor diferente.

**Atualize seu catálogo assim:**
1. No HTML aberto como administrador, clique **Baixar catálogo de preços para o servidor InfinitePay**.
2. No GitHub, abra o repositório `infinitepay-backend`, entre na pasta `infinitepay_backend` e substitua `catalogo.json` pelo arquivo baixado; confirme o commit. Se seus arquivos estão na raiz do repositório, substitua ali.
3. O Render, conectado ao GitHub, deve fazer o deploy do commit; confirme o status `Live`.
4. Teste o checkout novamente e **confira o valor final no site da InfinitePay** antes de pagar.

O arquivo original de exemplo só tinha produto 1 a R$ 18,00. Os produtos que você criou no navegador precisam estar no catálogo seguro do servidor. Apenas alterar preços no navegador de um administrador **não** atualiza automaticamente o servidor e **não** atualiza outras pessoas que abriram a loja.

**Atenção ao uso em produção:** esta versão ainda é protótipo. A administração do HTML usa dados locais e não garante catálogo compartilhado entre clientes, a confirmação de pagamento ainda não foi implementada, e os links sem `single_payment` podem permitir pagamentos repetidos. Para vender de verdade, é preciso banco de dados, painel administrativo autenticado no servidor, sincronização de preços/estoque e verificação dos pagamentos pela API `payment_check`/webhooks. A API Key deve ficar somente nas variáveis de ambiente do Render.

O desconto PIX que aparece no HTML refere-se exclusivamente ao PIX manual. O checkout InfinitePay só usa `DESCONTO_PIX` quando `INFINITEPAY_API_KEY` estiver configurada no servidor. Sem ela, o valor do link será o valor integral calculado.
