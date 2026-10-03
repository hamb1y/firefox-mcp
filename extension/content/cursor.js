/* WebMCP Controller — the "AI cursor": shows the user where the model is
 * acting and what it says it's doing. Purely visual: pointer-events are off,
 * so it never intercepts real input.
 *
 * Styling goes through element.style and the Web Animations API (CSSOM),
 * which page CSP doesn't block, inside a closed shadow root so page CSS
 * can't reach it. Loaded before ax.js; ax.js drives it via window.__fxmcpCursor.
 */
(function () {
'use strict';

if (window.__fxmcpCursor) return;

var IDLE_DIM_MS = 8000;    // fade to a ghost after this long without activity
var IDLE_HIDE_MS = 30000;  // then disappear
var reduceMotion = false;
try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

var host = null, wrap = null, arrow = null, bubble = null, textEl = null, dotEl = null;
var pos = null;            // current tip position {x, y} in viewport px
var target = null;         // element we're pointing at (followed on scroll)
var gliding = null;        // running Animation
var dimTimer = 0, hideTimer = 0, typeTimer = 0;

function css(el, styles) { for (var k in styles) el.style.setProperty(k, styles[k]); return el; }

function svgEl(tag, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (var k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function build() {
  if (host && host.isConnected) return;
  host = document.createElement('fxmcp-cursor');
  css(host, {
    all: 'initial', position: 'fixed', inset: '0', 'pointer-events': 'none',
    'z-index': '2147483647', overflow: 'hidden', contain: 'strict', display: 'block'
  });
  var root = host.attachShadow({ mode: 'closed' });

  wrap = css(document.createElement('div'), {
    position: 'absolute', left: '0', top: '0', 'will-change': 'transform, opacity',
    transition: 'opacity .35s ease', opacity: '0'
  });

  // Arrow pointer, tip at (2,2): gradient fill, white rim, soft glow.
  arrow = svgEl('svg', { width: '26', height: '30', viewBox: '0 0 26 30' });
  css(arrow, {
    position: 'absolute', left: '-2px', top: '-2px', overflow: 'visible',
    filter: 'drop-shadow(0 0 6px rgba(124,58,237,.65)) drop-shadow(0 2px 3px rgba(0,0,0,.35))',
    'transform-origin': '2px 2px'
  });
  var defs = svgEl('defs', {});
  var grad = svgEl('linearGradient', { id: 'g', x1: '0', y1: '0', x2: '1', y2: '1' });
  grad.appendChild(svgEl('stop', { offset: '0', 'stop-color': '#a855f7' }));
  grad.appendChild(svgEl('stop', { offset: '1', 'stop-color': '#06b6d4' }));
  defs.appendChild(grad);
  arrow.appendChild(defs);
  arrow.appendChild(svgEl('path', {
    d: 'M2 2 L2 24 L8.2 18.4 L12.4 27.6 L16.4 25.8 L12.2 16.8 L20.6 16.4 Z',
    fill: 'url(#g)', stroke: '#fff', 'stroke-width': '1.6', 'stroke-linejoin': 'round'
  }));

  bubble = css(document.createElement('div'), {
    position: 'absolute', left: '20px', top: '26px', display: 'flex', 'align-items': 'flex-start', gap: '7px',
    'max-width': '300px', width: 'max-content', padding: '6px 10px 6px 8px', 'border-radius': '10px',
    background: 'rgba(20,18,32,.88)', color: '#f4f3ff',
    border: '1px solid rgba(168,85,247,.45)',
    'box-shadow': '0 6px 20px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.04) inset',
    'backdrop-filter': 'blur(8px)',
    font: '500 12.5px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
    'letter-spacing': '.1px', 'white-space': 'normal', 'overflow-wrap': 'anywhere',
    transition: 'opacity .25s ease', opacity: '0'
  });
  dotEl = css(document.createElement('span'), {
    flex: 'none', width: '8px', height: '8px', 'margin-top': '5px', 'border-radius': '50%',
    background: 'linear-gradient(135deg,#a855f7,#06b6d4)', 'box-shadow': '0 0 8px rgba(168,85,247,.9)'
  });
  textEl = document.createElement('span');
  bubble.appendChild(dotEl);
  bubble.appendChild(textEl);

  wrap.appendChild(arrow);
  wrap.appendChild(bubble);
  root.appendChild(wrap);
  (document.documentElement || document.body).appendChild(host);

  if (!reduceMotion) {
    try {
      dotEl.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: .45, transform: 'scale(.7)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 1400, iterations: Infinity, easing: 'ease-in-out' });
    } catch (e) {}
  }
}

function place(p) {
  pos = p;
  wrap.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)';
  // Keep the bubble on screen: flip left/up near the right/bottom edges.
  var bw = bubble.offsetWidth || 200, bh = bubble.offsetHeight || 30;
  var vw = window.innerWidth, vh = window.innerHeight;
  bubble.style.left = (p.x + 20 + bw > vw - 8) ? (-bw - 6) + 'px' : '20px';
  bubble.style.top = (p.y + 26 + bh > vh - 8) ? (-bh - 8) + 'px' : '26px';
}

function pointFor(el) {
  var r = el.getBoundingClientRect();
  var x = r.left + Math.min(r.width / 2, Math.max(r.width - 6, 6));
  var y = r.top + Math.min(r.height / 2, Math.max(r.height - 6, 6));
  return {
    x: Math.max(4, Math.min(window.innerWidth - 4, x)),
    y: Math.max(4, Math.min(window.innerHeight - 4, y))
  };
}

function wake() {
  build();
  clearTimeout(dimTimer);
  clearTimeout(hideTimer);
  if (!pos) place({ x: window.innerWidth * 0.62, y: window.innerHeight * 0.55 });
  wrap.style.opacity = '1';
  dimTimer = setTimeout(function () { wrap.style.opacity = '.4'; bubble.style.opacity = '0'; }, IDLE_DIM_MS);
  hideTimer = setTimeout(function () { wrap.style.opacity = '0'; target = null; }, IDLE_HIDE_MS);
}

/* Show text in the bubble with a quick typewriter effect. */
function say(note) {
  wake();
  clearInterval(typeTimer);
  note = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!note) { bubble.style.opacity = '0'; return; }
  bubble.style.opacity = '1';
  if (reduceMotion || note.length > 120) { textEl.textContent = note; place(pos); return; }
  var i = 0;
  textEl.textContent = '';
  typeTimer = setInterval(function () {
    i = Math.min(note.length, i + 2);
    textEl.textContent = note.slice(0, i);
    if (i >= note.length) { clearInterval(typeTimer); place(pos); }
  }, 16);
  textEl.textContent = note.slice(0, 1);
  place(pos);
}

/* Glide to an element (or {x,y}); resolves when the cursor has arrived. */
function moveTo(el, note) {
  wake();
  if (note !== undefined) say(note);
  var to = el && el.getBoundingClientRect ? pointFor(el) : el;
  target = el && el.getBoundingClientRect ? el : null;
  if (!to) return Promise.resolve();
  var from = pos;
  var dist = Math.hypot(to.x - from.x, to.y - from.y);
  var ms = reduceMotion ? 0 : Math.max(160, Math.min(520, dist * 0.6));
  if (gliding) { try { gliding.cancel(); } catch (e) {} gliding = null; }
  place(to);
  if (!ms) return Promise.resolve();
  return new Promise(function (resolve) {
    try {
      gliding = wrap.animate([
        { transform: 'translate3d(' + from.x + 'px,' + from.y + 'px,0)' },
        { transform: 'translate3d(' + to.x + 'px,' + to.y + 'px,0)' }
      ], { duration: ms, easing: 'cubic-bezier(.22,.61,.36,1)' });
      gliding.onfinish = gliding.oncancel = function () { gliding = null; resolve(); };
    } catch (e) { resolve(); }
    setTimeout(resolve, ms + 80); // never hang an action on an animation
  });
}

/* Press-and-ripple at the tip. */
function click() {
  if (!wrap || reduceMotion) return;
  try {
    arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(.82)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
    var ring = css(document.createElement('div'), {
      position: 'absolute', left: '-14px', top: '-14px', width: '28px', height: '28px', 'border-radius': '50%',
      border: '2px solid rgba(168,85,247,.9)', 'box-shadow': '0 0 12px rgba(6,182,212,.7)'
    });
    wrap.insertBefore(ring, arrow);
    var a = ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.9)', opacity: 0 }], { duration: 520, easing: 'ease-out' });
    a.onfinish = function () { ring.remove(); };
  } catch (e) {}
}

function follow() {
  if (!target || gliding || !wrap || wrap.style.opacity === '0') return;
  if (!target.isConnected) { target = null; return; }
  place(pointFor(target));
}
var raf = 0;
function onViewportChange() {
  if (raf) return;
  raf = requestAnimationFrame(function () { raf = 0; follow(); });
}
window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
window.addEventListener('resize', onViewportChange, { passive: true });

window.__fxmcpCursor = {
  moveTo: moveTo,
  say: say,
  click: click,
  /* Hidden while a screenshot is taken, so the model sees the page, not our overlay. */
  conceal: function () {
    if (!host || !host.isConnected || wrap.style.opacity === '0') return false;
    host.style.visibility = 'hidden';
    return true;
  },
  reveal: function () { if (host) host.style.visibility = 'visible'; },
  hide: function () {
    clearTimeout(dimTimer); clearTimeout(hideTimer);
    if (wrap) wrap.style.opacity = '0';
    target = null;
  }
};
})();
