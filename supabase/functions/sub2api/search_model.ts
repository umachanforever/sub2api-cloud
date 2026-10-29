// Enable provider-hosted web search without requiring client tool execution.
export function enableNativeSearch(body: Record<string, any>): void {
  if (!(body.tools ?? []).some((tool: any) => ['web_search', 'web_search_preview'].includes(tool.type))) {
    body.tools = [...(body.tools ?? []), {type: 'web_search'}];
  }
  body.instructions = [body.instructions, 'Use web search for current news, time-sensitive information, or explicit requests to search. Cite retrieved sources using Markdown links with their actual URLs, and distinguish publication dates from event dates. Do not claim to have searched unless you used the search tool.'].filter(Boolean).join('\n\n');
}
