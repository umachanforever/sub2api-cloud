import {responseEvents} from './openai_protocol.ts';

// Enable provider-hosted web search without requiring client tool execution.
export function enableNativeSearch(body: Record<string, any>): void {
  // Some chat clients disable absent client tools explicitly. Hosted tools are
  // server-owned; restore automatic choice only when no caller tools exist.
  if (body.tool_choice === 'none' && (!Array.isArray(body.tools) || body.tools.length === 0)) body.tool_choice = 'auto';
  if (!(body.tools ?? []).some((tool: any) => ['web_search', 'web_search_preview'].includes(tool.type))) {
    body.tools = [...(body.tools ?? []), {type: 'web_search'}];
  }
  body.instructions = [body.instructions, 'Use web search for current news, time-sensitive information, or explicit requests to search. Cite retrieved sources using Markdown links with their actual URLs, and distinguish publication dates from event dates. Do not claim to have searched unless you used the search tool.'].filter(Boolean).join('\n\n');
}

// Some SDKs validate provider-executed tools against the client's tool registry.
// Implicit gateway search has no such client entry: expose its answer and sources,
// but keep its internal tool lifecycle out of the client's execution queue.
export function implicitSearchResponse(upstream: Response, client: Record<string, any>, maxFrame = 1_048_576): Response {
  if ((client.tools ?? []).some((tool: any) => ['web_search', 'web_search_preview'].includes(tool?.type))) return upstream;
  if (!upstream.body) return upstream;
  const reader = upstream.body.getReader(), events = responseEvents(reader, maxFrame), encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!cancelled) {
          const next = await events.next();
          if (cancelled) return;
          if (next.done) { controller.close(); return; }
          const event = next.value;
          if (event.type.startsWith('response.web_search_call.') || event.item?.type === 'web_search_call') continue;
          if (event.response) {
            if (Array.isArray(event.response.output)) event.response.output = event.response.output.filter((item: any) => item?.type !== 'web_search_call');
            if (Array.isArray(event.response.tools)) event.response.tools = event.response.tools.filter((tool: any) => !['web_search', 'web_search_preview'].includes(tool?.type));
          }
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          return;
        }
      } catch (error) {
        await events.return(undefined).catch(() => {});
        if (!cancelled) controller.error(error);
      }
    },
    async cancel() {
      cancelled = true;
      await reader.cancel().catch(() => {});
      await events.return(undefined);
    },
  });
  const headers = new Headers(upstream.headers);
  for (const name of ['content-length', 'content-encoding', 'etag']) headers.delete(name);
  return new Response(body, { status: upstream.status, headers });
}
