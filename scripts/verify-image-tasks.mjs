import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export async function verifyImageTasks(config,fetcher=fetch,pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))){
 const base=new URL(config.base_url);
 if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/v1')||typeof config.api_key!=='string'||!config.api_key)throw Error('Configure a valid base_url ending in /v1 and api_key');
 const api=base.href,headers={authorization:'Bearer '+config.api_key},model=config.image_model??'gpt-image-2';
 async function submit(operation,input){
  let value;
  if(operation==='generations'&&config.resume_task_id){
   if(!/^imgtask_[a-f0-9]{32}$/.test(config.resume_task_id))throw Error('Invalid resume task identifier');
   value={id:config.resume_task_id,poll_url:api+'/images/tasks/'+config.resume_task_id};
  }else{
  const response=await fetcher(api+'/images/'+operation+'/async',{method:'POST',headers:{...headers,...(input instanceof FormData?{}:{'content-type':'application/json'})},body:input instanceof FormData?input:JSON.stringify(input),signal:AbortSignal.timeout(60000),redirect:'error'});
  if(response.status!==202){await response.body?.cancel();throw Error('Image submission failed: HTTP '+response.status);}
  value=await response.json();
  if(!/^imgtask_[a-f0-9]{32}$/.test(value.id)||value.task_id!==value.id||value.status!=='processing'||typeof value.poll_url!=='string'||new URL(value.poll_url,api).href!==api+'/images/tasks/'+value.id||response.headers.get('location')!==value.poll_url||response.headers.get('cache-control')!=='no-store')throw Error('Invalid image submission response');
  value.poll_url=new URL(value.poll_url,api).href;
  }
  const denied=await fetcher(value.poll_url,{signal:AbortSignal.timeout(15000),redirect:'error'});await denied.body?.cancel();if(denied.status!==401)throw Error('Image poll accepted anonymous access');
  const deadline=Date.now()+300000;
  while(Date.now()<deadline){
   const poll=await fetcher(value.poll_url,{headers,signal:AbortSignal.timeout(15000),redirect:'error'});
   if(!poll.ok){await poll.body?.cancel();throw Error('Image polling failed: HTTP '+poll.status);}
   const task=await poll.json();
   if(task.id!==value.id||task.result_path!==undefined||task.result_hash!==undefined||poll.headers.get('cache-control')!=='no-store')throw Error('Invalid image task projection');
   if(task.status==='failed')throw Error('Image task failed: '+(['image_task_failed','image_task_timeout','image_task_execution_unknown','image_task_invalid_input','image_task_storage_failed','image_task_key_unavailable','image_task_expired','image_task_upload_timeout'].includes(task.error?.code)?task.error.code:'unknown'));
   if(task.status==='completed'){
    const url=new URL(task.image_url);
    if(task.result?.data?.[0]?.url!==url.href||url.origin!==base.origin||!url.pathname.startsWith('/storage/v1/object/sign/sub2api-artifacts/images/'+value.id+'/image-')||url.username||url.password||!url.searchParams.get('token'))throw Error('Invalid signed image result');
    const image=await fetcher(url.href,{signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!image.ok||!/^image\//.test(image.headers.get('content-type')??'')){await image.body?.cancel();throw Error('Signed image download failed');}
    const bytes=new Uint8Array(await image.arrayBuffer());if(!bytes.length||bytes.length>16*1024*1024)throw Error('Invalid generated image size');
    return {bytes,type:image.headers.get('content-type')};
   }
   if(task.status!=='processing'||poll.headers.get('retry-after')!=='3')throw Error('Invalid processing image task');
   await pause(3000);
  }
  throw Error('Image polling timed out');
 }
 const image=await submit('generations',{model,prompt:'A simple solid blue square on a white background.',size:'1024x1024',quality:'low',n:1});
 const results=['async-generation','authenticated-polling','private-signed-download'];
 if(config.verify_edits){
  const form=new FormData();form.set('model',model);form.set('prompt','Change the blue square to green.');form.set('size','1024x1024');form.set('quality','low');form.set('n','1');form.set('image',new Blob([image.bytes],{type:image.type}),'input.png');
  await submit('edits',form);results.push('async-multipart-edit');
 }
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const config=JSON.parse(await readFile(new URL('../.local/agent-access.json',import.meta.url),'utf8'));config.verify_edits=process.argv.includes('--edit');config.resume_task_id=process.argv.find(arg=>arg.startsWith('--resume='))?.slice(9);console.log('Cloud image tasks verified: '+(await verifyImageTasks(config)).join(', '));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
