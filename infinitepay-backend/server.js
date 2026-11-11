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
const ADMIN_PASSWORD=String(process.env.ADMIN_PASSWORD||'');
const ADMIN_SESSION_SECRET=String(process.env.ADMIN_SESSION_SECRET||'');
const DESCONTO_PIX=Number(process.env.DESCONTO_PIX||0);
const PUBLIC_BACKEND_URL=String(process.env.PUBLIC_BACKEND_URL||'https://infinitepay-backend.onrender.com').replace(/\/$/,'');
// O login dos clientes utiliza outro projeto Firebase; o Firestore continua no projeto da loja.
const CLIENT_FIREBASE_PROJECT_ID=String(process.env.CLIENT_FIREBASE_PROJECT_ID||'e-mail-2fc5e').trim();
let clienteAuth=null;
const CATALOGO_INICIAL=JSON.parse(fs.readFileSync(new URL('./catalogo.json','file://'+__filename),'utf8'));
const fretes={'Retirada no Local':0,'Correios':890,'Entrega':1490};
let db=null;
try {
  if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
    const conta=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({credential:admin.credential.cert(conta)});
    db=admin.firestore();
    // Uma segunda instância valida tokens emitidos pelo Firebase Authentication dos clientes.
    // A credencial do Firestore não é substituída e nenhuma chave do projeto de login é necessária.
    const appCliente=admin.initializeApp({
      credential:admin.credential.cert(conta),
      projectId:CLIENT_FIREBASE_PROJECT_ID
    },'autenticacao-clientes');
    clienteAuth=appCliente.auth();
  } else console.warn('Firestore não configurado; edição online desabilitada.');
 } catch(e){
  console.error('Firebase Admin inválido:',e.message);
}

function imagemValida(s){return typeof s==='string'&&s.length<=650000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s);}
function cors(req) {
    const origem = req.headers.origin || '';

    // Permite consultas GET abertas diretamente no navegador
    if (!origem && req.method === 'GET') {
        return true;
    }

    // Mantém a restrição para origens não autorizadas
    return !SITE_ORIGIN || origem === SITE_ORIGIN;
}
function json(req,res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':SITE_ORIGIN||'null','Vary':'Origin','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function corpo(req){return new Promise((resolve,reject)=>{let s='';let excedeu=false;req.on('data',c=>{if(excedeu)return;s+=c;if(s.length>750000){excedeu=true;s='';reject(new Error('Imagem acima do limite aceito pelo servidor (750 KB).'));}});req.on('end',()=>{if(excedeu)return;try{resolve(JSON.parse(s||'{}'));}catch{reject(new Error('JSON inválido'));}});req.on('error',reject);});}
// Sessões de administração temporárias, assinadas e verificadas no servidor.
// Configure ADMIN_PASSWORD (senha forte) e ADMIN_SESSION_SECRET (aleatório, 32+ caracteres) no Render.
const tentativasFalhas = new Map();
function hash(texto){return crypto.createHash('sha256').update(texto).digest();}
function senhaValida(senha){
  if (!ADMIN_PASSWORD || !ADMIN_SESSION_SECRET || ADMIN_SESSION_SECRET.length < 32) return false;
  const a=hash(String(senha)), b=hash(ADMIN_PASSWORD);
  return crypto.timingSafeEqual(a,b);
}
function assinatura(texto){return crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(texto).digest('base64url');}
function criarToken(){
  const dados=Buffer.from(JSON.stringify({tipo:'admin',exp:Date.now()+12*60*60*1000,nonce:crypto.randomBytes(12).toString('hex')})).toString('base64url');
  return dados+'.'+assinatura(dados);
}
function verificarAdmin(req){
  if(!db || !ADMIN_PASSWORD || ADMIN_SESSION_SECRET.length<32)throw new Error('Configure Firestore, ADMIN_PASSWORD e ADMIN_SESSION_SECRET no Render.');
  const token=String(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1]||'';
  const partes=token.split('.');
  if(partes.length!==2||!partes[0]||!partes[1])throw new Error('Entre novamente como administrador.');
  const esperado=Buffer.from(assinatura(partes[0]));
  const recebido=Buffer.from(partes[1]);
  if(esperado.length!==recebido.length||!crypto.timingSafeEqual(esperado,recebido))throw new Error('Sessão administrativa inválida.');
  let dados;
  try{dados=JSON.parse(Buffer.from(partes[0],'base64url').toString('utf8'));}catch{throw new Error('Sessão administrativa inválida.');}
  if(dados.tipo!=='admin'||!Number.isSafeInteger(dados.exp)||dados.exp<Date.now())throw new Error('Sessão administrativa expirada.');
  return true;
}
async function verificarCliente(req){
  if(!db||!clienteAuth)throw new Error('Autenticação ou Firestore indisponível.');
  const token=String(req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];
  if(!token)throw new Error('Faça login com seu e-mail antes de comprar ou consultar o histórico.');
  // Validação de assinatura, emissor, público e validade no projeto dos clientes.
  // Sem checkRevoked: a conta de serviço do banco não tem necessariamente permissões
  // para consultar revogação de sessões no outro projeto Firebase.
  const usuario=await clienteAuth.verifyIdToken(token);
  if(!usuario.uid || !usuario.email || usuario.email_verified!==true)throw new Error('Confirme o acesso por e-mail para continuar.');
  return {uid:usuario.uid,email:usuario.email};
}
function dataISO(v){return v?.toDate?.()?.toISOString?.()||null;}
async function obterPrazoGeral(){
  const doc=await db.collection('configuracoes').doc('devolucao').get();
  const bruto=doc.data()?.dias;
  const dias=Number(bruto);
  return bruto!==undefined&&bruto!==null&&Number.isSafeInteger(dias)&&dias>=0&&dias<=365?dias:7;
}
function limitadorLogin(req){
  const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].slice(0,80);
  const agora=Date.now(), atual=tentativasFalhas.get(ip)||{ate:0,tentativas:0};
  if(agora>atual.ate){atual.tentativas=0;atual.ate=agora+15*60*1000;}
  return {ip,atual};
}
async function catalogo(){
  const produtos={};
  for(const [id,p] of Object.entries(CATALOGO_INICIAL)){
    if(/^\d+$/.test(id))produtos[id]={nome:String(p.nome),precoCentavos:Number(p.precoCentavos),estoque:50,foto:'',alturaFoto:180,ajusteFoto:'cover',pixQr:'',prazoDevolucaoDias:null};
  }
  if(db){
    const snap=await db.collection('produtos').get();
    snap.forEach(doc=>{
      const p=doc.data();
      if(!/^\d+$/.test(doc.id))return;
      if(p.excluido){delete produtos[doc.id];return;}
      // A edição de preço/nome/estoque atualiza só o campo alterado.
      // Portanto, herdamos os demais campos do catálogo inicial.
      const anterior=produtos[doc.id]||{nome:'',precoCentavos:0,estoque:50,foto:'',alturaFoto:180,ajusteFoto:'cover',pixQr:'',prazoDevolucaoDias:null};
      produtos[doc.id]={...anterior,...p,
        foto:p.foto||anterior.foto||'',pixQr:p.pixQr||anterior.pixQr||'',
        alturaFoto:p.alturaFoto||anterior.alturaFoto||180,
        ajusteFoto:p.ajusteFoto||anterior.ajusteFoto||'cover'};
      delete produtos[doc.id].atualizadoEm;
    });
  }
  return produtos;
}
// Confirma cada webhook na API oficial: webhooks InfinitePay não têm assinatura.
async function confirmarPagamentoInfinitePay(order_nsu,transaction_nsu,slug){
  if(!HANDLE || !transaction_nsu || !slug)throw new Error('Identificadores do pagamento incompletos');
  const headers={'Content-Type':'application/json'};
  if(API_KEY)headers['X-Api-Key']=API_KEY;
  const r=await fetch('https://api.checkout.infinitepay.io/payment_check',{
    method:'POST',headers,
    body:JSON.stringify({handle:HANDLE,order_nsu,transaction_nsu,slug}),
    signal:AbortSignal.timeout(12000)
  });
  if(!r.ok)throw new Error('Falha na consulta oficial do pagamento ('+r.status+')');
  const dados=await r.json();
  if(dados.success!==true || dados.paid!==true)return null;
  return dados;
}
async function registrarPagamento(order_nsu,transaction_nsu,slug){
  if(!db)throw new Error('Firestore obrigatório para baixar estoque');
  if(typeof order_nsu!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(order_nsu) ||
     typeof transaction_nsu!=='string'||transaction_nsu.length>150 ||
     typeof slug!=='string'||slug.length>150)throw new Error('Identificadores inválidos');
  const pedidoRef=db.collection('pedidos').doc(order_nsu);
  const pedidoSnap=await pedidoRef.get();
  if(!pedidoSnap.exists)throw new Error('Pedido não localizado');
  if(pedidoSnap.data().pago)return {jaProcessado:true};
  const confirmado=await confirmarPagamentoInfinitePay(order_nsu,transaction_nsu,slug);
  if(!confirmado)return {pendente:true};
  // amount é o valor original da cobrança; paid_amount pode variar por taxas.
  if(Number(confirmado.amount)!==Number(pedidoSnap.data().valorCentavos))throw new Error('Valor da transação não corresponde ao pedido');
  return db.runTransaction(async tx=>{
    const atual=await tx.get(pedidoRef);
    if(!atual.exists)throw new Error('Pedido não localizado');
    const pedido=atual.data();
    if(pedido.pago)return {jaProcessado:true};
    if(pedido.statusEstoque==='insuficiente')return {estoqueInsuficiente:true};
    const itens=pedido.itens;
    if(!Array.isArray(itens)||!itens.length)throw new Error('Pedido sem itens');
    const qtdPorId=new Map();
    for(const item of itens){
      const id=String(item.id),q=Number(item.quantidade);
      if(!/^\d+$/.test(id)||!Number.isSafeInteger(q)||q<1)throw new Error('Item inválido no pedido');
      qtdPorId.set(id,(qtdPorId.get(id)||0)+q);
    }
    const registros=[];
    // Todas as leituras precisam ocorrer antes das escritas no Firestore.
    for(const [id,qtd] of qtdPorId){
      const ref=db.collection('produtos').doc(id);
      const snap=await tx.get(ref);
      const inicial=CATALOGO_INICIAL[id];
      const dados=snap.exists?snap.data():null;
      if(!dados&&!inicial)throw new Error('Produto indisponível: '+id);
      const estoque=dados?.estoque===undefined?50:Number(dados.estoque);
      registros.push({id,ref,dados,inicial,estoque,qtd});
    }
    if(registros.some(x=>!Number.isSafeInteger(x.estoque)||x.estoque<x.qtd||x.dados?.excluido)){
      tx.update(pedidoRef,{pago:true,formaPagamento:confirmado.payment_method||confirmado.payment_type||'Não informada pela InfinitePay',statusEstoque:'insuficiente',transaction_nsu,slug,confirmadoEm:admin.firestore.FieldValue.serverTimestamp()});
      return {estoqueInsuficiente:true};
    }
    for(const x of registros){
      const base=x.dados?{}:{nome:String(x.inicial.nome),precoCentavos:Number(x.inicial.precoCentavos)};
      tx.set(x.ref,{...base,estoque:x.estoque-x.qtd,atualizadoEm:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
    }
    tx.update(pedidoRef,{pago:true,formaPagamento:confirmado.payment_method||confirmado.payment_type||'Não informada pela InfinitePay',statusEstoque:'baixado',transaction_nsu,slug,confirmadoEm:admin.firestore.FieldValue.serverTimestamp()});
    return {baixado:true};
  });
}

http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){
    res.writeHead(cors(req)?204:403,{'Access-Control-Allow-Origin':SITE_ORIGIN||'null','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Vary':'Origin'});return res.end();
  }
  // O webhook é enviado de servidor para servidor e não possui cabeçalho Origin.
  if(req.url!=='/api/webhook/infinitepay' && !cors(req))return json(req,res,403,{error:'Origem não autorizada'});
  try {
    if(req.url==='/api/webhook/infinitepay'&&req.method==='POST'){
      if(!db)return json(req,res,503,{error:'Banco indisponível'});
      const evento=await corpo(req);
      const order_nsu=String(evento.order_nsu||'');
      const transaction_nsu=String(evento.transaction_nsu||'');
      const slug=String(evento.invoice_slug||evento.slug||'');
      if(!order_nsu||!transaction_nsu||!slug)return json(req,res,400,{error:'Dados do pagamento incompletos'});
      const resultado=await registrarPagamento(order_nsu,transaction_nsu,slug);
      if(resultado.pendente)return json(req,res,409,{error:'Pagamento ainda não confirmado'});
      if(resultado.estoqueInsuficiente)console.error('ALERTA: pedido pago com estoque insuficiente:',order_nsu);
      return json(req,res,200,{ok:true,...resultado});
    }
    // Retorno do navegador: confirmação oficial alternativa ao webhook.
    // Nenhum dado do navegador é considerado pagamento sem /payment_check.
    if(req.url==='/api/pagamento/confirmar'&&req.method==='POST'){
      if(!db)return json(req,res,503,{error:'Banco indisponível'});
      const evento=await corpo(req);
      const order_nsu=String(evento.order_nsu||'');
      const transaction_nsu=String(evento.transaction_nsu||'');
      const slug=String(evento.slug||'');
      if(!order_nsu||!transaction_nsu||!slug)return json(req,res,400,{error:'Dados de pagamento incompletos'});
      const resultado=await registrarPagamento(order_nsu,transaction_nsu,slug);
      return json(req,res,200,{ok:true,...resultado});
    }
    if(req.url==='/health'&&req.method==='GET')return json(req,res,200,{ok:true,checkoutConfigurado:!!HANDLE,bancoConfigurado:!!db,pagamentoUnicoConfigurado:!!API_KEY,origemConfigurada:!!SITE_ORIGIN});
    if(req.url==='/api/produtos'&&req.method==='GET')return json(req,res,200,{produtos:await catalogo()});
    if(req.url==='/api/devolucao'&&req.method==='GET'){
      if(!db)return json(req,res,503,{error:'Banco indisponível'});
      return json(req,res,200,{dias:await obterPrazoGeral()});
    }
    if(req.url==='/api/admin/devolucao'&&req.method==='PUT'){
      verificarAdmin(req);
      const body=await corpo(req),dias=Number(body.dias);
      if(!Number.isSafeInteger(dias)||dias<0||dias>365)return json(req,res,400,{error:'Informe de 0 a 365 dias.'});
      await db.collection('configuracoes').doc('devolucao').set({dias,atualizadoEm:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return json(req,res,200,{ok:true,dias});
    }
    if(req.url==='/api/cliente/pedidos'&&req.method==='GET'){
      const cliente=await verificarCliente(req);
      const snap=await db.collection('pedidos').where('clienteUid','==',cliente.uid).limit(100).get();
      const pedidos=snap.docs.map(doc=>{
        const p=doc.data();
        return {id:doc.id,valorCentavos:p.valorCentavos,pago:!!p.pago,
          criadoEm:dataISO(p.criadoEm),confirmadoEm:dataISO(p.confirmadoEm),
          formaPagamento:p.formaPagamento||'',frete:p.frete||'',
          itens:Array.isArray(p.itensSnapshot)?p.itensSnapshot:[]};
      }).sort((a,b)=>String(b.criadoEm||'').localeCompare(String(a.criadoEm||'')));
      return json(req,res,200,{pedidos});
    }
    if(req.url==='/api/admin/login'&&req.method==='POST'){
      if(!db || !ADMIN_PASSWORD || ADMIN_SESSION_SECRET.length<32)return json(req,res,503,{error:'Acesso administrativo ainda não configurado no servidor.'});
      const {ip,atual}=limitadorLogin(req);
      if(atual.tentativas>=7)return json(req,res,429,{error:'Muitas tentativas. Tente novamente mais tarde.'});
      const body=await corpo(req);
      if(typeof body.senha!=='string'||body.senha.length>256||!senhaValida(body.senha)){
        atual.tentativas++;tentativasFalhas.set(ip,atual);
        return json(req,res,401,{error:'Senha administrativa incorreta.'});
      }
      tentativasFalhas.delete(ip);
      return json(req,res,200,{token:criarToken(),expiraEmHoras:12});
    }
    if(req.url==='/api/admin/me'&&req.method==='GET'){
      await verificarAdmin(req);return json(req,res,200,{admin:true});
    }
    const rota=req.url.match(/^\/api\/admin\/produtos\/(\d+)$/);
    if(rota&&(req.method==='PUT'||req.method==='DELETE')){
      verificarAdmin(req);
      const id=rota[1];
      if(!db)throw new Error('Banco indisponível');
      const ref=db.collection('produtos').doc(id);
      if(req.method==='DELETE'){
        await ref.set({excluido:true},{merge:true});
        return json(req,res,200,{ok:true});
      }
      const body=await corpo(req);
      const alteracoes={};
      if(Object.hasOwn(body,'nome')){
        const nome=String(body.nome||'').trim();
        if(!nome||nome.length>90)return json(req,res,400,{error:'Nome do produto inválido'});
        alteracoes.nome=nome;
      }
      if(Object.hasOwn(body,'precoCentavos')){
        const preco=Number(body.precoCentavos);
        if(!Number.isSafeInteger(preco)||preco<100||preco>100000000)return json(req,res,400,{error:'Preço inválido'});
        alteracoes.precoCentavos=preco;
      }
      if(Object.hasOwn(body,'estoque')){
        const estoque=Number(body.estoque);
        if(!Number.isSafeInteger(estoque)||estoque<0||estoque>100000)return json(req,res,400,{error:'Estoque inválido'});
        alteracoes.estoque=estoque;
      }
      if(Object.hasOwn(body,'prazoDevolucaoDias')){
        const prazo=body.prazoDevolucaoDias;
        if(prazo===null){alteracoes.prazoDevolucaoDias=null;}
        else if(Number.isSafeInteger(prazo)&&prazo>=0&&prazo<=365){alteracoes.prazoDevolucaoDias=prazo;}
        else return json(req,res,400,{error:'Prazo individual deve ser de 0 a 365 dias, ou padrão geral.'});
      }
      if(!Object.keys(alteracoes).length)return json(req,res,400,{error:'Nenhuma alteração enviada'});
      const existente=await ref.get();
      if(!existente.exists&&!CATALOGO_INICIAL[id]){
        if(!('nome' in alteracoes)||!('precoCentavos' in alteracoes)||!('estoque' in alteracoes))
          return json(req,res,400,{error:'Novo produto exige nome, preço e estoque'});
      }
      await ref.set({...alteracoes,excluido:false,atualizadoEm:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return json(req,res,200,{ok:true});
    }
    // Altura e modo da foto são alterados sem tocar no estoque.
    const aparenciaProduto=req.url.match(/^\/api\/admin\/produtos\/(\d+)\/aparencia$/);
    if(aparenciaProduto&&req.method==='PUT'){
      verificarAdmin(req);
      const id=aparenciaProduto[1],body=await corpo(req);
      const altura=Number(body.alturaFoto),modo=String(body.ajusteFoto||'');
      if(!Number.isSafeInteger(altura)||altura<80||altura>400||!['cover','contain','fill'].includes(modo))
        return json(req,res,400,{error:'Tamanho e modo da foto inválidos'});
      const ref=db.collection('produtos').doc(id);
      const snap=await ref.get();
      if(!snap.exists&&!CATALOGO_INICIAL[id])return json(req,res,404,{error:'Produto não encontrado'});
      await ref.set({alturaFoto:altura,ajusteFoto:modo,atualizadoEm:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return json(req,res,200,{ok:true});
    }
    if(req.url==='/api/aparencia'&&req.method==='GET'){
      if(!db)return json(req,res,200,{logo:''});
      const doc=await db.collection('configuracoes').doc('aparencia').get();
      return json(req,res,200,{logo:doc.data()?.logo||''});
    }
    if(req.url==='/api/admin/aparencia'&&req.method==='PUT'){
      verificarAdmin(req);const b=await corpo(req);
      if(!imagemValida(b.logo))return json(req,res,400,{error:'Imagem inválida ou muito grande'});
      await db.collection('configuracoes').doc('aparencia').set({logo:b.logo},{merge:true});
      return json(req,res,200,{ok:true});
    }
    const imagemRota=req.url.match(/^\/api\/admin\/produtos\/(\d+)\/(imagem|pix)$/);
    if(imagemRota&&req.method==='PUT'){
      verificarAdmin(req);const [_,id,tipo]=imagemRota;
      const b=await corpo(req),campo=tipo==='imagem'?'foto':'pixQr';
      if(!imagemValida(b[campo]))return json(req,res,400,{error:'Imagem inválida ou muito grande'});
      const ref=db.collection('produtos').doc(id), existente=await ref.get();
      if(!existente.exists){
        const inicial=CATALOGO_INICIAL[id];
        if(!inicial)return json(req,res,404,{error:'Produto não encontrado'});
        await ref.set({nome:inicial.nome,precoCentavos:inicial.precoCentavos,estoque:50},{merge:true});
      }
      await ref.set({[campo]:b[campo],atualizadoEm:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      return json(req,res,200,{ok:true});
    }
    if(req.url==='/api/checkout'&&req.method==='POST'){
      const cliente=await verificarCliente(req);
      if(!HANDLE)return json(req,res,503,{error:'Configure INFINITEPAY_HANDLE no Render.'});
      const body=await corpo(req);
      if(!Array.isArray(body.itens)||body.itens.length<1||body.itens.length>30||!Object.hasOwn(fretes,body.frete))return json(req,res,400,{error:'Carrinho ou frete inválido'});
      const produtos=await catalogo();
      if(!db)return json(req,res,503,{error:'Firestore indisponível: checkout desativado para evitar vendas sem controle de estoque.'});
      const items=body.itens.map(x=>{
        const id=String(x.id),q=Number(x.quantidade),p=produtos[id];
        if(!p||!Number.isSafeInteger(q)||q<1||q>100||!Number.isSafeInteger(p.precoCentavos)||p.precoCentavos<100||q>p.estoque)throw new Error('Produto ou quantidade não permitido no catálogo do servidor: '+id);
        return {quantity:q,price:p.precoCentavos,description:String(p.nome).slice(0,90)};
      });
      if(fretes[body.frete])items.push({quantity:1,price:fretes[body.frete],description:'Frete - '+body.frete});
      const valorCentavos=items.reduce((s,i)=>s+i.price*i.quantity,0);
      if(!Number.isSafeInteger(body.valorEsperadoCentavos)||body.valorEsperadoCentavos!==valorCentavos)return json(req,res,409,{error:'Preço da loja desatualizado. Atualize a página e tente de novo. Valor seguro do servidor: R$ '+(valorCentavos/100).toFixed(2).replace('.',',')});
      const order_nsu=crypto.randomUUID(),payload={handle:HANDLE,order_nsu,items,webhook:{url:PUBLIC_BACKEND_URL+'/api/webhook/infinitepay',events:['paid']}};
      if(SITE_ORIGIN.startsWith('https://'))payload.redirect_url=SITE_ORIGIN+'/site-2/'; 
      if(API_KEY){
        payload.options={single_payment:true,valid_until:new Date(Date.now()+2*60*60*1000).toISOString()};
        if(DESCONTO_PIX>0&&DESCONTO_PIX<100)payload.options.discounts={pix:DESCONTO_PIX};
      }
      const headers={'Content-Type':'application/json'};
      if(API_KEY)headers['X-Api-Key']=API_KEY;
      const respostaApi=await fetch('https://api.checkout.infinitepay.io/links',{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
      const dados=await respostaApi.json();
      if(!respostaApi.ok)return json(req,res,502,{error:dados.message||dados.error||'Falha ao criar cobrança na InfinitePay'});
      const url=dados.url||dados.checkout_url||dados.link;
      if(typeof url!=='string')throw new Error('Checkout retornou URL inválida');
      const destino=new URL(url);
      if(destino.protocol!=='https:'||!/(^|\.)infinitepay\.(io|com\.br)$/.test(destino.hostname))throw new Error('URL de checkout não pertence à InfinitePay');
      const prazoGeral=await obterPrazoGeral();
      const itensSnapshot=body.itens.map(item=>{
        const p=produtos[String(item.id)];
        const prazo=Number.isSafeInteger(p.prazoDevolucaoDias)?p.prazoDevolucaoDias:prazoGeral;
        return {id:String(item.id),nome:String(p.nome).slice(0,90),precoCentavos:p.precoCentavos,
          quantidade:Number(item.quantidade),prazoDevolucaoDias:prazo};
      });
      await db.collection('pedidos').doc(order_nsu).set({
        clienteUid:cliente.uid,clienteEmail:cliente.email,
        valorCentavos,pago:false,itens:body.itens,itensSnapshot,frete:body.frete,
        criadoEm:admin.firestore.FieldValue.serverTimestamp()
      });
      return json(req,res,200,{url,order_nsu,valorCentavos});
    }
    return json(req,res,404,{error:'Rota inexistente'});
  }catch(e){console.error('Erro API:',e.message);
    const codigo=/acima do limite|Corpo muito grande/.test(e.message)?413:400;
    return json(req,res,codigo,{error:e.message||'Erro interno'});
  }
}).listen(PORT,()=>console.log('Servidor InfinitePay com catálogo Firestore na porta',PORT));
