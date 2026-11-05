// Node.js 20+. Catálogo e valores são definidos no servidor, nunca confiados ao cliente.
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const PORT = Number(process.env.PORT || 3000);
const HANDLE = String(process.env.INFINITEPAY_HANDLE || '').replace(/^\$/, '').trim();
const API_KEY = String(process.env.INFINITEPAY_API_KEY || '').trim();
const SITE_ORIGIN = String(process.env.SITE_ORIGIN || '').replace(/\/$/, '');
const DESCONTO_PIX = Number(process.env.DESCONTO_PIX || 0);
const CATALOGO = JSON.parse(fs.readFileSync(new URL('./catalogo.json', 'file://' + __filename), 'utf8'));
const fretes = {'Retirada no Local': 0, 'Correios': 890, 'Entrega': 1490};
const pedidos = new Map(); // DEMONSTRAÇÃO: usar banco de dados durável em produção
function resposta(res, status, data) {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':SITE_ORIGIN || 'null','Vary':'Origin','Cache-Control':'no-store'}); res.end(JSON.stringify(data));}
function permitir(req,res) {const origem=req.headers.origin || ''; if (SITE_ORIGIN && origem!==SITE_ORIGIN) {resposta(res,403,{error:'Origem não autorizada'}); return false;} return true;}
function lerCorpo(req) {return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>20000) {reject(new Error('Pedido muito grande'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(s));}catch{reject(new Error('JSON inválido'));}});req.on('error',reject);});}
http.createServer(async(req,res)=>{
 if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':SITE_ORIGIN || 'null','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'});return res.end();}
 if(req.url==='/health'&&req.method==='GET') return resposta(res,200,{ok:true,checkoutConfigurado:!!HANDLE});
 if(!permitir(req,res)) return;
 if(req.url==='/api/checkout'&&req.method==='POST'){
  try {
   if(!HANDLE) throw new Error('Configure INFINITEPAY_HANDLE no servidor');
   const body=await lerCorpo(req);
   if(!Array.isArray(body.itens)||!body.itens.length||body.itens.length>30) throw new Error('Carrinho inválido');
   if(!Object.hasOwn(fretes,body.frete)) throw new Error('Frete inválido');
   const items=body.itens.map(x=>{
      const id=String(x.id), q=Number(x.quantidade), p=CATALOGO[id];
      if(!p||!Number.isInteger(q)||q<1||q>100||!Number.isInteger(p.precoCentavos)||p.precoCentavos<100) throw new Error('Produto ou quantidade não permitido no catálogo do servidor: '+id);
      return {quantity:q,price:p.precoCentavos,description:String(p.nome).slice(0,90)};
   });
   if(fretes[body.frete]>0)items.push({quantity:1,price:fretes[body.frete],description:'Frete - '+body.frete});
   const valorCentavos=items.reduce((s,i)=>s+i.price*i.quantity,0);
   if(!Number.isSafeInteger(body.valorEsperadoCentavos) || body.valorEsperadoCentavos!==valorCentavos) {
       throw new Error('Preço da loja diferente do catálogo do servidor. No painel administrativo, baixe catalogo.json e atualize o arquivo no GitHub. Valor seguro do servidor: R$ '+(valorCentavos/100).toFixed(2).replace('.',','));
   }
   const order_nsu=crypto.randomUUID();
   const payload={handle:HANDLE,order_nsu,items};
   if(SITE_ORIGIN.startsWith('https://'))payload.redirect_url=SITE_ORIGIN+'/';
   // API Key necessária para opções avançadas, inclusive desconto por meio de pagamento.
   if(API_KEY){payload.options={single_payment:true};if(DESCONTO_PIX>0&&DESCONTO_PIX<100)payload.options.discounts={pix:DESCONTO_PIX};}
   const headers={'Content-Type':'application/json'};
   if(API_KEY)headers['X-Api-Key']=API_KEY;
   const r=await fetch('https://api.checkout.infinitepay.io/links',{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
   const dados=await r.json();
   if(!r.ok)throw new Error(dados.message || dados.error || 'Erro ao criar cobrança na InfinitePay');
   const url=dados.url || dados.checkout_url || dados.link;
   if(typeof url!=='string'||!url.startsWith('https://'))throw new Error('Resposta inesperada do provedor');
   pedidos.set(order_nsu,{items,amount:items.reduce((s,i)=>s+i.price*i.quantity,0),paid:false});
   resposta(res,200,{url,order_nsu,valorCentavos});
  }catch(e){resposta(res,400,{error:e.message});}return;
 }
 resposta(res,404,{error:'Rota inexistente'});
}).listen(PORT,()=>console.log('Servidor InfinitePay na porta',PORT));
