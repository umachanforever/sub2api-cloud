import {HttpError} from './db.ts';
// Match ValidateOpenAIServiceTierField before account admission or provider I/O.
export function normalizeServiceTier(body:Record<string,unknown>):void{
 if(body.service_tier===undefined||body.service_tier===null)return;
 if(typeof body.service_tier!=='string')throw new HttpError(400,'invalid_service_tier');
 let value=body.service_tier.trim().toLowerCase();
 if(value==='fast')value='priority';
 if(!['auto','default','flex','priority','scale','ultrafast'].includes(value))throw new HttpError(400,'invalid_service_tier');
 body.service_tier=value;
}
// Log only bounded scalar values; OpenAI usage follows its canonical tier names.
export function serviceTierForUsage(value:unknown,platform='openai'):string|null{
 if(typeof value!=='string')return null;
 let tier=value.trim().toLowerCase();
 if(platform==='openai'){
  if(tier==='fast')tier='priority';
  if(!['auto','default','flex','priority','scale','ultrafast'].includes(tier))return null;
 }
 return /^[a-z][a-z0-9_-]{0,15}$/.test(tier)?tier:null;
}
