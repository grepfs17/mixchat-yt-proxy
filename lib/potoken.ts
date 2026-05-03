import { BG } from 'bgutils-js';
import { JSDOM } from 'jsdom';
import { Innertube } from 'youtubei.js';

interface PoTokenData {
  visitorData: string;
  poToken: string;
  generatedAt: number;
  ttlMs: number;
}

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

let cachedToken: PoTokenData | null = null;
let generationPromise: Promise<PoTokenData> | null = null;

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEBUG = process.env.YT_DEBUG === '1';

let domInitialized = false;

function ensureDomSetup(): void {
  if (domInitialized) return;

  const userAgent =
    process.env.YT_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent,
  });

  const win = dom.window as any;
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    location: win.location,
    origin: win.origin,
  });

  if (!Reflect.has(globalThis, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', { value: win.navigator });
  }

  domInitialized = true;
}

async function generatePotokenInner(): Promise<PoTokenData> {
  const userAgent =
    process.env.YT_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const tempInnertube = await Innertube.create({
    retrieve_player: false,
    user_agent: userAgent,
    generate_session_locally: true,
  });

  const visitorData = tempInnertube.session.context.client.visitorData;
  if (!visitorData) {
    throw new Error('[PoToken] Could not obtain visitor_data from Innertube session');
  }

  ensureDomSetup();

  const bgConfig = {
    fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
    globalObj: globalThis,
    identifier: visitorData,
    requestKey: REQUEST_KEY,
  };

  if (DEBUG) console.debug('[PoToken] Fetching BotGuard challenge…');
  const bgChallenge = await BG.Challenge.create(bgConfig as any);
  if (!bgChallenge) {
    throw new Error('[PoToken] Could not obtain BotGuard challenge');
  }

  const interpreterJavascript =
    bgChallenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;

  if (interpreterJavascript) {
    new Function(interpreterJavascript)();
  } else {
    throw new Error('[PoToken] Could not load BotGuard VM (no interpreter script)');
  }

  if (DEBUG) console.debug('[PoToken] Running PoToken.generate…');
  const poTokenResult = await BG.PoToken.generate({
    program: bgChallenge.program,
    globalName: bgChallenge.globalName,
    bgConfig: bgConfig as any,
  });

  const poToken = poTokenResult.poToken;
  if (!poToken) {
    throw new Error('[PoToken] PoToken generation returned empty result');
  }

  if (DEBUG) {
    console.debug('[PoToken] Generated PoToken successfully', {
      visitorData: visitorData.slice(0, 20) + '…',
      poToken: poToken.slice(0, 20) + '…',
      hasIntegrityTokenData: !!poTokenResult.integrityTokenData,
    });
  }

  const ttlMs =
    poTokenResult.integrityTokenData?.estimatedTtlSecs != null
      ? Math.max(poTokenResult.integrityTokenData.estimatedTtlSecs * 1000 * 0.8, 60_000)
      : DEFAULT_TTL_MS;

  return {
    visitorData,
    poToken,
    generatedAt: Date.now(),
    ttlMs,
  };
}

export async function getPoToken(): Promise<PoTokenData> {
  if (cachedToken && Date.now() < cachedToken.generatedAt + cachedToken.ttlMs) {
    return cachedToken;
  }

  if (generationPromise) {
    return generationPromise;
  }

  generationPromise = (async () => {
    try {
      const data = await generatePotokenInner();
      cachedToken = data;
      return data;
    } catch (err) {
      console.error('[PoToken] Generation failed:', err);
      cachedToken = null;
      throw err;
    } finally {
      generationPromise = null;
    }
  })();

  return generationPromise;
}

export function invalidatePoToken(): void {
  cachedToken = null;
  generationPromise = null;
  domInitialized = false;
}

export function hasValidPoToken(): boolean {
  return cachedToken != null && Date.now() < cachedToken.generatedAt + cachedToken.ttlMs;
}