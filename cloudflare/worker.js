import {DurableObject} from 'cloudflare:workers';
import {createApp,securityHeaders} from '../src/app.js';
import questions from '../questions.json';

export class LivePollStore extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.apps=new Map();
    // Initialize schema once on wake-up. The origin is replaced per routed request.
    this.app=this.forOrigin(env.PUBLIC_ORIGIN||'https://bootstrap.invalid');
    ctx.blockConcurrencyWhile(async()=>{
      // An existing persisted alarm must survive object wake-up unchanged.
      if(await ctx.storage.getAlarm()===null)await this.scheduleAlarm();
    });
  }
  forOrigin(origin){
    if(this.apps.has(origin))return this.apps.get(origin);
    const sql=this.ctx.storage.sql;
    const db={exec:s=>sql.exec(s),prepare:s=>({
      get:(...p)=>sql.exec(s,...p).toArray()[0],
      all:(...p)=>sql.exec(s,...p).toArray(),
      run:(...p)=>sql.exec(s,...p).toArray()
    })};
    const app=createApp({db,transaction:fn=>this.ctx.storage.transactionSync(fn),
      secret:this.env.HOST_SECRET,origin,secure:origin.startsWith('https:'),initialQuestions:questions});
    this.apps.set(origin,app);return app;
  }
  async scheduleAlarm(){
    const deadline=this.app.nextDeadline();
    const current=await this.ctx.storage.getAlarm();
    if(deadline!==null&&current!==deadline)await this.ctx.storage.setAlarm(deadline);
    else if(deadline===null&&current!==null)await this.ctx.storage.deleteAlarm();
  }
  async fetch(request){
    const origin=this.env.PUBLIC_ORIGIN||new URL(request.url).origin;
    const app=this.forOrigin(origin);
    const response=await app.fetch(request,request.headers.get('CF-Connecting-IP')||'local');
    if(request.method==='POST'&&new URL(request.url).pathname.endsWith('/control')){
      // Serialize alarm scheduling across concurrent starts of separate activities.
      await this.ctx.blockConcurrencyWhile(()=>this.scheduleAlarm());
    }
    return response;
  }
  async alarm(){
    this.app.expireRounds();
    await this.scheduleAlarm();
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/')||url.pathname==='/health'){
      if(!env.HOST_SECRET||env.HOST_SECRET.length<24)return Response.json({error:'请在 Cloudflare 配置 HOST_SECRET（至少 24 字符）'}, {status:503,headers:securityHeaders});
      // Buffer bounded bodies before crossing a service binding. Early permission
      // rejections then cannot leave an upstream request stream being pulled.
      if(request.body){
        const reader=request.body.getReader(),parts=[];let size=0;
        for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
          if(size>150000){await reader.cancel();return Response.json({error:'请求过大'},{status:413,headers:securityHeaders});}
          parts.push(value);
        }
        const bytes=new Uint8Array(size);let offset=0;
        for(const part of parts){bytes.set(part,offset);offset+=part.length;}
        request=new Request(request,{body:bytes});
      }
      const stub=env.POLL_STORE.get(env.POLL_STORE.idFromName('live-poll-v1'));
      try{return await stub.fetch(request);}catch(e){console.error(e);return Response.json({error:'服务器错误'}, {status:500,headers:securityHeaders});}
    }
    if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Not found',{status:404,headers:securityHeaders});
    const pages=/^\/(?:host|join(?:\/\d{6})?|screen\/[a-f0-9]{36})?\/?$/;
    const assets=['/app.js','/style.css','/favicon.svg'];
    if(!pages.test(url.pathname)&&!assets.includes(url.pathname))return new Response('Not found',{status:404,headers:securityHeaders});
    if(pages.test(url.pathname))url.pathname='/index.html';
    const resource=await env.ASSETS.fetch(new Request(url,request));
    const headers=new Headers(resource.headers);
    for(const [k,v]of Object.entries(securityHeaders))headers.set(k,v);
    return new Response(resource.body,{status:resource.status,headers});
  }
};
