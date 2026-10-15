import {randomUUID} from 'node:crypto';
import {resolveProjectCredentials} from './project-credentials.mjs';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {imageArtifactPath,putArtifact,getArtifact,signArtifact,deleteArtifacts,listTaskArtifacts} from '../supabase/functions/sub2api/artifact_storage.ts';

const env=await resolveProjectCredentials(process.env);
const db=new Database({url:env.SUPABASE_URL,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY});
const taskId='imgtask_'+randomUUID().replaceAll('-','');
const path=imageArtifactPath(taskId,'result','json');
let failure;
const bytes=new TextEncoder().encode(JSON.stringify({probe:randomUUID()}));
try{
 await putArtifact(db,path,bytes,'application/json');
 const stored=await getArtifact(db,path,AbortSignal.timeout(30000));
 if(Buffer.compare(Buffer.from(await stored.arrayBuffer()),Buffer.from(bytes)))throw Error('Artifact roundtrip mismatch');
 const publicResponse=await fetch(env.SUPABASE_URL+'/storage/v1/object/public/sub2api-artifacts/'+path,{signal:AbortSignal.timeout(30000),redirect:'error'});
 await publicResponse.body?.cancel();if(publicResponse.ok)throw Error('Private artifact was publicly accessible');
 const signed=await signArtifact(db,path,60);
 const authorized=await fetch(signed,{signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!authorized.ok||Buffer.compare(Buffer.from(await authorized.arrayBuffer()),Buffer.from(bytes)))throw Error('Signed artifact read failed');
 console.log('Artifact storage verified: private upload/read, denied public access and signed download');
}catch(error){failure=error;throw error;}finally{
 try{
  await deleteArtifacts(db,[path]);
  if((await listTaskArtifacts(db,taskId)).includes(path))throw Error('Artifact verification file was not removed');
  console.log('Artifact verification file removed');
 }catch(error){if(!failure)throw error;console.error('Artifact verification cleanup failed');}
}

