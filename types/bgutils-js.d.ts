declare module 'bgutils-js' {
  export interface BgConfig {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    globalObj?: object;
    identifier?: string;
    requestKey?: string;
  }

  export interface ChallengeResult {
    program: string;
    globalName: string;
    interpreterJavascript?: {
      privateDoNotAccessOrElseSafeScriptWrappedValue?: string;
    };
  }

  export interface PoTokenResult {
    poToken: string;
    integrityTokenData?: {
      estimatedTtlSecs?: number;
      mintRefreshThreshold?: number;
    };
  }

  export namespace BG {
    class BotGuardClient {
      static create(options: { program: string; globalName: string; globalObj: object }): Promise<BotGuardClient>;
      snapshot(options: { webPoSignalOutput: any[] }): Promise<string>;
    }

    namespace Challenge {
      function create(bgConfig: BgConfig): Promise<ChallengeResult | null>;
      function parseChallengeData(data: unknown): ChallengeResult | null;
    }

    namespace PoToken {
      function generate(options: { program: string; globalName: string; bgConfig: BgConfig }): Promise<PoTokenResult>;
      function generatePlaceholder(visitorData: string): string;
    }
  }

  export const GOOG_API_KEY: string;
  export function buildURL(endpoint: string, useProtobuf?: boolean): string;
  export const USER_AGENT: string;
}