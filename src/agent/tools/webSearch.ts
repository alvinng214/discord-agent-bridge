export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, maxResults?: number): Promise<WebSearchResult[]>;
}

export function createWebSearchProviders(opts: {
  braveApiKey?: string | null;
  tavilyApiKey?: string | null;
}): WebSearchProvider[] {
  const providers: WebSearchProvider[] = [];
  if (opts.braveApiKey) {
    providers.push(new BraveSearchProvider(opts.braveApiKey));
  }
  if (opts.tavilyApiKey) {
    providers.push(new TavilySearchProvider(opts.tavilyApiKey));
  }
  return providers;
}

class BraveSearchProvider implements WebSearchProvider {
  readonly name = "brave";

  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults = 5): Promise<WebSearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
    });
    if (!res.ok) {
      throw new Error(`Brave search failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  }
}

class TavilySearchProvider implements WebSearchProvider {
  readonly name = "tavily";

  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults = 5): Promise<WebSearchResult[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: maxResults,
        include_answer: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Tavily search failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
  }
}

/** OpenAI-compatible tool definitions for web search (only when a provider exists). */
export function webSearchToolDefinitions(providers: WebSearchProvider[]): unknown[] {
  if (providers.length === 0) return [];
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the public web for current information (patch notes, official docs, guides). Prefer official sources.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            max_results: {
              type: "integer",
              description: "Max results (1-8)",
              minimum: 1,
              maximum: 8,
            },
          },
          required: ["query"],
        },
      },
    },
  ];
}

export async function runWebSearchTool(
  providers: WebSearchProvider[],
  argsJson: string,
): Promise<string> {
  if (providers.length === 0) {
    return JSON.stringify({ error: "web search is not configured" });
  }
  let query = "";
  let maxResults = 5;
  try {
    const parsed = JSON.parse(argsJson) as { query?: string; max_results?: number };
    query = (parsed.query ?? "").trim();
    if (typeof parsed.max_results === "number" && Number.isFinite(parsed.max_results)) {
      maxResults = Math.min(8, Math.max(1, Math.floor(parsed.max_results)));
    }
  } catch {
    return JSON.stringify({ error: "invalid tool arguments" });
  }
  if (!query) return JSON.stringify({ error: "query is required" });

  const provider = providers[0]!;
  try {
    const results = await provider.search(query, maxResults);
    return JSON.stringify({ provider: provider.name, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: message });
  }
}
