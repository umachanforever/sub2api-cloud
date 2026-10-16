// Match the original accountCodexToolCapabilities account and model boundaries.
function canonical(model:string):string{
 return model.trim().split('/').at(-1)!.trim().toLowerCase().replace(/[_\s]+/g,'-').replace(/-+/g,'-');
}
export function astraCodexModel(model:string):boolean{
 const id=canonical(model);return id==='gpt-6'||id==='gpt-6-astra'||id.startsWith('gpt-6-astra-');
}
function sol61(model:string):boolean{
 return /^gpt-6\.1-sol(?:-(?:none|minimal|low|medium|high|xhigh|max|openai-compact))?$/.test(canonical(model));
}
export function apiKeyCodexCapabilities(model:string,baseURL='https://api.openai.com'):Record<string,unknown>{
 let host:string;try{host=new URL(baseURL).hostname.toLowerCase();}catch{return {};}
 const capabilities:Record<string,unknown>={};
 if(host==='api.openai.com'&&(astraCodexModel(model)||sol61(model)))Object.assign(capabilities,{
  supports_search_tool:true,apply_patch_tool_type:'freeform',comp_hash:'3000',tool_mode:null,use_responses_lite:false,
 });
 if(host.replace(/\.$/,'')==='api.openai.com'&&astraCodexModel(model))capabilities.service_tiers=[
  {id:'priority',name:'Fast',description:'Priority processing for lower latency.'},
  {id:'ultrafast',name:'Ultrafast',description:'Lowest latency; 6x Standard token pricing.'},
 ];
 return capabilities;
}
