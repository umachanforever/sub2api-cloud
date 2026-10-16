import templates from './codex_catalog_templates.json' with {type:'json'};
// Templates are exported by the original Go builder. Clone before restoring the
// shared instruction text so per-request aliases cannot mutate later responses.
export function codexCatalogModelAllowed(model:string):boolean{
 const canonical=model.trim().toLowerCase().split('/').at(-1)!;
 const grok=model.trim().toLowerCase().replace(/^(?:xai|x-ai|grok)\//,'');
 return !(templates.omitted_models.includes(model)||canonical.startsWith('gpt-image-')||/^(?:gemini-3\.1-flash-image|gemini-3-pro-image|gemini-2\.5-flash-image)(?:$|-)/.test(canonical)||grok.startsWith('imagine')||/^(?:grok-imagine(?:$|-1$|-edit$|-image|-video)|grok-video-1\.5$)/.test(grok));
}
export function codexCatalogDescriptor(model:string):Record<string,any>|undefined{
 const canonical=model.trim().toLowerCase().split('/').at(-1)!;
 if(!codexCatalogModelAllowed(model))return;
 const source=templates.models.find(entry=>entry.slug===model)??templates.models.find(entry=>entry.slug===canonical)??templates.models.find(entry=>entry.slug==='custom-model');
 if(!source)throw Error('Missing original Codex fallback descriptor');
 const descriptor:Record<string,any>=structuredClone(source);
 const index=descriptor.model_messages?.instructions_template_ref;
 if(!Number.isInteger(index)||typeof templates.instructions[index]!=='string')throw Error('Invalid original Codex instruction reference');
 descriptor.model_messages.instructions_template=templates.instructions[index];
 delete descriptor.model_messages.instructions_template_ref;
 if(descriptor.slug!==model){descriptor.slug=model;descriptor.display_name=model;}
 return descriptor;
}
