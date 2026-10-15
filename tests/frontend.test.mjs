import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { createConsoleServer, validateConfig } from '../scripts/console.mjs';
import { createHandler } from './handler.mjs';

const user = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const config = {url:'https://project.supabase.co',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[]};
const request = (path, method='GET', body) => new Request(`https://edge/api/v1${path}`,{method,headers:{authorization:'Bearer session','x-s2a-frontend':'1'},...(body?{body:JSON.stringify(body)}:{})});

async function serverTest(options,fn) {
  const server=createConsoleServer(options);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {await fn(`http://127.0.0.1:${server.address().port}`);} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

test('local proxy previews original login before configuration and rejects hostile Host',async()=>{
  await serverTest({},async base=>{
    const settings=await (await fetch(`${base}/api/v1/settings/public`)).json();
    assert.equal(settings.data.registration_enabled,true);
    assert.equal(settings.data.subscription_enabled,true);
    assert.equal(settings.data.payment_enabled,false);
    assert.equal(settings.data.backend_mode_enabled,false);
    assert.equal((await fetch(`${base}/api/v1/auth/login`,{method:'POST',body:'{}'})).status,503);
    const status=await new Promise((resolve,reject)=>{
      const req=httpRequest(`${base}/api/v1/settings/public`,{headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
    });assert.equal(status,403);
  });
  assert.throws(()=>validateConfig({supabase_url:'https://project.supabase.co',publishable_key:'sb_secret_12345678901234567890'}));
  assert.throws(()=>validateConfig({supabase_url:'https://evil.invalid',publishable_key:'sb_publishable_12345678901234567890'}));
});

test('Supabase password login uses only public key and retrieves role from the authenticated gateway',async()=>{
  const calls=[];
  await serverTest({config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(url,init)=>{
    calls.push([url,init]);
    if(String(url).includes('/auth/v1/token'))return Response.json({access_token:'session',refresh_token:'refresh',expires_in:3600});
    assert.equal(init.headers.authorization,'Bearer session');
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:user,factors:[]});
    return Response.json({code:0,data:{id:user,role:'user'}});
  }},async base=>{
    const response=await fetch(`${base}/api/v1/auth/login`,{method:'POST',body:JSON.stringify({email:'user@example.com',password:'private',role:'admin'})});
    const data=await response.json();assert.equal(data.data.user.role,'user');assert.equal(data.data.access_token,'session');
    assert.equal(calls[0][1].body,JSON.stringify({email:'user@example.com',password:'private'}));
    assert.equal(calls[0][1].headers.apikey,'sb_publishable_12345678901234567890');
  });
});

test('configured console forwards live public settings without requiring a user session',async()=>{
  await serverTest({config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(url,init)=>{
    assert.equal(String(url),`http://127.0.0.1:8080/api/v1/settings/public`);
    assert.equal(init.headers['x-s2a-frontend'],'1');
    return Response.json({code:0,data:{site_name:'Live gateway',registration_enabled:false}});
  }},async base=>{
    const r=await fetch(`${base}/api/v1/settings/public`);assert.equal(r.status,200);
    assert.equal((await r.json()).data.site_name,'Live gateway');
  });
});

test('Supabase registration creates an account through the public Auth endpoint',async()=>{
  const calls=[];
  await serverTest({config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(url,init)=>{
    calls.push([String(url),init]);
    if(new URL(url).pathname.endsWith('/auth/v1/signup')) return Response.json({access_token:'new-session',refresh_token:'new-refresh',expires_in:3600});
    if(String(url).endsWith('/auth/v1/user')) return Response.json({id:user,factors:[]});
    assert.match(String(url),/auth\/me$/);
    return Response.json({code:0,data:{id:user,role:'user'}});
  }},async base=>{
    const response=await fetch(`${base}/api/v1/auth/register`,{method:'POST',body:JSON.stringify({email:'new@example.com',password:'private',username:'New User',role:'admin',invitation_code:'INVITE',promo_code:'PROMO'})});
    const data=await response.json();
    assert.equal(response.status,200);
    assert.equal(data.data.user.role,'user');
    assert.equal(data.data.access_token,'new-session');
    assert.deepEqual(JSON.parse(calls[0][1].body),{email:'new@example.com',password:'private',data:{username:'New User',invitation_code:'INVITE',promo_code:'PROMO'}});
    assert.equal(calls[0][1].headers.apikey,'sb_publishable_12345678901234567890');
  });
});

test('Supabase password recovery uses native recovery and update endpoints',async()=>{
  const calls=[];
  await serverTest({config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(url,init)=>{
    calls.push([String(url),init]);
    return new Response(null,{status:204});
  }},async base=>{
    const forgot=await fetch(`${base}/api/v1/auth/forgot-password`,{method:'POST',body:JSON.stringify({email:'user@example.com'})});
    assert.equal(forgot.status,200);
    const reset=await fetch(`${base}/api/v1/auth/reset-password`,{method:'POST',body:JSON.stringify({token:'native-reset-token-1234567890',new_password:'new-private'})});
    assert.equal(reset.status,200);
    assert.equal(calls[0][0],`${config.url}/auth/v1/recover`);
    assert.deepEqual(JSON.parse(calls[0][1].body),{email:'user@example.com',redirect_to:'http://127.0.0.1:3000/reset-password'});
    assert.equal(calls[1][0],`${config.url}/auth/v1/user`);
    assert.equal(calls[1][1].headers.authorization,'Bearer native-reset-token-1234567890');
    assert.deepEqual(JSON.parse(calls[1][1].body),{password:'new-private'});
  });
});

test('MFA password login returns only native temporary token until user-bound TOTP verification',async()=>{
  const factor='22222222-2222-4222-8222-222222222222';
  const calls=[];
  await serverTest({config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(url,init)=>{
    calls.push([String(url),init]);
    if(String(url).includes('/auth/v1/token'))return Response.json({access_token:'native-aal1',refresh_token:'private-refresh',expires_in:3600});
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:user,factors:[{id:factor,factor_type:'totp',status:'verified'}]});
    if(String(url).endsWith('/challenge')){assert.equal(init.headers.authorization,'Bearer native-aal1');return Response.json({id:'native-challenge'});}
    if(String(url).endsWith('/verify')){
      assert.equal(init.headers.authorization,'Bearer native-aal1');
      assert.deepEqual(JSON.parse(init.body),{challenge_id:'native-challenge',code:'123456'});
      return Response.json({access_token:'native-aal2',refresh_token:'verified-refresh',expires_in:3600});
    }
    assert.match(String(url),/auth\/me$/);assert.equal(init.headers.authorization,'Bearer native-aal2');
    return Response.json({code:0,data:{id:user,role:'user'}});
  }},async base=>{
    const login=(await(await fetch(`${base}/api/v1/auth/login`,{method:'POST',body:JSON.stringify({email:'user@example.com',password:'private'})})).json()).data;
    assert.deepEqual(login,{requires_2fa:true,temp_token:'native-aal1',user_email_masked:'***'});
    assert.equal(calls.some(([url])=>url.includes('auth/me')),false);
    const verified=(await(await fetch(`${base}/api/v1/auth/login/2fa`,{method:'POST',body:JSON.stringify({temp_token:login.temp_token,totp_code:'123456',factor_id:'attacker'})})).json()).data;
    assert.equal(verified.access_token,'native-aal2');assert.equal(verified.user.id,user);
  });
});

test('MFA login rejects invalid code before native calls and sanitizes verification rejection',async()=>{
  let calls=0;
  await serverTest({config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(url)=>{
    calls++;
    if(String(url).endsWith('/user'))return Response.json({id:user,factors:[{id,factor_type:'totp',status:'verified'}]});
    if(String(url).endsWith('/challenge'))return Response.json({id:'challenge'});
    return Response.json({error:'sensitive details'},{status:400});
  }},async base=>{
    const send=body=>fetch(`${base}/api/v1/auth/login/2fa`,{method:'POST',body:JSON.stringify(body)});
    assert.equal((await send({temp_token:'native-aal1',totp_code:'12345'})).status,400);assert.equal(calls,0);
    const result=await send({temp_token:'native-aal1',totp_code:'123456'});assert.equal(result.status,400);
    assert.equal((await result.text()).includes('sensitive'),false);
  });
});


test('console forwards subscription retry keys unchanged to Edge',async()=>{
  await serverTest({config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(url,init)=>{
    assert.ok(String(url).endsWith('/api/v1/admin/subscriptions/bulk-action'));
    assert.equal(init.headers['idempotency-key'],'subscription-retry');
    assert.equal(init.headers.authorization,'Bearer session');
    return Response.json({code:0,data:{success_count:1}});
  }},async base=>{
    const response=await fetch(`${base}/api/v1/admin/subscriptions/bulk-action`,{method:'POST',headers:{authorization:'Bearer session','Idempotency-Key':'subscription-retry'},body:JSON.stringify({subscription_ids:[user],action:'extend',days:2})});
    assert.equal(response.status,200);
  });
});

test('local proxy forwards encoded page images and preserves private storage security headers',async()=>{
 const config={supabase_url:'https://project.supabase.co',publishable_key:'sb_publishable_12345678901234567890'};
 await serverTest({config,fetchImpl:async(url,init)=>{
  assert.ok(url.endsWith('/api/v1/pages/guide/images/%E4%B8%AD%E6%96%87%20image.png'));
  assert.equal(init.headers.authorization,undefined);
  return new Response(new Uint8Array([1,2]),{headers:{'content-type':'image/png','content-security-policy':"sandbox; default-src 'none'"}});
 }},async base=>{
  const r=await fetch(`${base}/api/v1/pages/guide/images/%E4%B8%AD%E6%96%87%20image.png`);
  assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/sandbox/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[1,2]);
  assert.equal((await fetch(`${base}/api/v1/admin/groups/%2fid`)).status,404);
 });
});

test('local gateway paths bypass SPA fallback and preserve cloud targets and query strings',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const directory=await mkdtemp(join(tmpdir(),'s2a-gateway-static-'));
  try{
    await writeFile(join(directory,'index.html'),'<html>Console</html>');
    const calls=[];
    await serverTest({staticDir:directory,config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(url,init)=>{
      calls.push(url);assert.equal(init.headers.authorization,'Bearer client-key');return Response.json({gateway:true});
    }},async base=>{
      for(const path of [...['/tts','/stt','/custom-voices','/custom-voices/voice_1','/custom-voices/voice_1/audio','/web_search','/x_search','/videos','/videos/generations','/videos/edits','/videos/extensions','/videos/video_123','/videos/video_123/content','/images/generations/async','/images/edits/async','/images/tasks/imgtask_123'].flatMap(path=>[path,'/v1'+path]),'/models','/models/gpt-6.1-sol','/chat/completions','/responses','/backend-api/codex/responses','/embeddings','/images/generations','/v1/embeddings','/v1/images/generations','/v1/images/batches','/v1/images/batches/models',...['','/items','/items/cover/content?image_index=0','/items/%E5%B0%81%E9%9D%A2%20A%2FB/content?image_index=0','/download','/cancel','/outputs'].map(suffix=>'/v1/images/batches/imgbatch_'+ 'a'.repeat(32)+suffix),'/v1/usage?key=sk-usage-fixture','/antigravity/v1/messages','/antigravity/v1beta/models/gemini:generateContent']){
        const r=await fetch(base+path,{headers:{authorization:'Bearer client-key'}});
        assert.equal(r.status,200);assert.deepEqual(await r.json(),{gateway:true});
        assert.equal(calls.at(-1),config.url+'/functions/v1/sub2api'+path);
      }
      assert.match(await (await fetch(base+'/dashboard')).text(),/Console/);
    });
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('local inference accepts attachments above 1 MiB without changing payload bytes',async()=>{
  const body=JSON.stringify({model:'gpt-6.1-sol',input:'图片 '+ 'x'.repeat(2*1024*1024)});
  let calls=0;
  await serverTest({config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async(_url,init)=>{
    calls++;assert.equal(init.body,body);return Response.json({ok:true});
  }},async base=>{
    const r=await fetch(base+'/v1/responses',{method:'POST',headers:{authorization:'Bearer key','content-type':'application/json'},body});
    assert.equal(r.status,200);assert.equal(calls,1);
    const admin=await fetch(base+'/api/v1/admin/accounts',{method:'POST',body});
    assert.equal(admin.status,413);assert.equal(calls,1);
  });
});

test('local inference enforces global, gateway and text caps for fixed and chunked uploads',async()=>{
  let calls=0;
  await serverTest({requestLimits:{server:4096,gateway:8192,text:1024},config:{supabase_url:config.url,publishable_key:'sb_publishable_12345678901234567890'},fetchImpl:async()=>{
    calls++;return Response.json({ok:true});
  }},async base=>{
    for(const [path,size,expected] of [['/v1/responses',4096,200],['/responses',4097,413],['/embeddings',1024,200],['/v1/embeddings',1025,413]]){
      const r=await fetch(base+path,{method:'POST',body:'x'.repeat(size)});assert.equal(r.status,expected);
    }
    const chunks=async function*(){yield 'x'.repeat(600);yield 'x'.repeat(600);};
    const r=await fetch(base+'/embeddings',{method:'POST',body:chunks(),duplex:'half'});assert.equal(r.status,413);
    assert.equal(calls,2);
  });
});
