import {vertexBatchEndpoint,vertexBatchManagedRefs} from './vertex_batch.ts';
export type VertexBatchConfig={bucket:string;location:string;environment:string};
export const batchImageVariables=['SUB2API_VERTEX_BATCH_BUCKET','SUB2API_VERTEX_BATCH_LOCATION','SUB2API_VERTEX_BATCH_ENVIRONMENT'] as const;
export function vertexBatchConfig(env:Record<string,string|undefined>):VertexBatchConfig|undefined{
 const [bucket,location,environment]=batchImageVariables.map(key=>env[key]?.trim()??'');
 if(!bucket){if(location||environment)throw Error('Configure SUB2API_VERTEX_BATCH_BUCKET with Vertex batch settings');return undefined;}
 const config={bucket,location:location||'global',environment:environment||'production'};
 vertexBatchManagedRefs(config.bucket,'imgbatch_configuration',config.environment);
 vertexBatchEndpoint('configuration',config.location);
 return config;
}
export function batchImageSecrets(env:Record<string,string|undefined>):string{
 const config=vertexBatchConfig(env);
 // Empty values also clear previously deployed optional settings.
 return batchImageVariables.map((key,index)=>`${key}=${config?[config.bucket,config.location,config.environment][index]:''}\n`).join('');
}
