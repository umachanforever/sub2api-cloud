// Execute the retained upstream Go functions verbatim as a differential oracle.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {retryInfo} from '../supabase/functions/sub2api/antigravity_policy.ts';
const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
function extract(source,name){
 const start=source.indexOf(`func ${name}(`);assert.ok(start>=0,`Missing upstream function ${name}`);
 const next=source.indexOf('\nfunc ',start+1);return source.slice(start,next<0?source.length:next);
}
const retry=await read('backend/internal/service/antigravity_gateway_retry.go');
const scope=await read('backend/internal/service/antigravity_quota_scope.go');
const service=await read('backend/internal/service/antigravity_gateway_service.go');
const constants=service.split('\n').filter(line=>/^\s+(googleRPC\w+|antigravityDefaultRateLimitDuration)\s*=/.test(line)).join('\n');
const type=retry.match(/type antigravitySmartRetryInfo struct \{[\s\S]*?\n\}/)?.[0];assert.ok(type);
const oracle=`package main
import ("encoding/json";"os";"strings";"time")
var logger=struct{LegacyPrintf func(string,string,...any)}{func(string,string,...any){}}
const (${constants}\n)
${type}
${extract(scope,'normalizeAntigravityModelName')}
${extract(retry,'parseAntigravitySmartRetryInfo')}
func main(){var inputs []json.RawMessage;if err:=json.NewDecoder(os.Stdin).Decode(&inputs);err!=nil{panic(err)};outputs:=[]any{};for _,input:=range inputs{v:=parseAntigravitySmartRetryInfo(input);if v==nil{outputs=append(outputs,nil)}else{outputs=append(outputs,map[string]any{"model":v.ModelName,"delay":float64(v.RetryDelay)/float64(time.Millisecond),"capacity":v.IsModelCapacityExhausted})}};json.NewEncoder(os.Stdout).Encode(outputs)}
`;
const cases=[];
for(const status of ['RESOURCE_EXHAUSTED','UNAVAILABLE','UNKNOWN'])for(const reason of ['RATE_LIMIT_EXCEEDED','MODEL_CAPACITY_EXHAUSTED','UNRELATED'])for(const model of ['gemini-test','projects/p/locations/global/publishers/google/models/GEMINI-TEST',''])for(const retryDelay of ['0.5s','.5s','4m50s','1h30m','invalid',{seconds:5}]) {
 cases.push({error:{status,details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason,metadata:{model}},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay}]}});
}
cases.push({error:{status:'RESOURCE_EXHAUSTED',details:[{reason:'RATE_LIMIT_EXCEEDED',metadata:{model:'gemini-test'}}]}});
const dir=await mkdtemp(join(tmpdir(),'s2a-policy-oracle-'));
try{
 const path=join(dir,'main.go');await writeFile(path,oracle);
 const reference=JSON.parse(execFileSync('go',['run',path],{input:JSON.stringify(cases),encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024}));
 for(const [index,input] of cases.entries()){
  const result=retryInfo(input.error.status==='UNAVAILABLE'?503:429,{},input);
  const actual=result.modelScoped?{model:result.model,delay:result.delay,capacity:result.capacity}:null;
  assert.deepEqual(actual,reference[index],`Upstream mismatch for ${JSON.stringify(input)}`);
 }
 console.log(`Antigravity smart-retry parity passed: ${cases.length} cases against verbatim retained Go functions.`);
}finally{await rm(dir,{recursive:true,force:true});}
