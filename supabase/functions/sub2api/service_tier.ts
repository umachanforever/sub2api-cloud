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
