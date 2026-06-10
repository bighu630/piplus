import { Window } from 'happy-dom';

const win = new Window({
  url: 'http://localhost:3000',
  settings: {
    disableJavaScriptFileLoading: true,
    disableJavaScriptEvaluation: true,
    disableCSSFileLoading: true,
  },
});

// Patch happy-dom Window with missing Error constructors
const errorCtors = ['SyntaxError', 'TypeError', 'RangeError', 'URIError', 'EvalError', 'ReferenceError'] as const;
for (const name of errorCtors) {
  (win as any)[name] = (globalThis as any)[name];
}

// Set globals for @testing-library/react
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).HTMLInputElement = win.HTMLInputElement;
(globalThis as any).HTMLButtonElement = win.HTMLButtonElement;
(globalThis as any).HTMLTextAreaElement = win.HTMLTextAreaElement;
(globalThis as any).HTMLDivElement = win.HTMLDivElement;
(globalThis as any).HTMLSpanElement = win.HTMLSpanElement;
(globalThis as any).Node = win.Node;
(globalThis as any).Element = win.Element;
(globalThis as any).Event = win.Event;
(globalThis as any).CustomEvent = win.CustomEvent;
(globalThis as any).MouseEvent = win.MouseEvent;
(globalThis as any).KeyboardEvent = win.KeyboardEvent;
(globalThis as any).FocusEvent = win.FocusEvent;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle?.bind(win) ?? (() => ({} as CSSStyleDeclaration));
(globalThis as any).navigator = win.navigator;
(globalThis as any).requestAnimationFrame = (fn: FrameRequestCallback) => setTimeout(fn, 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
