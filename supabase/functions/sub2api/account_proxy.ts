import { Database, HttpError } from "./db.ts";
import { decryptSecret } from "./credential_store.ts";
import { integer } from "./validation.ts";
type ProxyRow = {
  id: number | string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  ciphertext: string;
  iv: string;
};
const proxyId = (value: unknown) => integer(value, 1, Number.MAX_SAFE_INTEGER);
import { fetchWithProxy } from "./proxy_transport.ts";

export async function proxyFetch(
  db: Database,
  id: number | string | null | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
  native = false,
): Promise<Response> {
  const proxy=await resolveProxy(db,id,native);
  if(!proxy)return db.fetchImpl(input,init);
  return fetchWithProxy(
    {
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
    },
    input,
    init,
    db.fetchImpl,
  );
}
export async function resolveProxy(db:Database,id:number|string|null|undefined,native=false):Promise<import('./proxy_transport.ts').TransportProxy|null>{
  if (id == null) return null;
  if (
    native &&
    (!/^[1-9][0-9]{0,18}$/.test(String(id)) ||
      (typeof id === "number" && !Number.isSafeInteger(id)) ||
      BigInt(id) > 9223372036854775807n)
  )
    throw new HttpError(400, "invalid_proxy_id");
  const route = await db.rpc<{
    proxy?: (ProxyRow & { password?: string }) | null;
    error?: string;
    status?: number;
  }>(native ? "s2a_gateway_proxy_route" : "s2a_proxy_route", {
    p_id: native ? String(id) : proxyId(id),
  });
  if (route.error) throw new HttpError(route.status ?? 503, route.error);
  if (route.proxy === null) return null;
  if (!route.proxy) throw new HttpError(503, "proxy_route_unavailable");
  const proxy = route.proxy,
    secret = native
      ? proxy
      : await decryptSecret(proxy, db.config.encryptionKey);
  if (typeof secret.password !== "string")
    throw new HttpError(503, "proxy_credentials_unavailable");
  return {protocol:proxy.protocol,host:proxy.host,port:proxy.port,username:proxy.username,password:secret.password};
}
export function accountFetch(
  db: Database,
  account: { proxy_id?: number | string | null; credential_storage?: string },
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  return proxyFetch(
    db,
    account.proxy_id,
    input,
    init,
    account.credential_storage === "vault",
  );
}
export function proxyFetcher(
  db: Database,
  id: number | string | null | undefined,
  native = false,
): typeof fetch {
  return (input, init) => proxyFetch(db, id, input, init, native);
}
