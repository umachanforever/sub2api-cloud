import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';

// A loopback-only identity authority for isolated management integration tests.
// Production Auth verification is exercised separately against a real project.
export async function acceptanceAuth() {
  const id=randomUUID(), password=randomBytes(24).toString('base64url');
  const email='management-acceptance@example.invalid';
  const publicKey='sb_publishable_'+randomBytes(24).toString('base64url');
  let token,issuer;
  const actor={id,email,role:'authenticated',email_confirmed_at:new Date().toISOString(),factors:[]};
  const server=createServer(async(request,response)=>{
    const reply=(status,value)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value));};
    if(request.headers.apikey!==publicKey)return reply(401,{error:'invalid_api_key'});
    if(request.url==='/auth/v1/user'&&request.method==='GET')return request.headers.authorization===`Bearer ${token}`?reply(200,actor):reply(401,{error:'invalid_token'});
    if(request.url==='/auth/v1/token?grant_type=password'&&request.method==='POST'){
      try{
        let body='';for await(const chunk of request){body+=chunk;if(body.length>4096)return reply(413,{error:'request_too_large'});}
        const input=JSON.parse(body);if(input.email!==email||input.password!==password)return reply(400,{error:'invalid_credentials'});
        return reply(200,{access_token:token,refresh_token:'acceptance-only',expires_in:3600,token_type:'bearer',user:actor});
      }catch{return reply(400,{error:'invalid_request'});}
    }
    return reply(404,{error:'not_found'});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  server.unref();
  const url=`http://127.0.0.1:${server.address().port}`;issuer=url+'/auth/v1';
  const now=Math.floor(Date.now()/1000), encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:id,iss:issuer,role:'authenticated',aud:'authenticated',exp:now+3600,iat:now,session_id:randomUUID(),aal:'aal1'})+'.'+randomBytes(32).toString('base64url');
  return {local:{API_URL:url,ANON_KEY:publicKey},admin:{SUB2API_LOCAL_ADMIN_EMAIL:email,SUB2API_LOCAL_ADMIN_PASSWORD:password},close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
