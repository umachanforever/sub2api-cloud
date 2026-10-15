import {HttpError} from './db.ts';
export function validateSystemOneJson(source:string):void{
 const body=JSON.parse(source),object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const fail=():never=>{throw new HttpError(400,'invalid_systemone_request');};
 if(!object(body)||body.model!=='jev-latest'||body.state===null||body.state===undefined||!['string','object'].includes(typeof body.state)||!object(body.questions)||!Object.keys(body.questions).length)fail();
 if(body.stream!==undefined&&body.stream!==null&&body.stream!==false)fail();
 const description=(v:unknown)=>v!==null&&v!==undefined&&['string','object'].includes(typeof v);
 for(const q of Object.values(body.questions)){
  if(!object(q))throw new HttpError(400,'invalid_systemone_request');
  if(typeof q.type!=='string'||q.instructions!==null&&q.instructions!==undefined&&!description(q.instructions))fail();
  if(q.type==='noul'){const criteria=q.criteria;if(criteria!==undefined&&criteria!==null&&(!object(criteria)||['true','false'].some(k=>criteria[k]!==undefined&&criteria[k]!==null&&!description(criteria[k]))))fail();}
  else if(q.type==='choice'){if(!object(q.criteria)||Object.values(q.criteria).some(v=>v!==null&&!description(v)))fail();}
  else if(q.type==='score'){if(!Array.isArray(q.criteria)||!q.criteria.length||q.criteria.some(v=>!description(v)))fail();}
  else fail();
 }
 // Inspect member names before JSON.parse discards duplicates or spelling variants.
 const tokens=source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)??[];let index=0;
 const visit=(scope:string):void=>{
  const token=tokens[index++];
  if(token==='{'){
   const seen=new Set<string>(),fields=scope==='root'?['model','state','questions','stream']:scope==='question'?['type','instructions','criteria']:[];
   while(tokens[index]!=='}'){
    const key=JSON.parse(tokens[index++]) as string;index++;
    if(scope!=='other'&&(seen.has(key)||fields.some(field=>field!==key&&field===key.toLowerCase())))fail();seen.add(key);
    visit(scope==='root'&&key==='questions'?'questions':scope==='questions'?'question':'other');
    if(tokens[index]!==',')break;index++;
   }index++;
  }else if(token==='['){while(tokens[index]!==']'){visit('other');if(tokens[index]!==',')break;index++;}index++;}
 };visit('root');
}
export function systemOneTokens(value:unknown):number|null{
 if(typeof value!=='number'&&typeof value!=='string'||typeof value==='string'&&!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value.trim()))return null;
 const n=Number(value);return Number.isFinite(n)&&n>=0?Math.min(2**40,Math.round(n)):null;
}
