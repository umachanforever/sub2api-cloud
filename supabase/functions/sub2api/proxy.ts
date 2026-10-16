import {normalizeServiceTier} from './service_tier.ts';
import {configuredCodexCatalog,type ConfiguredModelSources} from './configured_codex_catalog.ts';
import {codexManifestResponse} from './model_catalog_response.ts';
import {pinnedModelCatalog,type PinnedModelCatalog} from './pinned_models.ts';
import {compositeModelCatalog,completeCompositeCodexCatalog,type CompositeCatalogSources,type CompositeCapabilitySource} from './composite_catalog.ts';
import {multiProtocolProvider,providerProtocol,openCodeSession} from './provider_routing.ts';
import {originalChatBridge,originalAnthropicBridge,originalGeminiBridge,originalGeminiRestBody,originalMessagesToResponses,type OriginalChatBridge} from './original_chat_bridge.ts';
import {invalidateVertexTokenContext} from './vertex_auth.ts';
import {providerCatalogProtocols} from './provider_catalog_lookup.ts';
import {fallbackGeminiCatalog,antigravityGeminiModels,antigravityOnlyCatalog,mergeGeminiCatalog,type GeminiCatalogSources} from './gemini_catalog.ts';
import {vertexGeminiCatalog} from './vertex_catalog.ts';
import {vertexGeminiRequest} from './vertex_gemini.ts';
import {vertexAnthropicRequest} from './vertex_anthropic.ts';
import {anthropicModelCatalog,completeAnthropicCodexCatalog} from './anthropic_catalog.ts';
import {usageEndpoint} from './usage_endpoint.ts';
import {validateSystemOneJson} from './typesafe.ts';
import {resolveProxy} from './account_proxy.ts';
import {imageGenerationIntent} from './image_policy.ts';
import {countGeminiTokens} from './gemini_count_tokens.ts';
import {validateGeminiCacheJson,geminiCacheName,resolveGeminiCache,rewriteGeminiCache} from './gemini_cache_reference.ts';
import {voiceUpload,voiceResponse} from './grok_voice.ts';
import {grokSearchInput,grokSearchBody,grokSearchOutput,type GrokSearch} from './grok_search.ts';
import {imageResponses} from './image_responses.ts';
import {oauthImageRequest,oauthImageOutput,directModels} from './oauth_images.ts';
import {imageForm,validateImageEdit} from './image_input.ts';
import {grokImageForm} from './grok_images.ts';
import {alphaSearch,SearchUpstreamError} from './alpha_search.ts';
import {inputTokenRequest,countInputTokens,countMessageTokens} from './input_tokens.ts';
import {requestBodyLimit} from './request_limits.ts';
import { currentCodexIdentity } from "./codex_identity.ts";
import { upstreamErrorCode } from "./upstream_errors.ts";
import { defaultSolModel, validateCodexReasoning } from "./codex_models.ts";
import { grokOAuthRequest } from './grok_oauth.ts';
import { accountFetch } from "./account_proxy.ts";
import { anthropicOAuthRequest } from "./anthropic_oauth.ts";
import { antigravityOAuthRequest, forwardAntigravity } from "./antigravity_oauth.ts";
import { googleOAuthCatalog, googleOAuthRequest, normalizeCodeAssist } from "./google_oauth.ts";
import { recordOpsError, type ErrorContext } from "./ops_errors.ts";
import { mappedCatalog, mappedTarget, type ModelSources } from "./model_mapping.ts";
import { quotaHeaderWindows } from "./openai_quota_pause.ts";
import { filterModelCatalog, modelCandidates, type ModelAllowlist } from "./model_policy.ts";
import { type Account, credentialsFor } from "./accounts.ts";
import { Database, HttpError } from "./db.ts";
import {
  buildHeaders,
  CODEX_MODELS_URL,
  CODEX_RESPONSES_URL,
  modelListFromManifest,
  normalizeBody,
  type Platform,
  type ApiKeyCredentials,
} from "./gateway.ts";
import {
  apiKeyRequest,
  type NativeProtocol,
  nativeResponse,
} from "./api_key_provider.ts";
import { decryptApiKeyCredentials,decryptSecret } from "./credential_store.ts";
import { hashKey, readBody,parseAccountCredentials } from "./validation.ts";
import { json } from "./http.ts";
import { trackedStream, UsageObserver, type Usage } from "./stream.ts";
import {
  chatToResponses,
  chatToAPIResponses,
  completedResponse,
  responseToChat,
  streamChat,
} from "./openai_protocol.ts";

import {
  responseToMessages,
  streamMessages,
} from "./anthropic_protocol.ts";

type ProviderAccount = Account & ({type:'service_account'}|{type?:'oauth'|'apikey'}) & {
  platform?: Platform;
};
type Reservation =
  | {pinned_catalog:PinnedModelCatalog;error?:never}
  | {anthropic_catalog:string[];anthropic_capabilities?:CompositeCapabilitySource[];anthropic_model_routing?:Record<string,(string|number)[]>;model_allowlist?:ModelAllowlist;error?:never}
  | {composite_catalog:CompositeCatalogSources;model_allowlist?:ModelAllowlist;error?:never}
  | {gemini_catalog_only:true;gemini_catalog_sources:GeminiCatalogSources;model_allowlist?:ModelAllowlist;error?:never}
  | { lease_id: string; account: ProviderAccount; model_allowlist?:ModelAllowlist; upstream_model?:string; model_sources?:ModelSources;gemini_catalog_sources?:GeminiCatalogSources; error?: never }
  | {
    error: string;
    status: number;
  };



export async function proxy(
  request: Request,
  path: string,
  token: string,
  db: Database,
  errorContext: ErrorContext,
  requiredPlatform?: Platform,
): Promise<Response> {
  return proxyWithIdentity(request,path,await hashKey(token),db,errorContext,requiredPlatform);
}

export type ImageJobIdentity = {id:string;lease_id:string;key_hash:string;client_ip:string|null;platform:"openai"|"grok";model:string;operation:"generations"|"edits"};

// Only signed workers may obtain this identity from the private queue RPC.
// No public request field or header can select a key hash or a job lease.
export async function proxyImageJob(request:Request,job:ImageJobIdentity,db:Database,errorContext:ErrorContext):Promise<Response>{
  if(db.config.dataModel!=="native"||request.method!=="POST"||!/^imgtask_[a-f0-9]{32}$/.test(job.id)||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(job.lease_id)||!(/^[a-f0-9]{64}$/.test(job.key_hash))||!["openai","grok"].includes(job.platform)||!["generations","edits"].includes(job.operation))throw new HttpError(400,"invalid_image_job_identity");
  return proxyWithIdentity(request,"/v1/images/"+job.operation,job.key_hash,db,errorContext,job.platform,job);
}

async function proxyWithIdentity(
  request:Request,path:string,keyHash:string,db:Database,errorContext:ErrorContext,requiredPlatform?:Platform,imageJob?:ImageJobIdentity,
):Promise<Response>{
  const requestId = errorContext.requestId;
  errorContext.keyHash = keyHash;
  const clientIp = imageJob ? imageJob.client_ip : request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const requireGrokPlatform=async(code:string)=>{
    const policy=await db.rpc<{platform?:string;error?:string;status?:number}|null>('s2a_personal_key_policy',{p_key_hash:keyHash,p_client_ip:clientIp});
    if(!policy)throw new HttpError(503,'database_unavailable');
    if(policy.error)throw new HttpError(policy.status??403,policy.error);
    if(policy.platform!=='grok')throw new HttpError(400,code);
  };

  const nativeGeminiModels = /^\/v1beta\/models(?:\/[^/]+)?$/.test(path) &&
    request.method === "GET";
  const modelId = /^\/(?:v1|v1beta)\/models\/([^/]+)$/.exec(path)?.[1];
  if (modelId) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(modelId);
    } catch {
      throw new HttpError(400, "invalid_model_id");
    }
    if (
      decoded.length > 200 || !/^[a-zA-Z0-9._:-]+(?:\/[a-zA-Z0-9._:-]+)*$/.test(decoded) ||
      decoded.split("/").some(segment=>segment === "." || segment === "..")
    ) throw new HttpError(400, "invalid_model_id");
  }
  const search = ["/v1/alpha/search", "/alpha/search", "/backend-api/codex/alpha/search"].includes(path) && request.method === "POST";
  const realtime=path==='/v1/realtime'&&request.method==='GET';
  if(realtime&&request.headers.get('upgrade')?.toLowerCase()!=='websocket')throw new HttpError(426,'websocket_upgrade_required');
  const customVoice=/^\/v1\/custom-voices(?:\/[A-Za-z0-9_-]{1,200}(?:\/audio)?)?$/.test(path);
  const customVoiceMethod=customVoice&&(path==='/v1/custom-voices'?['GET','POST']:/^\/v1\/custom-voices\/[^/]+\/audio$/.test(path)?['GET']:['GET','PATCH','DELETE']).includes(request.method);
  const voiceKind=realtime?'grok-voice-latest':customVoiceMethod?'custom-voices':/^\/v1\/(tts|stt)$/.exec(path)?.[1];
  const voice=realtime||customVoiceMethod||!!voiceKind&&request.method==='POST';
  let voiceBytes:Uint8Array|undefined;
  let voiceBody:Record<string,unknown>|undefined;
  const grokSearchKind=/^\/(?:v1\/)?(web_search|x_search)$/.exec(path)?.[1] as GrokSearch['kind']|undefined;
  const grokSearch=!!grokSearchKind&&request.method==='POST';
  let grokSearchOptions:GrokSearch|undefined;
  const codexModels = path === "/backend-api/codex/models";
  const models = (codexModels || path === "/v1/models" || !!modelId || nativeGeminiModels) &&
    request.method === "GET";
  const messageTokens = ["/v1/messages/count_tokens", "/messages/count_tokens"].includes(path) && request.method === "POST";
  const inputTokens = ["/v1/responses/input_tokens", "/responses/input_tokens", "/backend-api/codex/responses/input_tokens"].includes(path) && request.method === "POST";
  const embeddings = path === "/v1/embeddings" && request.method === "POST";
  const imageEdit = ["/v1/images/edits", "/images/edits"].includes(path);
  const images = ["/v1/images/generations", "/images/generations", "/v1/images/edits", "/images/edits"].includes(path) && request.method === "POST";
  const systemOne=path==='/v1/systemone'&&request.method==='POST';
  const chat = path === "/v1/chat/completions" && request.method === "POST";
  const messages = path === "/v1/messages" && request.method === "POST";
  const gemini = request.method === "POST"
    ? /^\/v1beta\/models\/([a-zA-Z0-9._-]{1,200}):(generateContent|streamGenerateContent|countTokens)$/
      .exec(path)
    : null;
  const geminiTokens=gemini?.[2]==='countTokens';
  const protocol: NativeProtocol = systemOne ? "systemone" : voice ? "voice" : embeddings
    ? "embeddings"
    : images
    ? "images"
    : models
    ? "models"
    : chat
    ? "chat"
    : messages
    ? "messages"
    : gemini
    ? "gemini"
    : "responses";
  const clientVersion = new URL(request.url).searchParams.get("client_version") || null;
  if (
    models && !modelId && clientVersion !== null &&
    (!/^[a-zA-Z0-9._+-]{1,100}$/.test(clientVersion))
  ) throw new HttpError(400, "invalid_client_version");
  const responses =
    ["/v1/responses", "/responses", "/backend-api/codex/responses"].includes(
      path,
    ) && request.method === "POST";
  if (!models && !responses && !chat && !messages && !gemini && !images && !embeddings && !inputTokens && !messageTokens && !search && !grokSearch && !voice && !systemOne) {
    throw new HttpError(404, "not_found");
  }
  if(geminiTokens&&db.config.dataModel==='native'){
    try{
      const policy=await db.rpc<{platform?:string;error?:string;status?:number}|null>('s2a_personal_key_policy',{p_key_hash:keyHash,p_client_ip:clientIp});
      if(!policy)throw new HttpError(503,'database_unavailable');
      if(policy.error)throw new HttpError(policy.status??403,policy.error);
      if(!['gemini','antigravity','composite'].includes(policy.platform??''))throw new HttpError(400,'gemini_group_required');
    }catch(error){await request.body?.cancel().catch(()=>{});throw error;}
  }
  if(voice){
    try{await requireGrokPlatform('grok_voice_requires_grok_group');}
    catch(error){await request.body?.cancel().catch(()=>{});throw error;}
  }
  if(systemOne){
    const policy=await db.rpc<{platform?:string;error?:string;status?:number}>('s2a_personal_key_policy',{p_key_hash:keyHash,p_client_ip:clientIp});
    if(!policy||policy.error)throw new HttpError(policy?.status??403,policy?.error??'database_unavailable');
    if(!['typesafe','composite'].includes(policy.platform??''))throw new HttpError(400,'systemone_requires_typesafe_group');
  }
  let body: Record<string, unknown> | undefined;
  let imageMultipart:FormData|undefined;
  let stream = true, includeUsage = false;
  if (!models) {
    try {
      const limit=requestBodyLimit(path, db.config.requestLimits);
      const parsed=imageEdit && /^multipart\/form-data(?:;|$)/i.test(request.headers.get("content-type")??"") ? await imageForm(request,limit) : undefined;
      imageMultipart=parsed?.form;
      if(voiceKind==='stt'||customVoiceMethod&&!['GET','DELETE'].includes(request.method))voiceBytes=await voiceUpload(request,limit);
      const raw = realtime?{model:'grok-voice-latest'}:customVoiceMethod?{model:'custom-voices'}:voiceBytes?{model:'stt'}:parsed?.body ?? await readBody(request,limit,systemOne?validateSystemOneJson:gemini?validateGeminiCacheJson:undefined);
      if (!systemOne && raw.stream !== undefined && typeof raw.stream !== "boolean") {
        throw new HttpError(400, "invalid_stream");
      }
      if (
        chat && raw.stream_options !== undefined &&
        (!raw.stream_options || typeof raw.stream_options !== "object" ||
          Array.isArray(raw.stream_options) ||
          ("include_usage" in raw.stream_options &&
            typeof raw.stream_options.include_usage !== "boolean"))
      ) throw new HttpError(400, "invalid_stream_options");
      stream = systemOne || geminiTokens || embeddings || inputTokens || messageTokens || search || grokSearch || voice ? false : chat || messages || images ? raw.stream === true : raw.stream !== false;
      includeUsage = chat &&
        (raw.stream_options as { include_usage?: boolean } | undefined)
            ?.include_usage === true;
      if(voice){if(!voiceBytes)voiceBody={...raw};raw.model=realtime?new URL(request.url).searchParams.get('model')?.trim()||'grok-voice-latest':voiceKind;raw.stream=false;}
      if(grokSearch){grokSearchOptions=grokSearchInput(raw,grokSearchKind!);raw.model='grok-4.6';raw.stream=false;}
      if(imageEdit && !imageMultipart)validateImageEdit(raw);
      if (images && (typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > 65536)) throw new HttpError(400, "invalid_request");
      if(images && (raw.model===undefined || typeof raw.model==="string" && !raw.model.trim())){
        if(db.config.dataModel==='native'){
          const policy=await db.rpc<{platform?:string;error?:string;status?:number}|null>('s2a_personal_key_policy',{p_key_hash:keyHash,p_client_ip:clientIp});
          if(!policy)throw new HttpError(503,'database_unavailable');
          if(policy.error)throw new HttpError(policy.status??403,policy.error);
          if(policy.platform==='grok')throw new HttpError(400,'image_model_required');
        }
        raw.model="gpt-image-2";
      }
      if(imageJob&&(raw.stream===true||raw.model!==imageJob.model))throw new HttpError(400,"image_task_input_mismatch");
      const requestedModel = gemini ? gemini[1] : raw.model;
      if (
        typeof requestedModel !== "string" || !requestedModel.trim() ||
        requestedModel.length > 200 || /[\x00-\x1f\x7f]/.test(requestedModel) || requestedModel === "__models__"
      ) throw new HttpError(400, "invalid_request");
      errorContext.model = requestedModel;
      errorContext.stream = typeof raw.stream === "boolean" ? raw.stream : gemini ? gemini[2] === "streamGenerateContent" : undefined;
      if (
        (chat || messages || messageTokens) &&
        (!Array.isArray(raw.messages) || !raw.messages.length)
      ) throw new HttpError(400, "invalid_request");
      if (embeddings) {
        const tokenList = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.every(token => Number.isSafeInteger(token) && token >= 0);
        const validInput = typeof raw.input === "string" ? raw.input.length > 0 : tokenList(raw.input) || Array.isArray(raw.input) && raw.input.length > 0 && (raw.input.every(value => typeof value === "string" && value.length > 0) || raw.input.every(tokenList));
        if (!validInput || raw.stream === true || raw.encoding_format !== undefined && !["float", "base64"].includes(raw.encoding_format as string) || raw.dimensions !== undefined && (!Number.isSafeInteger(raw.dimensions) || (raw.dimensions as number) <= 0)) throw new HttpError(400, "invalid_request");
      }
      if(geminiTokens){
        const nested=raw.generateContentRequest as Record<string,unknown>|undefined;
        if(raw.stream===true||nested!==undefined&&(!nested||typeof nested!=='object'||Array.isArray(nested))||nested&&raw.contents!==undefined)throw new HttpError(400,'invalid_request');
        const content=nested??raw;
        if((!Array.isArray(content.contents)||!content.contents.length)&&!geminiCacheName(raw))throw new HttpError(400,'invalid_request');
        if(nested?.model!==undefined&&(typeof nested.model!=='string'||nested.model.replace(/^models\//,'')!==gemini![1]))throw new HttpError(400,'invalid_count_model');
      }
      if (gemini && !geminiTokens && (!Array.isArray(raw.contents) || !raw.contents.length)) {
        throw new HttpError(400, "invalid_request");
      }
      if (messageTokens && raw.stream === true) throw new HttpError(400, "invalid_request");
      if(chat||protocol==='responses'&&!inputTokens)normalizeServiceTier(raw);
      body = inputTokens ? inputTokenRequest(raw) : raw;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "invalid_request");
    }
  }
  const policyModel = models ? modelId ? decodeURIComponent(modelId) : "" : gemini ? gemini[1] : body!.model as string;
  const routingModel=images&&policyModel==='grok-imagine'?'grok-imagine-image-quality':policyModel;
  const cacheName=gemini?geminiCacheName(body!):undefined;
  const cacheBinding=cacheName?await resolveGeminiCache(db,keyHash,cacheName,policyModel,clientIp):undefined;
  if(grokSearch)await requireGrokPlatform('grok_search_requires_grok_group');
  Object.assign(errorContext, { keyHash, model: policyModel, ...(models ? { stream: false } : {}) });
  const imageIntent=!models&&!inputTokens&&!messageTokens&&!geminiTokens?{image_generation:imageGenerationIntent(path,policyModel,body),grok_image_generation:imageGenerationIntent(path,policyModel,body,'grok')}:undefined;
  const excluded: string[] = [];
  let pinnedFallback = false;
  // One timeout covers all retries and the stream; the database lease lasts longer.
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(120_000),
  ]);
  for (let attempt = 0; attempt < 3; attempt++) {
    let reservation: Reservation;
    reservation = await db.rpc<Reservation>(db.config.dataModel === "native" ? "s2a_personal_acquire" : "s2a_acquire", {
      p_key_hash: keyHash,
      p_model: models ? "__models__" : routingModel,
      p_request_id: requestId,
      p_excluded: excluded,
      p_count_request: attempt === 0,
      p_client_ip: clientIp,
      p_billing_context: {
        policy_model:policyModel,model_candidates:modelCandidates(routingModel),
        ...(pinnedFallback?{pinned_models_fallback:true}:{}),
        ...(db.config.dataModel==='native'?{inbound_endpoint:path.slice(0,128)}:{}),
        ...(imageIntent&&(imageIntent.image_generation||imageIntent.grok_image_generation)?imageIntent:{}),
        ...(imageJob?{image_task:imageJob.id,image_job_lease:imageJob.lease_id}:{}),
        ...(cacheName?{cached_content:cacheName}:{}),
        ...(inputTokens || messageTokens || geminiTokens ? {count_only:true} : {}),
        ...(search || grokSearch ? {web_search:true,search_operation:grokSearch?grokSearchKind:'alpha_search'} : {}),
        service_tier: typeof body?.service_tier === "string" ? body.service_tier : null,
        stream: models ? false : stream,
        native_stream: search ? false : gemini ? gemini[2] === "streamGenerateContent" : body?.stream === true,
      },
    });
    if (reservation.error) {
      throw new HttpError(reservation.status, reservation.error);
    }
    if('pinned_catalog' in reservation){
      if(requiredPlatform&&requiredPlatform!=='openai')throw new HttpError(400,'provider_route_mismatch');
      if(!models||nativeGeminiModels||pinnedFallback)throw new HttpError(503,'invalid_pinned_model_catalog');
      const result=await pinnedModelCatalog(db,reservation.pinned_catalog,request,signal,modelId?decodeURIComponent(modelId):undefined,clientVersion!==null||codexModels);
      if(result)return result;
      pinnedFallback=true;
      attempt--;
      continue;
    }
    if('anthropic_catalog' in reservation){
      if(!models||nativeGeminiModels)throw new HttpError(503,'invalid_anthropic_catalog');
      if(!modelId&&(codexModels||!!clientVersion))return codexManifestResponse(await completeAnthropicCodexCatalog(reservation.anthropic_catalog,reservation.model_allowlist,reservation.anthropic_capabilities,reservation.anthropic_model_routing),request);
      return json(200,anthropicModelCatalog(reservation.anthropic_catalog,reservation.model_allowlist,modelId?decodeURIComponent(modelId):undefined));
    }
    if('gemini_catalog_only' in reservation){
      if(!nativeGeminiModels)throw new HttpError(503,'invalid_gemini_catalog');
      const catalog=antigravityOnlyCatalog(reservation.gemini_catalog_sources,reservation.model_allowlist,modelId?decodeURIComponent(modelId):undefined);
      if(!catalog)throw new HttpError(503,'no_available_account');
      return catalog;
    }
    if('composite_catalog' in reservation){
      if(!models||nativeGeminiModels)throw new HttpError(503,'composite_manifest_unavailable');
      if(!modelId&&(codexModels||clientVersion!==null)){
        const manifest=await completeCompositeCodexCatalog(reservation.composite_catalog,reservation.model_allowlist);
        return codexManifestResponse(manifest,request);
      }
      return json(200,compositeModelCatalog(reservation.composite_catalog,reservation.model_allowlist,modelId?decodeURIComponent(modelId):undefined));
    }
    const { account, lease_id, model_allowlist, upstream_model, model_sources } = reservation as {
      account: ProviderAccount;
      lease_id: string;
      model_allowlist?:ModelAllowlist;
      upstream_model?:string;
      model_sources?:ModelSources;
    };
    const mappedModel=voice||systemOne?routingModel:upstream_model ?? (model_sources ? mappedTarget(model_sources.mapping,routingModel,account.platform??"openai") : undefined) ?? routingModel;
    const upstreamModel = cacheBinding?.upstream_model ?? ((account.platform ?? "openai") === "openai" ? defaultSolModel(mappedModel) ?? mappedModel : mappedModel);
    let dispatchedModel = upstreamModel;
    let upstreamEndpoint:string|null=null;
    let forwardedBody:Record<string,any>|undefined=body?{...body,...(gemini?{}:{model:upstreamModel})}:undefined;
    if(geminiTokens&&forwardedBody?.generateContentRequest?.model)forwardedBody.generateContentRequest={...forwardedBody.generateContentRequest,model:'models/'+upstreamModel.replace(/^models\//,'')};
    if(cacheBinding)forwardedBody=rewriteGeminiCache(forwardedBody!,cacheBinding);
    if(grokSearch)forwardedBody=grokSearchBody(grokSearchOptions!,upstreamModel);
    const aliasCatalog=!!(models && modelId && model_sources && mappedTarget(model_sources.mapping,decodeURIComponent(modelId),account.platform??"openai"));
    const forwardedPath=aliasCatalog?path.replace(/\/models\/[^/]+$/,"/models"):gemini?`/v1beta/models/${encodeURIComponent(upstreamModel.replace(/^models\//,""))}:${gemini[2]}`:path;
    Object.assign(errorContext, { accountId: account.id, leaseId: lease_id, platform: account.platform ?? "openai", upstreamModel, stream: account.type === "apikey" ? models ? false : gemini ? gemini[2] === "streamGenerateContent" : body?.stream === true : stream });
    const attemptContext = { ...errorContext };
    let responseAccepted = false, providerDispatched = false, upstreamReceived = false, providerFailureRecorded = false;
    const upstreamFailure = async (status: number, code = "upstream_http") => {
      providerFailureRecorded = true;
      await recordOpsError(db, attemptContext, status, code, "upstream", crypto.randomUUID());
    };
    const recordIncomplete = async (status: number, usage: Usage) => {
      if (responseAccepted && usage.outcome !== "completed") {
        const clientCanceled = request.signal.aborted || usage.outcome === "cancelled" && !signal.aborted;
        const code = clientCanceled ? "context_canceled" : signal.aborted ? "upstream_timeout" : "stream_incomplete";
        if (!clientCanceled && !providerFailureRecorded) await upstreamFailure(status, code);
        await recordOpsError(db, attemptContext, status, code);
      }
    };
    let usageWriteFailed = false;
    let finishing: Promise<void> | undefined;
    let quotaSnapshot:Promise<unknown>|undefined;
    const finish = (status: number, usage: Usage, cooldown = 0): Promise<void> => {
      if (finishing) return finishing;
      finishing = (async () => {
        await quotaSnapshot;
        const durationMs=Math.min(2147483647,Math.max(0,Date.now()-errorContext.started));
        for (let retry = 0; retry < 2; retry++) {
          try {
            const saved = await db.rpc<{error?:string;status?:number} | null>(db.config.dataModel === "native" ? "s2a_personal_finish" : "s2a_finish", {
              ...(db.config.dataModel === "native" ? {p_upstream_model:models ? null : dispatchedModel,p_duration_ms:durationMs,p_upstream_endpoint:upstreamEndpoint} : {}),
              p_lease_id: lease_id,
              p_status: status,
              p_outcome: db.config.dataModel === "native" && usage.outcome === "incomplete" ? "interrupted" : usage.outcome,
              p_input_tokens: usage.input,
              p_output_tokens: usage.output,
              p_cache_creation_tokens: usage.cacheCreation,
              p_cache_read_tokens: usage.cacheRead,
              p_cooldown_seconds: cooldown,
              p_credential_version: account.credential_version,
              ...(usage.firstTokenMs === undefined ? {} : { p_first_token_ms: usage.firstTokenMs }),
            });
            if (saved?.error) throw new HttpError(saved.status ?? 503,saved.error);
            await recordIncomplete(status, usage);
            return;
          } catch {
            if (retry === 0) await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        console.error("usage_persistence_failed", requestId);
        if (db.config.dataModel === "native") {
          usageWriteFailed = true;
          throw new HttpError(503,"usage_persistence_failed");
        }
      })();
      return finishing;
    };
    let chatBridge:OriginalChatBridge|undefined;
    try {
      if (requiredPlatform && account.platform !== requiredPlatform) throw new HttpError(400, "provider_route_mismatch");
      if(models&&!nativeGeminiModels&&(pinnedFallback||db.config.dataModel==='native'&&account.platform==='openai'&&account.type==='apikey'&&(codexModels||clientVersion!==null))){
        providerDispatched=true;
        let result:Response|null;
        try{
          result=await pinnedModelCatalog(db,{accounts:[account as PinnedModelCatalog['accounts'][number]],model_allowlist,configured_model_sources:(reservation as {configured_model_sources?:ConfiguredModelSources}).configured_model_sources},request,signal,modelId?decodeURIComponent(modelId):undefined,clientVersion!==null||codexModels,pinnedFallback);
        }catch(error){
          if(error instanceof HttpError&&error.code==='pinned_model_upstream_failed'&&attempt<2){
            await finish(502,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:'failed'});
            excluded.push(account.id);continue;
          }
          throw error;
        }
        if(!result)throw new HttpError(503,'invalid_pinned_model_catalog');
        await finish(200,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:'completed'});
        return result;
      }
      if(db.config.dataModel==='native'&&(reservation as {allow_image_generation?:boolean}).allow_image_generation===false&&!models&&!inputTokens&&!messageTokens&&!geminiTokens&&imageGenerationIntent(path,upstreamModel,body,account.platform))throw new HttpError(403,'image_generation_forbidden');
      if(cacheBinding&&String(account.id)!==cacheBinding.account_id)throw new HttpError(503,'cache_account_unavailable');
      if (search) {
        if(account.type==='service_account')throw new HttpError(501,'provider_protocol_unsupported');
        let result:Awaited<ReturnType<typeof alphaSearch>>;
        try{result=await alphaSearch(db,account,forwardedBody!,request,signal,()=>{providerDispatched=true;},()=>{upstreamReceived=true;});}
        catch(error){
          if(!(error instanceof SearchUpstreamError)||![401,403,404,405,429].includes(error.upstreamStatus)&&error.upstreamStatus<500)throw error;
          const status=error.upstreamStatus;
          await upstreamFailure(status);
          // Tool access failures do not establish that generation credentials are invalid.
          await finish(status,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:"failed"},status===429?60:status>=500||status===403?15:0);
          excluded.push(account.id);
          continue;
        }
        const windows=quotaHeaderWindows(result.headers);
        if(windows && account.type!=="apikey")quotaSnapshot=db.rpc(db.config.dataModel === "native" ? "s2a_personal_windows_save" : "s2a_openai_windows_save",{p_account_id:account.id,p_version:account.credential_version,p_fetched_at:Math.floor(Date.now()/1000),p_windows:windows}).catch(()=>console.warn("quota_window_save_failed"));
        await finish(200,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:"completed"});
        return json(200,result.value);
      }
      if(geminiTokens){
        const counted=await countGeminiTokens(db,account,forwardedPath,forwardedBody!,request,signal,()=>{providerDispatched=true;},()=>{upstreamReceived=true;});
        await finish(200,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:'completed'});
        return json(200,counted);
      }
      if (inputTokens || messageTokens) {
        // Match the original gateway's client-side estimation fallback.
        if(messageTokens&&account.platform==='antigravity'){
          await finish(404,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:'completed'});
          return json(404,{type:'error',error:{type:'not_found_error',message:'count_tokens endpoint is not supported for this platform'}});
        }
        if(account.type==='service_account')throw new HttpError(501,'provider_protocol_unsupported');
        const input_tokens=messageTokens
          ? await countMessageTokens(db,account,forwardedBody!,request,signal,()=>{providerDispatched=true;},()=>{upstreamReceived=true;})
          : await countInputTokens(db,account,forwardedBody!,signal,()=>{providerDispatched=true;},()=>{upstreamReceived=true;});
        await finish(200,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:"completed"});
        return json(200,{...(inputTokens ? {object:"response.input_tokens"} : {}),input_tokens});
      }
      if (embeddings && (account.type !== "apikey" || account.platform !== "openai")) throw new HttpError(501, "provider_protocol_unsupported");
      if (images && !["openai","grok"].includes(account.platform ?? "openai")) throw new HttpError(501, "provider_protocol_unsupported");
      if(grokSearch&&(account.platform??'openai')!=='grok')throw new HttpError(400,'grok_search_requires_grok_group');
      const apiKey = account.type === "apikey";
      const platform = account.platform ?? "openai";
      if(systemOne&&(platform!=='typesafe'||!apiKey)||platform==='typesafe'&&!systemOne&&!models)throw new HttpError(400,'systemone_requires_typesafe_account');
      if(platform==='typesafe'&&models){
        if(clientVersion!==null)throw new HttpError(400,'codex_manifest_requires_oauth');
        if(modelId&&decodeURIComponent(modelId)!=='jev-latest')throw new HttpError(404,'model_not_found');
        const entry={id:'jev-latest',object:'model',created:0,owned_by:'typesafe'};
        return await nativeResponse(Response.json(modelId?entry:{object:'list',data:[entry]}),platform,'models',false,signal,requestId,finish,path,model_allowlist,model_sources);
      }
      if(realtime){
        const {relayGrokRealtime}=await import('./grok_realtime.ts');
        if(platform!=='grok')throw new HttpError(400,'grok_voice_requires_grok_group');
        const outbound=account.type==='apikey'?apiKeyRequest('grok',await decryptApiKeyCredentials(account,db.config.encryptionKey),'voice','/v1/realtime',undefined,request,signal):grokOAuthRequest(await credentialsFor(db,account),'voice','/v1/realtime',undefined,request,signal);
        const target=new URL(outbound.url);target.searchParams.set('model',upstreamModel);
        upstreamEndpoint=usageEndpoint(target.href);
        const transport=await resolveProxy(db,account.proxy_id,db.config.dataModel==='native');
        providerDispatched=true;
        return await relayGrokRealtime(request,target.href,new Headers(outbound.init.headers),transport,signal,finish);
      }

      let native: ReturnType<typeof apiKeyRequest> | undefined;
      let upstream: Response;
      const nativeAnthropicBridge=(platform==='anthropic'||platform==='antigravity')&&!apiKey&&(chat||protocol==='responses');
      const vertexCache={scope:db,identity:JSON.stringify([account.id,account.credential_version,account.proxy_id??null])};
      const nativeGeminiBridge=platform==='gemini'&&(chat||messages||protocol==='responses');
      const geminiBridgePath='/v1beta/models/'+encodeURIComponent(upstreamModel)+':streamGenerateContent';
      let geminiBody=forwardedBody;
      if(nativeGeminiBridge){
        let source;try{source=chat?chatToAPIResponses(forwardedBody!):messages?await originalMessagesToResponses(forwardedBody!):forwardedBody!;}catch{throw new HttpError(400,'invalid_request');}
        chatBridge=await originalGeminiBridge(source,keyHash);geminiBody=chatBridge.body;
      }
      let anthropicBody=forwardedBody;
      if(nativeAnthropicBridge){
        let source;try{source=chat?chatToAPIResponses(forwardedBody!):forwardedBody!;}catch{throw new HttpError(400,'invalid_request');}
        chatBridge=await originalAnthropicBridge(source,keyHash);anthropicBody=chatBridge.body;
      }
      if(account.type==='service_account'&&platform==='anthropic'&&(messages||nativeAnthropicBridge)){
        const credentials=await decryptSecret(account,db.config.encryptionKey);
        const routed=(reservation as {composite_route?:{upstream_model?:string}}).composite_route?.upstream_model??routingModel;
        const explicit=!!model_sources&&mappedTarget(model_sources.mapping,routed,'anthropic')!==undefined;
        providerDispatched=true;
        const outgoing=await vertexAnthropicRequest(credentials,anthropicBody!,request,signal,(url,init)=>accountFetch(db,account,url,init),explicit,vertexCache);
        native=outgoing;dispatchedModel=outgoing.upstreamModel;errorContext.upstreamModel=dispatchedModel;attemptContext.upstreamModel=dispatchedModel;
        upstreamEndpoint=usageEndpoint(outgoing.url);
        upstream=await accountFetch(db,account,outgoing.url,outgoing.init);
      } else if(account.type==='service_account'&&platform==='gemini'){
        const credentials=await decryptSecret(account,db.config.encryptionKey);
        providerDispatched=true;
        if(models){
          native={url:'',init:{},streaming:false};
          upstream=await vertexGeminiCatalog(credentials,forwardedPath,(url,init)=>accountFetch(db,account,url,init),signal);
        } else {
          if(!gemini&&!nativeGeminiBridge)throw new HttpError(501,'provider_protocol_unsupported');
          native=await vertexGeminiRequest(credentials,nativeGeminiBridge?geminiBridgePath:forwardedPath,geminiBody!,signal,(url,init)=>accountFetch(db,account,url,init),vertexCache);
          upstreamEndpoint=usageEndpoint(native.url);
          upstream=await accountFetch(db,account,native.url,native.init);
        }
      } else if (apiKey) {
        let credentials = await decryptApiKeyCredentials(
          account,
          db.config.encryptionKey,
        );
        if (db.config.dataModel === "native") delete (credentials as typeof credentials & {model_mapping?:unknown}).model_mapping;
        credentials=parseAccountCredentials(credentials,platform,'apikey') as ApiKeyCredentials;
        const providerCatalog=models?[]:await providerCatalogProtocols(db,account,credentials,upstreamModel,signal);
        const upstreamProtocol=multiProtocolProvider(platform)?providerProtocol(platform,credentials,messages?'anthropic':protocol==='responses'?'responses':'chat_completions',upstreamModel,providerCatalog):platform==='anthropic'?'anthropic':undefined;
        const bridgeResponses = platform === "openai" && messages || (chat || messages) && upstreamProtocol==='responses';
        const bridgeChat=(messages||protocol==='responses')&&upstreamProtocol==='chat_completions';
        const bridgeAnthropic=(chat||protocol==='responses')&&upstreamProtocol==='anthropic';
        let outgoingBody = nativeGeminiBridge?geminiBody:platform === "grok" && imageMultipart ? await grokImageForm(imageMultipart,forwardedBody!) : forwardedBody;
        if (bridgeResponses) {
          try { outgoingBody = chat ? chatToAPIResponses(forwardedBody!) : await originalMessagesToResponses(forwardedBody!); }
          catch { throw new HttpError(400, "invalid_request"); }
        }
        if(bridgeChat){
          let source;try{source=messages?await originalMessagesToResponses(forwardedBody!):forwardedBody!;}catch{throw new HttpError(400,'invalid_request');}
          chatBridge=await originalChatBridge(source,keyHash);outgoingBody=chatBridge.body;
        }
        if(bridgeAnthropic){
          let source;try{source=chat?chatToAPIResponses(forwardedBody!):forwardedBody!;}catch{throw new HttpError(400,'invalid_request');}
          chatBridge=await originalAnthropicBridge(source,keyHash);outgoingBody=chatBridge.body;
        }
        if(nativeGeminiBridge)outgoingBody=await originalGeminiRestBody(outgoingBody!);
        native = apiKeyRequest(
          platform,
          credentials,
          nativeGeminiBridge?'gemini':bridgeAnthropic?'messages':bridgeChat?'chat':bridgeResponses ? "responses" : protocol,
          nativeGeminiBridge?geminiBridgePath:bridgeAnthropic?'/v1/messages':bridgeChat?'/v1/chat/completions':bridgeResponses ? "/v1/responses" : forwardedPath,
          outgoingBody,
          request,
          signal,
          providerCatalog,
        );
        if(bridgeChat&&platform==='opencode_go'){
          const session=openCodeSession(request,forwardedBody,credentials.account_mode!=='zen');
          if(session){const headers=new Headers(native.init.headers);headers.set('x-opencode-session',session);native.init.headers=headers;}
        }
        if(voice){
          const headers=new Headers(native.init.headers);headers.set('accept','application/json, audio/*');
          if(voiceBytes){headers.set('content-type',request.headers.get('content-type')??'application/octet-stream');native.init.body=voiceBytes as BodyInit;}
          else native.init.body=JSON.stringify(voiceBody);
          if(customVoiceMethod){native.init.method=request.method;if(['GET','DELETE'].includes(request.method))delete native.init.body;const target=new URL(native.url);target.search=new URL(request.url).search;native.url=target.href;}
          native.init.headers=headers;
        }
        if(imageMultipart && platform === "openai"){
          imageMultipart.set("model",upstreamModel);
          const headers=new Headers(native.init.headers);headers.delete("content-type");
          native={...native,init:{...native.init,headers,body:imageMultipart}};
        }
        providerDispatched = true;
        upstreamEndpoint=usageEndpoint(native.url);
        upstream = await accountFetch(db, account, native.url, native.init);
        // Reuse the Responses-to-Messages stream and usage pipeline below.
        if (bridgeResponses||bridgeChat||bridgeAnthropic) native = undefined;
      } else if (platform === "anthropic" || platform === "gemini" || platform === "antigravity" || platform === "grok") {
        let credentials = await credentialsFor(db, account);
        const forward = async () => {
          if (platform === 'antigravity') {
            const outgoing = antigravityOAuthRequest(credentials, nativeAnthropicBridge?'messages':protocol, nativeAnthropicBridge?'/v1/messages':forwardedPath, nativeAnthropicBridge?anthropicBody:forwardedBody, request, signal, protocol === 'messages'||nativeAnthropicBridge ? body?.model as string : undefined);
            if (outgoing.upstreamModel) {
              dispatchedModel = outgoing.upstreamModel;
              errorContext.upstreamModel = dispatchedModel;
              attemptContext.upstreamModel = dispatchedModel;
            }
            native = outgoing;
            upstreamEndpoint=usageEndpoint(outgoing.url);
            return await forwardAntigravity(db, account, outgoing, forwardedPath, request);
          }
          const googleBody=nativeGeminiBridge&&(!(credentials as {project_id?:string}).project_id||(credentials as {oauth_type?:string}).oauth_type==='ai_studio')?await originalGeminiRestBody(geminiBody!):geminiBody;
          const outgoing = platform === "grok"
            ? grokOAuthRequest(credentials, protocol, forwardedPath, imageMultipart ? await grokImageForm(imageMultipart,forwardedBody!) : forwardedBody, request, signal)
            : platform === "gemini"
            ? googleOAuthRequest(credentials, nativeGeminiBridge?'gemini':protocol, nativeGeminiBridge?geminiBridgePath:forwardedPath, googleBody, request, signal)
            : anthropicOAuthRequest(credentials, nativeAnthropicBridge?'messages':protocol, nativeAnthropicBridge?'/v1/messages':forwardedPath, anthropicBody, request, signal);
          native = outgoing;
            upstreamEndpoint=usageEndpoint(outgoing.url);
          if(voice){
            const headers=new Headers(outgoing.init.headers);headers.set('accept','application/json, audio/*');
            if(voiceBytes){headers.set('content-type',request.headers.get('content-type')??'application/octet-stream');outgoing.init.body=voiceBytes as BodyInit;}
            else outgoing.init.body=JSON.stringify(voiceBody);
          if(customVoiceMethod){outgoing.init.method=request.method;if(['GET','DELETE'].includes(request.method))delete outgoing.init.body;const target=new URL(outgoing.url);target.search=new URL(request.url).search;outgoing.url=target.href;}
            outgoing.init.headers=headers;
          }
          if (platform === "gemini" && models) {
            const catalog = googleOAuthCatalog(credentials, forwardedPath, request);
            if (catalog) return catalog;
          }
          const response = await accountFetch(db, account, outgoing.url, outgoing.init);
          return "codeAssist" in outgoing && outgoing.codeAssist ? normalizeCodeAssist(response, outgoing.streaming) : response;
        };
        providerDispatched = true;
        upstream = await forward();
        if (upstream.status === 401) {
          await upstreamFailure(401);
          await upstream.body?.cancel();
          credentials = await credentialsFor(db, account, credentials.access_token);
          providerFailureRecorded = false;
          upstream = await forward();
        }
      } else if(images) {
        let credentials=await credentialsFor(db,account);
        const identity=await currentCodexIdentity(db,account,credentials);
        const forward=async()=>{
          native=await oauthImageRequest(credentials,identity,forwardedPath,forwardedBody!,imageMultipart,signal);
          upstreamEndpoint=usageEndpoint(native.url);
          return accountFetch(db,account,native.url,native.init);
        };
        providerDispatched=true;
        upstream=await forward();
        if(upstream.status===401){
          await upstreamFailure(401);await upstream.body?.cancel();
          credentials=await credentialsFor(db,account,credentials.access_token);providerFailureRecorded=false;
          upstream=await forward();
        }
      } else {
        if (platform !== "openai" || gemini || nativeGeminiModels) {
          throw new HttpError(501, "provider_protocol_unsupported");
        }
        let normalized: Record<string, unknown> | undefined;
        if (body) {
          try {
            validateCodexReasoning(forwardedBody!);
            normalized = normalizeBody(
              chat
                ? chatToResponses(forwardedBody!)
                : messages
                ? await originalMessagesToResponses(forwardedBody!)
                : forwardedBody,
            );
          } catch (error) {
            throw new HttpError(
              400,
              error instanceof Error && error.message.startsWith("Unsupported")
                ? "unsupported_request_feature"
                : "invalid_request",
            );
          }
        }
        let credentials = await credentialsFor(db, account);
        const identity = await currentCodexIdentity(db, account, credentials);
        const forward = () => {
          const headers = buildHeaders(credentials, identity);
          if (models) headers.set("accept", "application/json");
          upstreamEndpoint=usageEndpoint(models?CODEX_MODELS_URL:CODEX_RESPONSES_URL);
          return accountFetch(db, account,
            models
              ? `${CODEX_MODELS_URL}?client_version=${
                encodeURIComponent(clientVersion ?? identity.version)
              }`
              : CODEX_RESPONSES_URL,
            {
              method: models ? "GET" : "POST",
              headers,
              signal,
              ...(normalized ? { body: JSON.stringify(normalized) } : {}),
            },
          );
        };
        providerDispatched = true;
        upstream = await forward();
        if (upstream.status === 401) {
          await upstreamFailure(401);
          await upstream.body?.cancel();
          credentials = await credentialsFor(
            db,
            account,
            credentials.access_token,
          );
          providerFailureRecorded = false;
          upstream = await forward();
        }
      }
      if (nativeGeminiModels && platform === 'gemini') {
        upstream = await fallbackGeminiCatalog(upstream, forwardedPath);
        if(!modelId&&upstream.status===200&&'gemini_catalog_sources' in reservation&&reservation.gemini_catalog_sources){
          const extra=antigravityGeminiModels(reservation.gemini_catalog_sources);
          if(extra.length){
            const body=await upstream.text(),merged=mergeGeminiCatalog(body,extra),headers=new Headers(upstream.headers);
            headers.delete('content-length');headers.delete('content-encoding');headers.delete('etag');
            upstream=new Response(merged,{status:200,headers});
          }
        }
      }
      upstreamReceived = true;
      if(!apiKey && platform==='openai'){
        const windows=quotaHeaderWindows(upstream.headers);
        if(windows)quotaSnapshot=db.rpc(db.config.dataModel === 'native' ? 's2a_personal_windows_save' : 's2a_openai_windows_save',{p_account_id:account.id,p_version:account.credential_version,p_fetched_at:Math.floor(Date.now()/1000),p_windows:windows}).catch(()=>console.warn('quota_window_save_failed'));
      }
      if (!upstream.ok) {
        if(upstream.status===401&&account.type==='service_account')invalidateVertexTokenContext(vertexCache);
        chatBridge?.close();
        const status = upstream.status;
        const rejection = await upstreamErrorCode(upstream);
        await upstreamFailure(status, rejection === "upstream_rejected_request" ? "upstream_http" : rejection);
        await upstream.body?.cancel();
        await finish(
          status,
          { input: null, output: null, cacheCreation: null, cacheRead: null, outcome: "failed" },
          status === 429
            ? 60
            : status >= 500 || status === 401 || status === 403
            ? 15
            : 0,
        );
        if (!imageJob && !customVoiceMethod && ([401, 403, 429].includes(status) || status >= 500)) {
          excluded.push(account.id);
          continue;
        }
        // Provider errors can contain account details; return a stable error only.
        throw new HttpError(
          status >= 400 && status < 500 ? status : 502,
          rejection,
        );
      }
      if(chatBridge){upstream=chatBridge.response(upstream);native=undefined;}
      responseAccepted = native ? native.streaming : stream;
      if (native) {
        if(voice){if(upstream.status===204){await finish(204,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:'completed'});return new Response(null,{status:204,headers:{'cache-control':'no-store'}});}return voiceResponse(upstream,signal,finish);}
        if(grokSearch){
          const value=await upstream.json();
          if(value?.status&&value.status!=='completed')throw new HttpError(502,'search_upstream_failed');
          upstream=Response.json(value,{status:upstream.status});
        }
        if(images&&platform==="openai"&&!apiKey&&!directModels.has(String(forwardedBody?.model)))upstream=await imageResponses(upstream,native.streaming);
        return await nativeResponse(
          upstream,
          platform,
          protocol,
          native!.streaming,
          signal,
          requestId,
          finish,
          forwardedPath,
          model_allowlist,
          model_sources,
          aliasCatalog?decodeURIComponent(modelId!):undefined,
          errorContext.started,
          grokSearch ? (value)=>grokSearchOutput(value,grokSearchOptions!) : images && platform === "openai" && !apiKey ? (value,streaming)=>oauthImageOutput(value,body!,imageEdit,streaming) : undefined,
        );
      }
      if (models) {
        const rawManifest = await upstream.json();
        const manifest = configuredCodexCatalog(mappedCatalog(rawManifest,model_sources,"openai"),(reservation as {configured_model_sources?:ConfiguredModelSources}).configured_model_sources,model_allowlist);
        const catalog = clientVersion !== null || codexModels
          ? { data: [] }
          : filterModelCatalog(model_allowlist,mappedCatalog(modelListFromManifest(rawManifest),model_sources,"openai"));
        const model = modelId
          ? catalog.data.find((entry: {id:string}) =>
            entry.id === decodeURIComponent(modelId)
          )
          : undefined;
        if (modelId && !model) throw new HttpError(404, "model_not_found");
        // Codex clients need the full model metadata, including model instructions.
        const result = model ? json(200, model) : await codexManifestResponse(
          clientVersion !== null || codexModels ? { models: manifest.models } : catalog,
          request,
        );
        // Discovery succeeded upstream even when the client's cached body is current.
        await finish(200, { input: null, output: null, cacheCreation: null, cacheRead: null, outcome: "completed" });
        return result;
      }
      // Codex can omit Content-Type on a successful SSE response.
      const contentType = upstream.headers.get("content-type");
      if (
        !upstream.body ||
        (contentType && !contentType.includes("text/event-stream"))
      ) {
        await upstream.body?.cancel();
        throw new HttpError(502, "invalid_upstream_stream");
      }
      const tracked = trackedStream(
        upstream.body,
        signal,
        (usage) => finish(upstream.status, usage),
        new UsageObserver(errorContext.started),
      );
      if (!stream) {
        const completed = await completedResponse(tracked);
        return json(
          200,
          chat
            ? responseToChat(completed, `chatcmpl-${requestId}`)
            : messages
            ? responseToMessages(completed, `msg_${requestId}`)
            : completed,
        );
      }
      // Forward only protocol headers; provider cookies and request metadata stay private.
      return new Response(
        chat
          ? streamChat(
            tracked,
            `chatcmpl-${requestId}`,
            body!.model as string,
            includeUsage,
          )
          : messages
          ? streamMessages(tracked, `msg_${requestId}`, body!.model as string)
          : tracked,
        {
          status: upstream.status,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            "x-request-id": requestId,
            "x-content-type-options": "nosniff",
          },
        },
      );
    } catch (error) {
      chatBridge?.close();
      if (providerDispatched && !usageWriteFailed && !providerFailureRecorded && !request.signal.aborted) {
        await upstreamFailure(signal.aborted ? 504 : error instanceof HttpError ? error.status : 502, signal.aborted ? "upstream_timeout" : upstreamReceived ? "invalid_upstream_response" : "upstream_unavailable");
      }
      await finish(
        signal.aborted ? 499 : error instanceof HttpError ? error.status : 502,
        {
          input: null,
          output: null,
          cacheCreation: null,
          cacheRead: null,
          outcome: signal.aborted ? "cancelled" : "failed",
        },
      );
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        signal.aborted ? 504 : 502,
        signal.aborted ? "upstream_timeout" : "upstream_unavailable",
      );
    }
  }
  throw new HttpError(503, "no_available_account");
}
