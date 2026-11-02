import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ChatImageText,nativeImageFileTool,nativeImageDownload} from '../supabase/functions/sub2api/chat_image_delivery.ts';
import {publishChatMedia} from '../supabase/functions/sub2api/chat_media.ts';
import {completedResponse,responseToChat,streamChat} from '../supabase/functions/sub2api/openai_protocol.ts';
import {IMAGE_CHAT_FRAME_LIMIT} from '../supabase/functions/sub2api/chat_images.ts';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RaAAAAAASUVORK5CYII=';
const image={type:'image_generation_call',id:'image-1',status:'completed',result:png};
const source='https://project.supabase.co/storage/v1/object/sign/sub2api-artifacts/images/imgtask_'+'a'.repeat(32)+'/image-1.png?token=synthetic';
const tool={type:'function',function:{name:'Bash',parameters:{type:'object',properties:{command:{type:'string'},description:{type:'string'},timeout:{type:'number'}},required:['command']}}};
const client={tools:[{type:'function',function:{name:'present_files'}},tool]};
const upstream=events=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
function storage(){
 const calls=[];
 return {calls,db:{config:{url:'https://project.supabase.co',serviceKey:'private'},rpc:async()=>true,fetchImpl:async(url,init)=>{
  calls.push({url,init});
  return url.includes('/object/sign/')?Response.json({signedURL:new URL(url).pathname.replace('/storage/v1','')+'?token=synthetic'}):Response.json({});
 }}};
}
function nativeEvents(format){
 const markup='![image](data:image/png;base64,'+png+')';
 if(format==='gpt')return [{type:'response.output_item.done',output_index:0,item:image},{type:'response.completed',response:{status:'completed',output:[image],usage:{input_tokens:2,output_tokens:3}}}];
 const message={id:'m',type:'message',content:[{type:'output_text',text:'Here '+markup+' Done!'}]};
 return [...[...message.content[0].text].map(delta=>({type:'response.output_text.delta',output_index:0,content_index:0,item_id:'m',delta})),{type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response:{status:'completed',output:[message],usage:{input_tokens:2,output_tokens:3}}}];
}
test('native delivery is opt-in to a declared, permitted client file tool',()=>{
 assert.equal(nativeImageFileTool(client),'Bash');
 for(const value of [{tools:[tool]},{...client,tool_choice:'none'},{...client,tool_choice:{type:'function',function:{name:'other'}}},{...client,response_format:{type:'json_object'}},{...client,text:{format:{type:'json_schema'}}},{tools:[client.tools[0],{...tool,function:{...tool.function,parameters:{properties:{command:{type:'string'}},required:['unsupported']}}}]}])assert.equal(nativeImageFileTool(value),undefined);
});
test('image parser handles every boundary and keeps ordinary links/text intact',()=>{
 const markup='before ![image](data:image/png;base64,'+png+') after!';
 for(let split=0;split<=markup.length;split++){
  const parser=new ChatImageText(),parts=[...parser.feed(markup.slice(0,split)),...parser.feed(markup.slice(split)),...parser.feed('',true)];
  assert.equal(parts.filter(part=>part.image).length,1);assert.equal(parts.find(part=>part.image).image.result,png);
  assert.equal(parts.filter(part=>part.text).map(part=>part.text).join(''),'before  after!');
 }
 const parser=new ChatImageText();assert.deepEqual(parser.feed('![image](https://example.com/a.png)',true),[{text:'![image](https://example.com/a.png)'}]);
 assert.throws(()=>new ChatImageText().feed('![image](data:image/png;base64,AAAA',true),/Incomplete/);
});
test('GPT image items and Gemini image text export once with JSON/SSE parity and original bytes',async()=>{
 for(const format of ['gpt','gemini'])for(const streaming of [false,true]){
  const {db,calls}=storage();
  const response=publishChatMedia(db,upstream(nativeEvents(format)),'lease',new AbortController().signal,client);
  let message,content='';
  if(streaming){
   const raw=await new Response(streamChat(response.body,'id','model',true,IMAGE_CHAT_FRAME_LIMIT)).text();
   const events=raw.split('\n').filter(line=>line.startsWith('data: ')&&!line.endsWith('[DONE]')).map(line=>JSON.parse(line.slice(6)));
   const deltas=events.flatMap(event=>event.choices??[]).map(choice=>choice.delta);
   const call=deltas.flatMap(delta=>delta.tool_calls??[])[0];message={tool_calls:[call]};
   content=deltas.map(delta=>delta.content??'').join('');assert.ok(raw.includes('[DONE]'));
   assert.equal(events.at(-1).usage.total_tokens,5);
  }else message=responseToChat(await completedResponse(response.body,IMAGE_CHAT_FRAME_LIMIT),'id').choices[0].message;
  content||=message.content??'';
  assert.equal(message.tool_calls.length,1);assert.equal(message.tool_calls[0].function.name,'Bash');
  const args=JSON.parse(message.tool_calls[0].function.arguments);assert.ok(args.command.includes('outputs/'));
  assert.ok(!content.includes('base64'));assert.ok(!content.includes('https://'));assert.ok(!content.includes('!['));
  if(format==='gemini')assert.equal(content,'Here  Done!');
  assert.equal(calls.length,2);assert.deepEqual(Buffer.from(calls[0].init.body),Buffer.from(png,'base64'));
 }
});
test('Gemini text fallback without a file tool remains one hosted inline image',async()=>{
 const {db}=storage();
 const completed=await completedResponse(publishChatMedia(db,upstream(nativeEvents('gemini')),'lease',new AbortController().signal).body);
 const text=responseToChat(completed,'id').choices[0].message.content;
 assert.equal(text.split('![Generated image]').length-1,1);assert.equal(text.split('https://').length-1,1);
});
test('native downloader writes exact PNG bytes without opening panels or overwriting files',async()=>{
 const call=nativeImageDownload([source]),command=JSON.parse(call.arguments).command;
 assert.ok(!command.includes('\n'),'terminal checkpoints must see a single shell line');
 assert.match(command,/ && cp -n 'outputs\/sub2api-[a-f0-9]{32}\.download' 'outputs\/sub2api-[a-f0-9]{32}\.png' && rm /);
 const directory=await mkdtemp(join(tmpdir(),'s2a-image-delivery-'));
 try{
  const fixture=`import io, urllib.request\nfixture = bytes.fromhex('${Buffer.from(png,'base64').toString('hex')}')\nurllib.request.urlopen = lambda *args, **kwargs: io.BytesIO(fixture)\n`;
  const shim=join(directory,'sitecustomize.py');
  const {writeFile}=await import('node:fs/promises');await writeFile(shim,fixture);
  const run=spawnSync('sh',['-c',command],{cwd:directory,encoding:'utf8',env:{...process.env,PYTHONPATH:directory}});
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,'completed');
  assert.deepEqual(await readFile(result.images[0].localPath),Buffer.from(png,'base64'));
  const repeated=spawnSync('sh',['-c',command],{cwd:directory,encoding:'utf8',env:{...process.env,PYTHONPATH:directory}});assert.notEqual(repeated.status,0);
  assert.equal((await readdir(join(directory,'outputs'))).length,1);
  assert.ok(!command.includes('present_files'));assert.ok(!command.includes('show_widget'));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('full proxy uses native file delivery for GPT OAuth and Gemini OAuth including image-sized frames',async()=>{
 const {createHandler}=await import('./handler.mjs');
 for(const platform of ['openai','gemini'])for(const streaming of [false,true]){
  let uploads=0,dispatched=0,finished=0;
  const payload=Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(1024*1024)]).toString('base64');
  const handler=createHandler({url:'https://project.supabase.co',serviceKey:'private',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
   url=String(url);
   if(url.endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',allow_image_generation:true,account:{id:'account',platform,type:'oauth',credential_storage:'vault',credential_version:1,codex_settings:{auto_sync:'false'},credentials:{access_token:'private',chatgpt_account_id:'account',project_id:'project',oauth_type:'ai_studio',expires_at:Date.now()+3600000}}});
   if(url.endsWith('/s2a_personal_finish')){finished++;return Response.json(null);}
   if(url.endsWith('/s2a_chat_media_register'))return Response.json(true);
   if(url.includes('/storage/v1/object/sign/'))return Response.json({signedURL:new URL(url).pathname.replace('/storage/v1','')+'?token=synthetic'});
   if(url.includes('/storage/v1/object/')){uploads++;assert.deepEqual(Buffer.from(init.body),Buffer.from(payload,'base64'));return Response.json({});}
   dispatched++;
   const request=JSON.parse(init.body);
   assert.ok(JSON.stringify(request).includes('automatically creates an inline native image card'));
   const reply=platform==='openai'?upstream([{type:'response.completed',response:{model:'gpt-test',status:'completed',output:[{...image,result:payload}],usage:{input_tokens:2,output_tokens:3}}}]):upstream([{candidates:[{content:{role:'model',parts:[{text:'Here'},{inlineData:{mimeType:'image/png',data:payload}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:2,candidatesTokenCount:3}}]);
   return reply;
  });
  const response=await handler(new Request('https://edge/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer client','content-type':'application/json'},body:JSON.stringify({...client,model:platform==='openai'?'gpt-6.1':'gemini-3.1-flash-image',stream:streaming,messages:[{role:'user',content:'Generate one image'}]})}));
  assert.equal(response.status,200);
  if(streaming){const raw=await response.text();assert.ok(raw.includes('[DONE]'));assert.ok(raw.includes('Bash'));assert.ok(!raw.includes('base64'));assert.ok(!raw.includes('upstream_error'));}
  else{const result=await response.json();assert.equal(result.choices?.[0]?.message?.tool_calls?.[0]?.function?.name,'Bash',JSON.stringify(result));assert.ok(!result.choices[0].message.content?.includes('base64'));}
  assert.equal(dispatched,1);assert.equal(uploads,1);assert.equal(finished,1);
 }
});

test('failed generation/storage never advertises successful native export, cancellation stops upstream',async()=>{
 const failed=upstream([{type:'response.output_item.done',output_index:0,item:image},{type:'response.failed',response:{status:'failed',output:[]}}]);
 const {db}=storage();
 const raw=await new Response(streamChat(publishChatMedia(db,failed,'lease',new AbortController().signal,client).body,'id','gpt-test')).text();
 assert.ok(raw.includes('upstream_error'));assert.ok(!raw.includes('Bash'));assert.ok(!raw.includes('[DONE]'));
 const unavailable={...storage().db,fetchImpl:async()=>new Response('',{status:503})};
 await assert.rejects(completedResponse(publishChatMedia(unavailable,upstream(nativeEvents('gpt')),'lease',new AbortController().signal,client).body),/artifact_storage_unavailable/);
 let cancelled=false;
 const input=new Response(new ReadableStream({cancel(){cancelled=true;}}));
 await publishChatMedia(db,input,'lease',new AbortController().signal,client).body.cancel();assert.equal(cancelled,true);
});
test('multiple originals share a single download call and signed foreign sources are rejected',async()=>{
 const second={...image,id:'image-2',result:Buffer.from([255,216,255,0]).toString('base64')};
 const {db}=storage();
 const completed=await completedResponse(publishChatMedia(db,upstream([{type:'response.completed',response:{status:'completed',output:[image,second]}}]),'lease',new AbortController().signal,{...client,parallel_tool_calls:false}).body);
 assert.equal(completed.output.length,1);assert.equal(completed.output[0].type,'function_call');
 assert.equal(JSON.parse(completed.output[0].arguments).command.match(/\/storage\/v1\/object\/sign\//g).length,2);
 await assert.rejects(completedResponse(publishChatMedia(db,upstream([{type:'response.completed',response:{status:'completed',output:[{...image,result:undefined,chat_image_url:source.replace('project.supabase.co','foreign.example')}]}}]),'lease',new AbortController().signal,client).body),/invalid_generated_image/);
 assert.throws(()=>nativeImageDownload(['https://example.com/ordinary.png']),/Invalid/);
});
