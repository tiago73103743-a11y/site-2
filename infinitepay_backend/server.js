// Node 20+. Produtos e valores reais são conferidos no Firestore, não no HTML.
const http=require('node:http');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {URL}=require('node:url');
const admin=require('firebase-admin');
const PORT=Number(process.env.PORT||3000);
const HANDLE=String(process.env.INFINITEPAY_HANDLE||'').replace(/^\$/,'').trim();
const API_KEY=String(process.env.INFINITEPAY_API_KEY||'').trim();
const SITE_ORIGIN=String(process.env.SITE_ORIGIN||'').replace(/\/$/,'');
const ADMIN_EMAIL=String(process.env.ADMIN_EMAIL||'').toLowerCase().trim();
const DESCONTO_PIX=Number(process.env.DESCONTO_PIX||0);
const CATALOGO_INICIAL=JSON.parse(fs.readFileSync(new URL('./catalogo.json','file://'+__filename),'utf8'));
const fretes={'Retirada no Local':0,'Correios':890,'Entrega':1490};
let db=null;
try {
  if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
    const conta=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({credential:admin.credential.cert(conta)});
    db=admin.firestore();
  } else console.warn('Firestore não configurado; edição online desabilitada.');
} catch(e){console.error('Firebase Admin inválido:',e.message);}
function cors(req){const origem=req.headers.origin||'';return !SITE_ORIGIN||origem===SITE_ORIGIN;}
function json(req,res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':SITE_ORIGIN||'null','Vary':'Origin','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function corpo(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>30000){reject(new Error('Corpo muito grande'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'));}catch{reject(new Error('JSON inválido'));}});req.on('error',reject);});}
async function verificarAdmin(req){
  if(!db||!ADMIN_EMAIL)throw new Error('ADMIN_EMAIL ou Firestore não configurado.');
  const token=String(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
  if(!token)throw new Error('Faça login com Firebase para administrar.');
  const usuario=await admin.auth().verifyIdToken(token,true);
  if(!usuario.email_verified||usuario.email?.toLowerCase()!==ADMIN_EMAIL)throw new Error('Conta sem permissão de administrador.');
  return usuario;
}
async function catalogo(){
  const produtos={};
  for(const [id,p] of Object.entries(CATALOGO_INICIAL)){
    if(/^\d+$/.test(id))produtos[id]={nome:String(p.nome),precoCentavos:Number(p.precoCentavos),estoque:50};
  }
  if(db){
    const snap=await db.collection('produtos').get();
    snap.forEach(doc=>{
      const p=doc.data();
      if(p.excluido){delete produtos[doc.id];return;}
      if(/^\d+$/.test(doc.id))produtos[doc.id]={nome:p.nome,precoCentavos:p.precoCentavos,estoque:p.estoque};
    });
  }
  return produtos;
}
const pedidos=new Map(); // Teste: falta persistência e confirmação pela API para produção
http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){
    res.writeHead(cors(req)?204:403,{'Access-Control-Allow-Origin':SITE_ORIGIN||'null','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Vary':'Origin'});return res.end();
  }
  if(!cors(req))return json(req,res,403,{error:'Origem não autorizada'});
  try {
    if(req.url==='/health'&&req.method==='GET')return json(req,res,200,{ok:true,checkoutConfigurado:!!HANDLE,bancoConfigurado:!!db});
    if(req.url==='/api/produtos'&&req.method==='GET')return json(req,res,200,{produtos:await catalogo()});
    if(req.url==='/api/admin/me'&&req.method==='GET'){
      await verificarAdmin(req);return json(req,res,200,{admin:true});
    }
    const rota=req.url.match(/^\/api\/admin\/produtos\/(\d+)$/);
    if(rota&&(req.method==='PUT'||req.method==='DELETE')){
      await verificarAdmin(req);
      const id=rota[1];
      if(!db)throw new Error('Banco indisponível');
      if(req.method==='DELETE'){
        await db.collection('produtos').doc(id).set({excluido:true});
        return json(req,res,200,{ok:true});
      }
      const body=await corpo(req);
      const nome=String(body.nome||'').trim(),precoCentavos=Number(body.precoCentavos),estoque=Number(body.estoque);
      if(!nome||nome.length>90||!Number.isSafeInteger(precoCentavos)||precoCentavos<100||precoCentavos>100000000||!Number.isSafeInteger(estoque)||estoque<0||estoque>100000) return json(req,res,400,{error:'Dados do produto inválidos'});
      await db.collection('produtos').doc(id).set({nome,precoCentavos,estoque,atualizadoEm:admin.firestore.FieldValue.serverTimestamp()});
      return json(req,res,200,{ok:true});
    }
    if(req.url==='/api/checkout'&&req.method==='POST'){
      if(!HANDLE)return json(req,res,503,{error:'Configure INFINITEPAY_HANDLE no Render.'});
      const body=await corpo(req);
      if(!Array.isArray(body.itens)||body.itens.length<1||body.itens.length>30||!Object.hasOwn(fretes,body.frete))return json(req,res,400,{error:'Carrinho ou frete inválido'});
      const produtos=await catalogo();
      const items=body.itens.map(x=>{
        const id=String(x.id),q=Number(x.quantidade),p=produtos[id];
        if(!p||!Number.isSafeInteger(q)||q<1||q>100||!Number.isSafeInteger(p.precoCentavos)||p.precoCentavos<100||q>p.estoque)throw new Error('Produto ou quantidade não permitido no catálogo do servidor: '+id);
        return {quantity:q,price:p.precoCentavos,description:String(p.nome).slice(0,90)};
      });
      if(fretes[body.frete])items.push({quantity:1,price:fretes[body.frete],description:'Frete - '+body.frete});
      const valorCentavos=items.reduce((s,i)=>s+i.price*i.quantity,0);
      if(!Number.isSafeInteger(body.valorEsperadoCentavos)||body.valorEsperadoCentavos!==valorCentavos)return json(req,res,409,{error:'Preço da loja desatualizado. Atualize a página e tente de novo. Valor seguro do servidor: R$ '+(valorCentavos/100).toFixed(2).replace('.',',')});
      const order_nsu=crypto.randomUUID(),payload={handle:HANDLE,order_nsu,items};
      if(SITE_ORIGIN.startsWith('https://'))payload.redirect_url=SITE_ORIGIN+'/site-2/';
      if(API_KEY){payload.options={single_payment:true};if(DESCONTO_PIX>0&&DESCONTO_PIX<100)payload.options.discounts={pix:DESCONTO_PIX};}
      const headers={'Content-Type':'application/json'};
      if(API_KEY)headers['X-Api-Key']=API_KEY;
      const respostaApi=await fetch('https://api.checkout.infinitepay.io/links',{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
      const dados=await respostaApi.json();
      if(!respostaApi.ok)return json(req,res,502,{error:dados.message||dados.error||'Falha ao criar cobrança na InfinitePay'});
      const url=dados.url||dados.checkout_url||dados.link;
      if(typeof url!=='string'||!url.startsWith('https://'))throw new Error('Checkout retornou URL inválida');
      pedidos.set(order_nsu,{valorCentavos,paid:false});
      return json(req,res,200,{url,order_nsu,valorCentavos});
    }
    return json(req,res,404,{error:'Rota inexistente'});
  }catch(e){console.error('Erro API:',e.message);return json(req,res,400,{error:e.message||'Erro interno'});}
}).listen(PORT,()=>console.log('Servidor InfinitePay com catálogo Firestore na porta',PORT));
