type Body=Record<string,unknown>;
const text=(value:unknown):string=>typeof value==='string'?value.trim():'';
function imageModel(value:unknown):boolean{
 const model=text(value).toLowerCase();return model.startsWith('gpt-image-')||model==='grok-imagine'||model==='grok-imagine-edit'||model.startsWith('grok-imagine-image');
}
function tools(value:unknown,namespaces:boolean):boolean{
 return Array.isArray(value)&&value.some(tool=>tool&&typeof tool==='object'&&!Array.isArray(tool)&&(text(tool.type)==='image_generation'||namespaces&&text(tool.type)==='namespace'&&text(tool.name)==='image_gen'));
}
function choice(value:unknown,explicit:boolean,depth=0):boolean{
 if(depth>32)return false;
 if(typeof value==='string')return value.trim()==='image_generation';
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const item=value as Body,fn=item.function as Body|undefined;
 if(text(item.type)==='image_generation'||text(item.type)==='namespace'&&[text(item.name),text(item.namespace)].includes('image_gen')||fn&&text(fn.name)==='image_generation')return true;
 if(explicit){
  for(const ref of [item,fn])if(ref&&typeof ref==='object'&&(text(ref.namespace)==='image_gen'&&text(ref.name)==='imagegen'||['image_gen.imagegen','image_gen__imagegen'].includes(text(ref.name))))return true;
 }
 return choice(item.tool,explicit,depth+1);
}
// Match upstream OpenAI intent rules and Grok's exception for passive Codex catalogs.
export function imageGenerationIntent(path:string,model:string,body:Body|undefined,platform='openai'):boolean{
 if(/^\/(?:v1\/)?images\/(?:generations|edits)$/.test(path)||imageModel(model)||imageModel(body?.model))return true;
 if(!body)return false;
 const grok=platform==='grok';
 if(tools(body.tools,!grok)||choice(body.tool_choice,grok))return true;
 if(!grok&&Array.isArray(body.input)&&body.input.some(item=>item?.type==='additional_tools'&&tools(item.tools,true)))return true;
 return false;
}
