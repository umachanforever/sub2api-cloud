import {HttpError} from './db.ts';

export function cachePatch(body:Record<string,unknown>,mask:string,now=Date.now(),maxSeconds=86400):{expireTime:string}{
 const value={...body};
 if('expire_time' in value){
  if('expireTime' in value)throw new HttpError(400,'conflicting_cache_expiry');
  value.expireTime=value.expire_time;delete value.expire_time;
 }
 if(Object.keys(value).some(key=>!['ttl','expireTime','name'].includes(key))||mask.split(',').some(key=>!['','ttl','expireTime','expire_time'].includes(key.trim())))throw new HttpError(400,'immutable_cache_field');
 const ttl=value.ttl,expiry=value.expireTime;
 if(ttl!=null&&expiry!=null)throw new HttpError(400,'conflicting_cache_expiry');
 let seconds:number;
 if(ttl!=null){
  if(typeof ttl!=='string'||!/^\s*\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?s\s*$/.test(ttl))throw new HttpError(400,'invalid_cache_ttl');
  seconds=Math.ceil(Number(ttl.trim().slice(0,-1)));
 }else if(expiry!=null){
  if(typeof expiry!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(expiry.trim()))throw new HttpError(400,'invalid_cache_expiry');
  const parts=expiry.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)!;
  const [year,month,day,hour,minute,second]=parts.slice(1).map(Number);
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)throw new HttpError(400,'invalid_cache_expiry');
  seconds=Math.ceil((Date.parse(expiry.trim())-now)/1000);
 }else throw new HttpError(400,'cache_expiry_required');
 if(!Number.isFinite(seconds)||seconds<=0||seconds>maxSeconds)throw new HttpError(400,'invalid_cache_ttl');
 return {expireTime:new Date(now+seconds*1000).toISOString()};
}
