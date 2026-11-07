import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// A name that is used but never imported or declared throws "X is not defined" the moment its screen renders and white-screens it
// (a missing `import { t } from '../i18n'`, a `export { X } from` re-export that makes no local binding, a variable that was never read
// from the session). app-jsx-names only looks at JSX tags, so this checks every identifier with a real scope analysis.
const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const root = new URL('../../app/src/', import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });

// browser / JS-runtime globals the app is allowed to use without declaring them
const GLOBALS = new Set(`window document navigator location localStorage sessionStorage fetch console setTimeout clearTimeout setInterval clearInterval
requestAnimationFrame cancelAnimationFrame Promise Math JSON Date Array Object String Number Boolean Symbol Map Set WeakMap WeakSet Error TypeError RangeError
RegExp Intl URL URLSearchParams FormData Blob File FileReader Image Event CustomEvent AbortController TextEncoder TextDecoder crypto atob btoa
encodeURIComponent decodeURIComponent encodeURI decodeURI parseInt parseFloat isNaN isFinite undefined NaN Infinity globalThis process require module exports
__DEV__ Uint8Array Uint16Array Uint32Array Float32Array Float64Array ArrayBuffer DataView BigInt Proxy Reflect queueMicrotask structuredClone performance
alert confirm prompt HTMLElement Node MutationObserver IntersectionObserver ResizeObserver Audio Notification indexedDB screen history XMLHttpRequest
WebSocket EventSource Headers Request Response arguments OffscreenCanvas createImageBitmap getComputedStyle matchMedia requestIdleCallback AudioContext
webkitAudioContext MediaRecorder BroadcastChannel SpeechSynthesisUtterance speechSynthesis Worker self postMessage ImageData Path2D DOMParser Element
Int8Array Int16Array Int32Array Uint8ClampedArray BigInt64Array BigUint64Array WeakRef AggregateError EvalError ReferenceError SyntaxError URIError
Option HTMLCanvasElement Storage DOMException ClipboardItem KeyboardEvent MouseEvent TouchEvent PointerEvent FocusEvent InputEvent DragEvent
MessageEvent PerformanceObserver Selection Range DocumentFragment Text Comment`.split(/\s+/));

test('every name used in the app is imported or declared in its file', () => {
  const problems = [];
  for (const file of walk(root)) {
    const ast = babel.parseSync(readFileSync(file, 'utf8'), { filename: file, babelrc: false, configFile: false, sourceType: 'module', parserOpts: { plugins: ['jsx'] } });
    const seen = new Set();
    babel.traverse(ast, {
      ReferencedIdentifier(p) {
        const n = p.node.name;
        if (p.scope.hasBinding(n) || GLOBALS.has(n) || seen.has(n)) return;
        seen.add(n);
        problems.push(`${file.replace(root, '')}:${p.node.loc.start.line}: ${n}`);
      },
    });
  }
  assert.deepEqual(problems, [], `used but never imported or declared (it throws "is not defined" when that screen renders):\n${problems.join('\n')}`);
});
