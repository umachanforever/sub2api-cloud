import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptanceAuth} from '../scripts/acceptance-auth.mjs';
test('isolated acceptance identity rejects other keys, passwords and bearer tokens',async()=>{
  const fixture=await acceptanceAuth();
  try{
    const url=fixture.local.API_URL,headers={apikey:fixture.local.ANON_KEY,'content-type':'application/json'};
    assert.equal(new URL(url).hostname,'127.0.0.1');
    assert.equal((await fetch(url+'/auth/v1/user')).status,401);
    assert.equal((await fetch(url+'/auth/v1/user',{headers})).status,401);
    const login=await fetch(url+'/auth/v1/token?grant_type=password',{method:'POST',headers,body:JSON.stringify({email:fixture.admin.SUB2API_LOCAL_ADMIN_EMAIL,password:fixture.admin.SUB2API_LOCAL_ADMIN_PASSWORD})});
    assert.equal(login.status,200);const session=await login.json();
    const identity=await fetch(url+'/auth/v1/user',{headers:{...headers,authorization:'Bearer '+session.access_token}});
    assert.equal(identity.status,200);assert.equal((await identity.json()).id,session.user.id);
    const denied=await fetch(url+'/auth/v1/token?grant_type=password',{method:'POST',headers,body:JSON.stringify({email:fixture.admin.SUB2API_LOCAL_ADMIN_EMAIL,password:'incorrect'})});assert.equal(denied.status,400);
    const other=await acceptanceAuth();try{assert.equal((await fetch(other.local.API_URL+'/auth/v1/user',{headers:{apikey:other.local.ANON_KEY,authorization:'Bearer '+session.access_token}})).status,401);}finally{await other.close();}
  }finally{await fixture.close();}
});
