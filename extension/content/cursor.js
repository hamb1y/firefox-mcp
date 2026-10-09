/* WebMCP Controller — the "AI cursor": shows the user where the model is
 * acting and what it says it's doing. Purely visual: pointer-events are off,
 * so it never intercepts real input.
 *
 * Styling goes through element.style and the Web Animations API (CSSOM),
 * which page CSP doesn't block, inside a closed shadow root so page CSS
 * can't reach it. Loaded before ax.js; ax.js drives it via window.__fxmcpCursor.
 *
 * Cursor shapes: Bibata Modern Ice by ful1e5, GPL-3.0 (cursors/bibata/LICENSE).
 */
(function () {
'use strict';

if (window.__fxmcpCursor) return;

var IDLE_DIM_MS = 8000;    // fade to a ghost after this long without activity
var IDLE_HIDE_MS = 30000;  // then disappear
var SIZE = 32;             // drawn size of the 256-unit Bibata shapes
var LIME = '#D7F75B', INK = '#0a0a0a';
var reduceMotion = false;
try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

/* Bibata Modern Ice paths (viewBox 0 0 256 256) and hotspots in drawn px. */
var SHAPES = {
  arrow: {
    hot: [6, 3],
    paths: [{ d: 'M201.163 133.54L201.149 133.528L201.134 133.515L91.6855 36.4935C86.5144 31.7659 81.4269 27.9549 76.5421 25.525C71.7671 23.1497 66.0861 21.5569 60.4133 23.1213C54.3118 24.8039 50.4875 29.4674 48.3639 34.759C46.3122 39.8715 45.4999 46.2787 45.4999 53.5383L45.4999 200.431V200.493L45.5008 200.555C45.6218 208.862 50.4279 217.843 55.9963 223.894C58.8934 227.043 62.5163 229.986 66.6704 231.742C70.9172 233.537 76.217 234.254 81.4691 231.884C85.7536 229.951 89.6754 226.055 92.8565 222.651C94.6841 220.695 96.8336 218.252 99.0355 215.749C100.71 213.847 102.414 211.91 104.03 210.126C112.189 201.122 121.346 192.286 132.161 187.407C143.013 182.511 155.809 181.375 167.963 181.146C170.959 181.089 173.85 181.087 176.65 181.085H176.663H176.686C179.447 181.083 182.164 181.081 184.662 181.019C189.231 180.906 194.643 180.609 198.777 178.88C208.711 174.723 210.972 163.838 210.753 156.445C210.521 148.596 207.57 139.272 201.163 133.54Z', fill: '#FFFFFF', stroke: '#000000', 'stroke-width': '17' }]
  },
  hand: {
    hot: [14, 2],
    paths: [
      { d: 'M120.764 243.559C106.064 243.654 94.9315 234.669 87.33 226.47C79.4457 217.966 72.2147 206.838 65.6646 196.382C64.2676 194.152 62.8936 191.939 61.5335 189.749C56.2005 181.16 51.0808 172.915 45.6262 165.321C38.7567 155.756 32.4011 148.765 26.3033 144.633L15.5723 137.361L19.7447 125.088L21.19 121.644C21.9919 119.999 23.1992 117.834 24.9231 115.515C28.3468 110.91 34.2913 105.096 43.5504 102.37C55.11 98.9669 67.7847 101.278 81.7607 109.426V53.5426C81.7607 33.8583 92.6922 13.7197 113.92 13.7197C135.148 13.7197 146.079 33.8583 146.079 53.5426V68.5677C148.285 68.8131 150.453 69.277 152.536 69.9474C157.658 71.5961 162.433 74.4963 166.346 78.4184C171.172 77.2686 176.261 77.2401 181.23 78.443C187.462 79.9516 192.776 83.1349 196.914 87.5425C202.677 86.2935 208.508 86.7836 213.723 88.5338C228.189 93.3895 238.812 108.053 236.948 126.259L225.329 242.882L120.764 243.559Z', fill: '#000000' },
      { d: 'M120.654 226.56L209.928 225.982L220.035 124.547C222.154 103.987 196.764 95.4317 189.716 114.404C189.805 91.6041 166.436 88.7513 159.398 104.26C160.279 85.423 136.433 78.1324 129.079 94.1164V53.5431C129.079 23.1126 98.7605 23.1126 98.7605 53.5431V144.834C48.2297 94.1168 35.8398 130.561 35.8398 130.561C70.1776 153.83 91.1807 226.751 120.654 226.56Z', fill: '#FFFFFF' }
    ]
  },
  text: {
    hot: [16, 16],
    paths: [{ d: 'M127.93 223.209C136.047 229.785 146.386 233.751 157.637 233.751H163.861C170.212 233.751 175.361 228.603 175.361 222.251V209.684C175.361 203.333 170.212 198.184 163.861 198.184H157.637C151.115 198.184 145.654 192.795 145.654 186.021V69.2299C145.654 62.4559 151.115 57.0668 157.637 57.0668H163.861C170.212 57.0668 175.361 51.9181 175.361 45.5668V33C175.361 26.6487 170.212 21.5 163.861 21.5H157.637C146.386 21.5 136.047 25.4666 127.93 32.0427C119.813 25.4666 109.475 21.5 98.2233 21.5H91.9998C85.6485 21.5 80.4998 26.6487 80.4998 33V45.5668C80.4998 51.9181 85.6485 57.0668 91.9998 57.0668H98.2233C104.746 57.0668 110.207 62.4559 110.207 69.2299V186.021C110.207 192.795 104.746 198.184 98.2233 198.184H91.9998C85.6485 198.184 80.4998 203.333 80.4998 209.684V222.251C80.4998 228.603 85.6484 233.751 91.9998 233.751H98.2233C109.475 233.751 119.813 229.785 127.93 223.209Z', fill: '#FFFFFF', stroke: '#000000', 'stroke-width': '17' }]
  },
  wait: {
    hot: [16, 16],
    spin: true,
    paths: [
      { d: 'M218 128C218 177.706 177.706 218 128 218C78.2944 218 38 177.706 38 128C38 78.2944 78.2944 38 128 38C177.706 38 218 78.2944 218 128Z', fill: '#FFFFFF' },
      { d: 'M128 226.5C182.4 226.5 226.5 182.4 226.5 128C226.5 73.6 182.4 29.5 128 29.5C73.6 29.5 29.5 73.6 29.5 128C29.5 182.4 73.6 226.5 128 226.5Z', fill: 'none', stroke: '#000000', 'stroke-width': '17' },
      { d: 'M135.622 55.4828L128 128L200.517 135.622C201.518 126.099 200.634 116.472 197.914 107.291C195.194 98.1094 190.693 89.5537 184.667 82.1121C178.641 74.6705 171.208 68.4887 162.793 63.9196C154.378 59.3506 145.145 56.4837 135.622 55.4828Z', fill: '#000000', spin: true },
      { d: 'M122.914 200.739L128 128L200.739 133.087C200.071 142.639 197.528 151.966 193.256 160.535C188.983 169.105 183.064 176.749 175.838 183.031C168.611 189.313 160.217 194.11 151.137 197.149C142.056 200.187 132.466 201.407 122.914 200.739Z', fill: '#000000', 'fill-opacity': '0.55', spin: true },
      { d: 'M125.455 200.872L128 128L55.1277 125.455C54.7935 135.025 56.3475 144.567 59.7009 153.536C63.0544 162.505 68.1416 170.726 74.6721 177.729C81.2026 184.732 89.0485 190.38 97.7619 194.351C106.475 198.322 115.885 200.538 125.455 200.872Z', fill: '#000000', 'fill-opacity': '0.3', spin: true },
      { d: 'M128 55.0834V128H55.0833C55.0832 118.425 56.9693 108.943 60.6337 100.096C64.2981 91.2495 69.6691 83.2112 76.44 76.4402C83.211 69.6693 91.2492 64.2983 100.096 60.6339C108.943 56.9695 118.424 55.0834 128 55.0834Z', fill: '#000000', 'fill-opacity': '0.12', spin: true }
    ]
  }
};

var host = null, wrap = null, glyphs = {}, shape = 'arrow', bubble = null, textEl = null;
var pos = null;            // current tip position {x, y} in viewport px
var target = null;         // element we're pointing at (followed on scroll)
var gliding = null;        // running Animation
var concealed = 0;         // screenshots in progress that asked us to hide
var dimTimer = 0, hideTimer = 0, typeTimer = 0;

function css(el, styles) { for (var k in styles) el.style.setProperty(k, styles[k]); return el; }

function svgEl(tag, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (var k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function buildGlyph(name) {
  var s = SHAPES[name];
  var svg = svgEl('svg', { width: String(SIZE), height: String(SIZE), viewBox: '0 0 256 256' });
  css(svg, {
    position: 'absolute', left: -s.hot[0] + 'px', top: -s.hot[1] + 'px', overflow: 'visible', display: 'none',
    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))', 'transform-origin': s.hot[0] + 'px ' + s.hot[1] + 'px'
  });
  var spinner = s.spin ? svgEl('g', {}) : null;
  s.paths.forEach(function (p) {
    var attrs = {};
    for (var k in p) if (k !== 'spin') attrs[k] = p[k];
    (p.spin ? spinner : svg).appendChild(svgEl('path', attrs));
  });
  if (spinner) {
    svg.appendChild(spinner);
    if (!reduceMotion) {
      try {
        css(spinner, { 'transform-origin': '128px 128px', 'transform-box': 'view-box' });
        spinner.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity });
      } catch (e) {}
    }
  }
  return svg;
}

function build() {
  if (host && host.isConnected) return;
  host = document.createElement('fxmcp-cursor');
  css(host, {
    all: 'initial', position: 'fixed', inset: '0', 'pointer-events': 'none',
    'z-index': '2147483647', overflow: 'hidden', contain: 'strict', display: 'block',
    visibility: concealed ? 'hidden' : 'visible'
  });
  var root = host.attachShadow({ mode: 'closed' });

  wrap = css(document.createElement('div'), {
    position: 'absolute', left: '0', top: '0', 'will-change': 'transform, opacity',
    transition: 'opacity .35s ease', opacity: '0'
  });

  glyphs = {};
  Object.keys(SHAPES).forEach(function (name) {
    glyphs[name] = buildGlyph(name);
    wrap.appendChild(glyphs[name]);
  });
  glyphs[shape].style.display = 'block';

  bubble = css(document.createElement('div'), {
    position: 'absolute', left: '22px', top: '30px', display: 'flex', 'align-items': 'center', gap: '8px',
    'max-width': '300px', width: 'max-content', padding: '8px 14px', 'border-radius': '999px',
    background: LIME, color: INK, 'box-shadow': '0 0 0 1.5px ' + INK + ', 0 6px 18px rgba(0,0,0,.22)',
    font: '500 13px/1.35 "Google Sans Flex", system-ui, -apple-system, "Segoe UI", sans-serif',
    'white-space': 'normal', 'overflow-wrap': 'anywhere',
    transition: 'opacity .25s ease', opacity: '0'
  });
  var dot = css(document.createElement('span'), {
    flex: 'none', width: '6px', height: '6px', 'border-radius': '50%', background: INK
  });
  textEl = document.createElement('span');
  bubble.appendChild(dot);
  bubble.appendChild(textEl);

  wrap.appendChild(bubble);
  root.appendChild(wrap);
  (document.documentElement || document.body).appendChild(host);
}

function setShape(name) {
  if (!SHAPES[name]) name = 'arrow';
  if (name === shape) return;
  if (glyphs[shape]) glyphs[shape].style.display = 'none';
  shape = name;
  if (glyphs[shape]) glyphs[shape].style.display = 'block';
}

function place(p) {
  pos = p;
  wrap.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)';
  // Keep the bubble on screen: flip left/up near the right/bottom edges.
  var bw = bubble.offsetWidth || 200, bh = bubble.offsetHeight || 30;
  var vw = window.innerWidth, vh = window.innerHeight;
  bubble.style.left = (p.x + 22 + bw > vw - 8) ? (-bw - 8) + 'px' : '22px';
  bubble.style.top = (p.y + 30 + bh > vh - 8) ? (-bh - 10) + 'px' : '30px';
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
  dimTimer = setTimeout(function () { wrap.style.opacity = '.4'; bubble.style.opacity = '0'; setShape('arrow'); }, IDLE_DIM_MS);
  hideTimer = setTimeout(function () { wrap.style.opacity = '0'; target = null; }, IDLE_HIDE_MS);
}

/* Show text in the bubble with a quick typewriter effect. shape: arrow|hand|text|wait. */
function say(note, shapeName) {
  wake();
  if (shapeName) setShape(shapeName);
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
function moveTo(el, note, shapeName) {
  wake();
  setShape(shapeName || 'arrow');
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
    glyphs[shape].animate([{ transform: 'scale(1)' }, { transform: 'scale(.85)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
    var ring = css(document.createElement('div'), {
      position: 'absolute', left: '-18px', top: '-18px', width: '36px', height: '36px', 'box-sizing': 'border-box',
      'border-radius': '50%', border: '3px solid ' + LIME, 'box-shadow': '0 0 0 1px ' + INK + ', inset 0 0 0 1px ' + INK
    });
    wrap.insertBefore(ring, wrap.firstChild);
    var a = ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: 520, easing: 'ease-out' });
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
  /* Hidden while a screenshot is taken, so the model sees the page, not our overlay.
   * Counted, so overlapping screenshots each get their reveal() before it shows again. */
  conceal: function () {
    if (!host || !host.isConnected || wrap.style.opacity === '0') return false;
    concealed += 1;
    host.style.visibility = 'hidden';
    return true;
  },
  reveal: function () {
    concealed = Math.max(0, concealed - 1);
    if (host && !concealed) host.style.visibility = 'visible';
  },
  hide: function () {
    clearTimeout(dimTimer); clearTimeout(hideTimer);
    clearInterval(typeTimer);
    if (wrap) { wrap.style.opacity = '0'; bubble.style.opacity = '0'; }
    target = null;
  }
};
})();
