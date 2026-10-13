// Stand-in for https://deno.land/std@<version>/http/server.ts, which older
// Supabase examples import. Its serve() relied on APIs removed in Deno 2.
export type ConnInfo = { readonly localAddr: Deno.Addr; readonly remoteAddr: Deno.Addr };
export type Handler = (request: Request, connInfo: ConnInfo) => Response | Promise<Response>;
export type ServeInit = { port?: number; hostname?: string; signal?: AbortSignal; onListen?: (params: { hostname: string; port: number }) => void; onError?: (error: unknown) => Response | Promise<Response> };

export function serve(handler: Handler, options: ServeInit = {}): Promise<void> {
  // deno-lint-ignore no-explicit-any
  return (Deno.serve as any)(options, handler).finished;
}
