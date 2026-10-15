import test from 'node:test';
import assert from 'node:assert/strict';
import {responsesWebSocketMode as mode} from '../supabase/functions/sub2api/responses_ws_mode.ts';
import {bridgeInput} from '../supabase/functions/sub2api/responses_http_bridge.ts';
test('Responses WebSocket mode follows native typed-mode and boolean precedence',()=>{
 assert.equal(mode({platform:'openai',type:'oauth'}),'ctx_pool');assert.equal(mode({platform:'grok'}),'http_bridge');assert.equal(mode({platform:'gemini'}),'off');
 for(const type of ['oauth','apikey']){
  const prefix='openai_'+type+'_responses_websockets_v2_';
  assert.equal(mode({platform:'openai',type,websocket_settings:{[prefix+'mode']:' HTTP_BRIDGE ',[prefix+'enabled']:false}}),'http_bridge');
  assert.equal(mode({platform:'openai',type,websocket_settings:{[prefix+'mode']:'bad',[prefix+'enabled']:false,responses_websockets_v2_enabled:true}}),'off');
  assert.equal(mode({platform:'openai',type,websocket_settings:{responses_websockets_v2_enabled:false,openai_ws_enabled:true}}),'off');
 }
});
test('HTTP bridge replay preserves function calls and avoids duplicated full input prefixes',()=>{
 const input=[{role:'user',content:'Hello'}],output=[{type:'function_call',call_id:'call_1',name:'tool',arguments:'{}'}],history={id:'resp_1',input,output},result={type:'function_call_output',call_id:'call_1',output:'done'};
 assert.deepEqual(bridgeInput({input:[result],previous_response_id:'resp_1'},history).input,[...input,...output,result]);
 assert.deepEqual(bridgeInput({input:[...input,...output,result],previous_response_id:'resp_1'},history).input,[...input,...output,result]);
 assert.equal(bridgeInput({previous_response_id:'unknown',input:[]},history).previous_response_id,'unknown');
});
