/**
 * Test double for the Workers HTMLRewriter (not available in Node): parses the HTML with jsdom,
 * walks elements in document order calling every matching handler — like lol-html, content a
 * handler inserts is not itself matched — then serializes. Supports exactly the Element methods
 * brand.ts uses. Test-only: excluded from the Worker's tsconfig and never bundled.
 */
import { JSDOM } from 'jsdom';
import type { Rewriter, RewriterElement } from '../brand';

type Handler = { element(element: RewriterElement): void };

const escText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class FakeHtmlRewriter implements Rewriter {
  private readonly handlers: Array<[string, Handler]> = [];

  on(selector: string, handler: Handler): Rewriter {
    this.handlers.push([selector, handler]);
    return this;
  }

  rewrite(html: string): string {
    const dom = new JSDOM(html);
    const visit = (el: Element): void => {
      const children = Array.from(el.children); // snapshot: inserted content is not re-matched
      let removed = false;
      for (const [selector, handler] of this.handlers) {
        if (removed || !el.matches(selector)) continue;
        handler.element({
          tagName: el.tagName.toLowerCase(),
          getAttribute: (name) => el.getAttribute(name),
          setAttribute: (name, value) => el.setAttribute(name, value),
          setInnerContent: (content, options) => {
            if (options?.html) el.innerHTML = content;
            else el.textContent = content;
          },
          append: (content, options) => el.insertAdjacentHTML('beforeend', options?.html ? content : escText(content)),
          remove: () => {
            removed = true;
            el.remove();
          }
        });
      }
      if (!removed) children.forEach(visit);
    };
    visit(dom.window.document.documentElement);
    return dom.serialize();
  }

  transform(response: Response): Response {
    const rewrite = (html: string) => this.rewrite(html);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(rewrite(await response.text())));
        controller.close();
      }
    });
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
}
