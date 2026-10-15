import {HttpError} from './db.ts';
type Item=Record<string,any>;
export type GrokSearch={query:string;maxResults:number;kind:'web_search'|'x_search';tool:Item};
export function grokSearchInput(body:Item,kind:GrokSearch['kind']):GrokSearch{
  for(const field of ['query','input','from_date','to_date'])if(body[field]!==undefined&&typeof body[field]!=='string')throw new HttpError(400,'invalid_request');
  if(body.max_results!==undefined&&!Number.isSafeInteger(body.max_results))throw new HttpError(400,'invalid_request');
  const query=body.query?.trim()||body.input?.trim();if(!query)throw new HttpError(400,'search_query_required');
  const maxResults=body.max_results>0?Math.min(body.max_results,20):5,tool:Item={type:kind};
  for(const field of ['allowed_x_handles','excluded_x_handles'])if(body[field]!==undefined){if(!Array.isArray(body[field])||body[field].some((value:unknown)=>typeof value!=='string'))throw new HttpError(400,'invalid_request');if(kind==='x_search'&&body[field].length)tool[field]=body[field];}
  for(const field of ['from_date','to_date'])if(kind==='x_search'&&body[field]?.trim())tool[field]=body[field].trim();
  for(const field of ['enable_image_understanding','enable_video_understanding'])if(body[field]!==undefined){if(typeof body[field]!=='boolean')throw new HttpError(400,'invalid_request');if(kind==='x_search')tool[field]=body[field];}
  return {query,maxResults,kind,tool};
}
export function grokSearchBody(search:GrokSearch,model:string):Item{
  const x=search.kind==='x_search';
  const input=`Search ${x?'X':'the web'} for the user query below. Return ONLY valid JSON with this exact shape: {"results":[{"url":"https://...","title":"${x?'post or page':'page'} title","snippet":"concise factual summary"}]}. Return at most ${search.maxResults} unique results. Every URL must be an actual ${search.kind} source. Populate a non-empty title and snippet for every result. Do not wrap the JSON in markdown.\n\nUser query:\n${search.query}`;
  return {model,input,tools:[search.tool],...(x?{tool_choice:'required'}:{}),include:[search.kind+'.action.sources'],store:false,stream:false};
}
export function grokSearchOutput(value:Item,search:GrokSearch):Item{
  const sources=new Map<string,Item>(),texts:string[]=[];
  const normalize=(raw:unknown):string|undefined=>{if(typeof raw!=='string')return;try{const url=new URL(raw.trim());if(!['http:','https:'].includes(url.protocol))return;url.hash='';return url.href;}catch{return;}};
  const title=(raw:unknown,url:string)=>typeof raw==='string'&&raw.trim()!==url&&!/^[+-]?\d+$/.test(raw.trim())?raw.trim():'';
  const source=(item:Item)=>{const key=normalize(item?.url);if(!key)return;const previous=sources.get(key)??{url:item.url.trim(),title:'',snippet:''};previous.title||=title(item.title,previous.url);previous.snippet||=typeof item.snippet==='string'?item.snippet.trim():'';sources.set(key,previous);};
  const list=(value:unknown):Item[]=>Array.isArray(value)?value:[];
  for(const item of list(value.output)){
    if(['web_search_call','x_search_call'].includes(item?.type))for(const entry of list(item.action?.sources))source(entry);
    if(item?.type==='message')for(const part of list(item.content))if(part?.type==='output_text'){if(typeof part.text==='string')texts.push(part.text);for(const ann of list(part.annotations))if(['url_citation','web'].includes(ann?.type))source(ann);}
  }
  const results:Item[]=[],seen=new Set<string>();
  for(const text of texts){let structured:Item;try{structured=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));}catch{continue;}
    if(!Array.isArray(structured.results))continue;
    for(const result of structured.results){const key=normalize(result?.url),actual=key?sources.get(key):undefined;if(!key||!actual||seen.has(key)||results.length>=search.maxResults)continue;seen.add(key);results.push({url:actual.url,title:title(result.title,actual.url)||actual.title||new URL(actual.url).hostname.replace(/^www\./,''),snippet:typeof result.snippet==='string'&&result.snippet.trim()||actual.snippet});}
  }
  for(const [key,result] of sources){if(results.length>=search.maxResults)break;if(!seen.has(key))results.push({...result,title:result.title||new URL(result.url).hostname.replace(/^www\./,'')});}
  return {query:search.query,results,provider:'grok-native',max_results:search.maxResults};
}
