import type {Database} from './db.ts';
import type {Account} from './accounts.ts';
import type {ApiKeyCredentials} from './gateway.ts';
import {accountFetch} from './account_proxy.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {multiProtocolProvider,providerHasModelCatalog,providerEndpoint,type ProviderProtocol} from './provider_routing.ts';
import {ProviderProtocolCatalog,readProviderProtocolCatalog} from './provider_protocol_catalog.ts';

const catalogs=new WeakMap<Database,ProviderProtocolCatalog>();
export async function providerCatalogProtocols(db:Database,account:Account,credentials:ApiKeyCredentials,model:string,signal:AbortSignal):Promise<ProviderProtocol[]>{
  const platform=account.platform;
  if(!multiProtocolProvider(platform)||!model||!providerHasModelCatalog(platform,credentials))return [];
  const endpoint=providerEndpoint(platform,credentials,'models');
  const key=JSON.stringify([account.id,account.credential_version,endpoint,account.proxy_id??null]);
  let cache=catalogs.get(db);if(!cache){cache=new ProviderProtocolCatalog();catalogs.set(db,cache);}
  return await cache.lookup(key,model,signal,async()=>{
    const timeout=AbortSignal.timeout(15_000);
    const outbound=apiKeyRequest(platform,credentials,'models','/v1/models',undefined,new Request('https://gateway/v1/models'),timeout);
    return await readProviderProtocolCatalog(await accountFetch(db,account,outbound.url,outbound.init));
  });
}
