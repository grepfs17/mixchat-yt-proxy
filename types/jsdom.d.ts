declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string, options?: { url?: string; referrer?: string; userAgent?: string });
    window: Window & { document: Document; location: Location; navigator: Navigator };
  }
}