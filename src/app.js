/* PDF Signature — renderer */
'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const api = window.api || null;
  const isDesktop = !!(api && api.isDesktop);
  if (isDesktop) document.body.classList.add('desktop');

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const PDFJS_OPTS = {
    cMapUrl: 'vendor/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'vendor/standard_fonts/',
    isEvalSupported: false,
    enableXfa: false,
  };

  /* ------------------------------------------------------------------ */
  /* constants                                                          */
  /* ------------------------------------------------------------------ */
  const INK_COLORS = ['#000000', '#1a2b6d', '#1d4ed8', '#c81e1e'];
  const TEXT_COLORS = ['#000000', '#1a2b6d', '#1d4ed8', '#c81e1e', '#047857'];
  const SIG_FONTS = ['Great Vibes', 'Dancing Script', 'Allura', 'Alex Brush', 'Sacramento', 'Satisfy', 'Caveat', 'Homemade Apple'];
  const FONT_CSS = {
    Helvetica: 'Arial, Helvetica, "Liberation Sans", "Arimo", sans-serif',
    Times: '"Times New Roman", Times, "Liberation Serif", "Tinos", serif',
    Courier: '"Courier New", Courier, "Liberation Mono", "Cousine", monospace',
  };
  const LINE_HEIGHT = 1.2;
  const IMAGE_KINDS = new Set(['signature', 'initials', 'image', 'check', 'cross', 'dot']);
  const MARK_KINDS = new Set(['check', 'cross', 'dot']);
  const KIND_LABEL = { signature: 'Signature', initials: 'Initials', image: 'Image', check: 'Checkmark', cross: 'Cross', dot: 'Dot', text: 'Text', date: 'Date' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DATE_FORMATS = ['dd.MM.yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'd MMMM yyyy', 'MMMM d, yyyy'];
  const LS = {
    saved: 'pdfsig.saved.v1',
    recent: 'pdfsig.recent.v1',
    prefs: 'pdfsig.prefs.v1',
  };

  /* ------------------------------------------------------------------ */
  /* storage helpers                                                    */
  /* ------------------------------------------------------------------ */
  function lsGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  const prefs = Object.assign({
    sidebar: true,
    sigTab: 'draw',
    inkColor: '#000000',
    inkWidth: 2.5,
    typeName: '',
    typeFont: 'Great Vibes',
    typeColor: '#000000',
    dateFormat: defaultDateFormat(),
    textFont: 'Helvetica',
    textSize: 12,
    textColor: '#000000',
    markColor: '#000000',
  }, lsGet(LS.prefs, {}));
  function savePrefs() { lsSet(LS.prefs, prefs); }

  function defaultDateFormat() {
    const l = (navigator.language || 'en-US').toLowerCase();
    if (l === 'en-us' || l.endsWith('-us') || l === 'en-ph') return 'MM/dd/yyyy';
    if (l.startsWith('en') || l.startsWith('fr') || l.startsWith('es') || l.startsWith('it') || l.startsWith('pt')) return 'dd/MM/yyyy';
    if (l.startsWith('zh') || l.startsWith('ja') || l.startsWith('ko') || l.startsWith('sv') || l.startsWith('lt')) return 'yyyy-MM-dd';
    return 'dd.MM.yyyy';
  }
  function formatDate(d, f) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    switch (f) {
      case 'dd/MM/yyyy': return `${dd}/${mm}/${yyyy}`;
      case 'MM/dd/yyyy': return `${mm}/${dd}/${yyyy}`;
      case 'yyyy-MM-dd': return `${yyyy}-${mm}-${dd}`;
      case 'd MMMM yyyy': return `${d.getDate()} ${MONTHS[d.getMonth()]} ${yyyy}`;
      case 'MMMM d, yyyy': return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${yyyy}`;
      default: return `${dd}.${mm}.${yyyy}`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */
  const S = {
    doc: null,
    bytes: null,
    name: '',
    path: null,
    savedPath: null,
    needsPassword: false,
    pages: [],
    zoom: 1,
    zoomMode: 'fit-width',
    els: [],
    assets: new Map(),
    assetBySrc: new Map(),
    sel: null,
    editing: null,
    editSnapshot: null,
    editIsNew: false,
    undo: [],
    redo: [],
    dirty: false,
    current: 0,
    loadToken: 0,
    fieldObjects: null,
    hasForms: false,
    pendingSigField: null,
  };
  const LINK_STUB = {
    eventBus: null,
    externalLinkEnabled: false,
    getDestinationHash: () => '#',
    getAnchorUrl: () => '#',
    addLinkAttributes: () => {},
    goToDestination: () => {},
    navigateTo: () => {},
    executeNamedAction: () => {},
    executeSetOCGState: () => {},
    cachePageRef: () => {},
    isPageVisible: () => true,
    isPageCached: () => true,
  };
  let idCounter = 1;
  const uid = (p) => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

  const dpr = () => Math.max(1, window.devicePixelRatio || 1);

  /* ------------------------------------------------------------------ */
  /* DOM refs                                                           */
  /* ------------------------------------------------------------------ */
  const homeEl = $('#home');
  const editorEl = $('#editor');
  const viewer = $('#viewer');
  const pagesEl = $('#pages');
  const thumbsEl = $('#thumbs');
  const pageInput = $('#page-input');
  const zoomSelect = $('#zoom-select');

  /* ------------------------------------------------------------------ */
  /* UI helpers: toasts, busy, dialogs                                  */
  /* ------------------------------------------------------------------ */
  function toast(msg, opts = {}) {
    const t = document.createElement('div');
    t.className = 'toast' + (opts.error ? ' error' : '');
    const m = document.createElement('span');
    m.className = 't-msg';
    m.textContent = msg;
    t.appendChild(m);
    for (const a of opts.actions || []) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.onclick = () => { a.run(); t.remove(); };
      t.appendChild(b);
    }
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), opts.duration || (opts.actions ? 7000 : 3500));
  }

  let busyCount = 0;
  function busy(on, msg) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    if (on && msg) $('#busy-msg').textContent = msg;
    $('#busy').hidden = busyCount === 0;
  }

  let dlgResolve = null;
  function dialog({ title, message, buttons, input }) {
    return new Promise((resolve) => {
      const m = $('#dlg-modal');
      $('#dlg-title').textContent = title || '';
      $('#dlg-msg').textContent = message || '';
      const inp = $('#dlg-input');
      inp.hidden = !input;
      inp.value = '';
      if (input) inp.placeholder = input.placeholder || '';
      const wrap = $('#dlg-buttons');
      wrap.innerHTML = '';
      let primaryVal = null;
      let cancelVal = null;
      for (const b of buttons) {
        const el = document.createElement('button');
        el.className = 'btn ' + (b.primary ? 'btn-primary' : 'btn-ghost') + (b.danger ? ' btn-danger' : '');
        el.textContent = b.label;
        el.onclick = () => finish(b.value);
        wrap.appendChild(el);
        if (b.primary) primaryVal = b.value;
        if (b.cancel) cancelVal = b.value;
      }
      function finish(v) {
        m.hidden = true;
        dlgResolve = null;
        resolve(input ? { value: v, text: inp.value } : v);
      }
      dlgResolve = { finish, primaryVal, cancelVal };
      m.hidden = false;
      setTimeout(() => (input ? inp : wrap.querySelector('.btn-primary') || wrap.lastChild).focus(), 30);
    });
  }
  const isDialogOpen = () => !$('#dlg-modal').hidden;

  function swatches(container, colors, current, onPick) {
    container.innerHTML = '';
    let found = false;
    for (const c of colors) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.title = c;
      if (current && c.toLowerCase() === current.toLowerCase()) { b.classList.add('active'); found = true; }
      b.onclick = () => { onPick(c); swatches(container, colors, c, onPick); };
      container.appendChild(b);
    }
    const custom = document.createElement('label');
    custom.className = 'swatch swatch-custom' + (!found && current ? ' active' : '');
    custom.title = 'Custom color';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = /^#[0-9a-f]{6}$/i.test(current || '') ? current : '#000000';
    inp.oninput = () => onPick(inp.value);
    inp.onchange = () => swatches(container, colors, inp.value, onPick);
    custom.appendChild(inp);
    container.appendChild(custom);
  }

  /* ------------------------------------------------------------------ */
  /* image / asset helpers                                              */
  /* ------------------------------------------------------------------ */
  function dataUrlToBytes(src) {
    const comma = src.indexOf(',');
    const bin = atob(src.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read this image.'));
      img.src = src;
    });
  }
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  function canvasHasTransparency(c) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  }
  function trimCanvas(c, pad = 0) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const { width: w, height: h } = c;
    if (!w || !h) return null;
    const d = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (d[row + x * 4 + 3] > 6) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }
  function addAsset(src, w, h, opts = {}) {
    if (S.assetBySrc.has(src)) return S.assetBySrc.get(src);
    const id = uid('a');
    S.assets.set(id, { id, src, w, h, mime: opts.mime || (src.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png'), transparent: opts.transparent !== false });
    S.assetBySrc.set(src, id);
    return id;
  }
  async function assetFromSrc(src, transparent) {
    if (S.assetBySrc.has(src)) return S.assetBySrc.get(src);
    const img = await loadImage(src);
    return addAsset(src, img.naturalWidth, img.naturalHeight, { transparent });
  }

  const markCache = new Map();
  function markAsset(kind, color) {
    const key = kind + color;
    if (markCache.has(key)) return markCache.get(key);
    const N = 256;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d');
    const k = N / 24;
    ctx.scale(k, k);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.2;
    if (kind === 'check') {
      ctx.beginPath(); ctx.moveTo(2.6, 12.8); ctx.lineTo(8.8, 19); ctx.lineTo(21.4, 5.4); ctx.stroke();
    } else if (kind === 'cross') {
      ctx.beginPath(); ctx.moveTo(3.5, 3.5); ctx.lineTo(20.5, 20.5); ctx.moveTo(20.5, 3.5); ctx.lineTo(3.5, 20.5); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(12, 12, 11, 0, Math.PI * 2); ctx.fill();
    }
    const id = addAsset(c.toDataURL('image/png'), N, N, { transparent: true });
    markCache.set(key, id);
    return id;
  }

  const tintCache = new Map();
  async function tintedAsset(baseId, color) {
    const key = baseId + color;
    if (tintCache.has(key)) return tintCache.get(key);
    const a = S.assets.get(baseId);
    const img = await loadImage(a.src);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    const id = addAsset(c.toDataURL('image/png'), c.width, c.height, { transparent: true });
    tintCache.set(key, id);
    return id;
  }

  /* ------------------------------------------------------------------ */
  /* text metrics                                                       */
  /* ------------------------------------------------------------------ */
  const baselineCache = {};
  function baselineRatio(font) {
    if (baselineCache[font]) return baselineCache[font];
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:-9999px;top:0;font-size:100px;line-height:${LINE_HEIGHT};white-space:pre;font-family:${FONT_CSS[font]};padding:0;margin:0`;
    const t = document.createTextNode('Hg');
    const mark = document.createElement('span');
    mark.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline';
    box.appendChild(t);
    box.appendChild(mark);
    document.body.appendChild(box);
    const r = (mark.getBoundingClientRect().top - box.getBoundingClientRect().top) / 100;
    box.remove();
    const v = r > 0.5 && r < 1.2 ? r : 0.95;
    baselineCache[font] = v;
    return v;
  }

 /** Exact baseline of line 0 and line pitch (in points) for a text element as the browser lays it out at the current zoom. */
  function textMetrics(el) {
    const z = S.zoom || 1;
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:-99999px;top:0;white-space:pre;line-height:${LINE_HEIGHT};padding:0;margin:0;font-size:${el.fontSize * z}px;font-family:${FONT_CSS[el.font] || FONT_CSS.Helvetica}`;
    const m1 = document.createElement('span');
    const m2 = document.createElement('span');
    for (const m of [m1, m2]) m.style.cssText = 'display:inline-block;width:1px;height:0;vertical-align:baseline';
    box.append(document.createTextNode('Hg'), m1, document.createTextNode('\nHg'), m2);
    pagesEl.appendChild(box);
    const top = box.getBoundingClientRect().top;
    const b1 = m1.getBoundingClientRect().top - top;
    const b2 = m2.getBoundingClientRect().top - top;
    box.remove();
    const fs = el.fontSize;
    const first = b1 > 0 ? b1 / z : baselineRatio(el.font) * fs;
    const step = b2 > b1 ? (b2 - b1) / z : LINE_HEIGHT * fs;
    return { first, step };
  }

  /* ------------------------------------------------------------------ */
  /* dirty state / title                                                */
  /* ------------------------------------------------------------------ */
  function setDirty(v) {
    S.dirty = v;
    if (api) api.setDirty(v);
    updateTitle();
  }
  function updateTitle() {
    const nameEl = $('#doc-name');
    nameEl.textContent = S.name || '';
    nameEl.title = S.path || S.name || '';
    if (S.dirty && S.name) {
      const d = document.createElement('span');
      d.className = 'dirty';
      d.textContent = '•';
      nameEl.appendChild(d);
    }
    const t = S.name ? `${S.dirty ? '• ' : ''}${S.name} — PDF Signature` : 'PDF Signature';
    document.title = t;
    if (api) api.setTitle(t);
  }

  /* ------------------------------------------------------------------ */
  /* undo / redo                                                        */
  /* ------------------------------------------------------------------ */
  const snapshot = () => JSON.stringify(S.els);
  function checkpoint() {
    S.undo.push(snapshot());
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
    setDirty(true);
    updateUndoUI();
  }
  function updateUndoUI() {
    $('#btn-undo').disabled = !S.undo.length;
    $('#btn-redo').disabled = !S.redo.length;
  }
  function undo() {
    if (S.editing) finishEdit();
    if (!S.undo.length) return;
    S.redo.push(snapshot());
    S.els = JSON.parse(S.undo.pop());
    afterRestore();
  }
  function redo() {
    if (S.editing) finishEdit();
    if (!S.redo.length) return;
    S.undo.push(snapshot());
    S.els = JSON.parse(S.redo.pop());
    afterRestore();
  }
  function afterRestore() {
    if (S.sel && !getEl(S.sel)) S.sel = null;
    renderAllEls();
    setDirty(true);
    updateUndoUI();
  }

  /* ------------------------------------------------------------------ */
  /* opening documents                                                  */
  /* ------------------------------------------------------------------ */
  async function confirmDiscard() {
    if (S.editing) finishEdit();
    if (!S.doc || !S.dirty) return true;
    const r = await dialog({
      title: 'Save changes?',
      message: `Do you want to save your changes to "${S.name}" first?`,
      buttons: [
        { label: 'Cancel', value: 'cancel', cancel: true },
        { label: "Don't save", value: 'discard' },
        { label: 'Save', value: 'save', primary: true },
      ],
    });
    if (r === 'cancel' || r == null) return false;
    if (r === 'save') return await save();
    return true;
  }

  async function openViaDialog() {
    if (!(await confirmDiscard())) return;
    if (isDesktop) {
      try {
        const f = await api.openDialog();
        if (f) await openBytes(f.data, f.name, f.path, true);
      } catch (e) {
        toast(errMsg(e), { error: true });
      }
    } else {
      $('#file-pdf').value = '';
      $('#file-pdf').click();
    }
  }

  async function openPath(p) {
    if (!(await confirmDiscard())) return;
    try {
      const f = await api.readFile(p);
      await openBytes(f.data, f.name, f.path, true);
    } catch (e) {
      removeRecent(p);
      toast(`Couldn't open "${p}". ${errMsg(e)}`, { error: true });
    }
  }

  async function openFileObject(file) {
    if (!(await confirmDiscard())) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const p = isDesktop ? api.getPathForFile(file) : null;
      await openBytes(buf, file.name, p, true);
    } catch (e) {
      toast(errMsg(e), { error: true });
    }
  }

  function errMsg(e) {
    if (!e) return 'Unknown error.';
    const m = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return m;
  }

  function askPassword(reason) {
    return dialog({
      title: reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'Incorrect password' : 'Password required',
      message: reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        ? 'The password is incorrect. Please try again.'
        : 'This PDF is protected. Enter the password to open it.',
      input: { placeholder: 'Password' },
      buttons: [
        { label: 'Cancel', value: false, cancel: true },
        { label: 'Open', value: true, primary: true },
      ],
    });
  }

  async function openBytes(bytes, name, path, skipConfirm) {
    if (!skipConfirm && !(await confirmDiscard())) return;
    const token = ++S.loadToken;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length < 5) throw new Error('This file is empty.');
    const keep = data.slice();
    busy(true, 'Opening…');
    let doc;
    let needsPassword = false;
    try {
      const task = pdfjsLib.getDocument(Object.assign({ data: data.slice() }, PDFJS_OPTS));
      task.onPassword = async (update, reason) => {
        needsPassword = true;
        busy(false);
        const r = await askPassword(reason);
        busy(true, 'Opening…');
        if (r.value) update(r.text);
        else task.destroy();
      };
      doc = await task.promise;
    } catch (e) {
      busy(false);
      if (e && e.name === 'PasswordException') return;
      if (String(e && e.message).includes('Worker was destroyed') || String(e && e.message).includes('Loading aborted')) return;
      await dialog({
        title: "Can't open this file",
        message: `"${name}" could not be opened. It may be damaged or not a PDF.\n\n${errMsg(e)}`,
        buttons: [{ label: 'OK', value: 'ok', primary: true, cancel: true }],
      });
      return;
    }
    if (token !== S.loadToken) { doc.destroy(); busy(false); return; }

    try {
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const proxy = await doc.getPage(i);
        pages.push({ index: i - 1, proxy, vp1: proxy.getViewport({ scale: 1 }) });
      }
      let fieldObjects = null;
      try { fieldObjects = await doc.getFieldObjects(); } catch (_) { fieldObjects = null; }
      if (token !== S.loadToken) { doc.destroy(); return; }

      closeDocument(true);
      S.fieldObjects = fieldObjects;
      S.hasForms = !!fieldObjects && Object.values(fieldObjects).some((arr) => Array.isArray(arr) && arr.some((f) => f && f.type && f.type !== 'signature' && f.type !== 'button'));
      const hasSigFields = !!fieldObjects && Object.values(fieldObjects).some((arr) => Array.isArray(arr) && arr.some((f) => f && f.type === 'signature'));
      doc.annotationStorage.onSetModified = () => { if (S.doc === doc) setDirty(true); };
      S.doc = doc;
      S.bytes = keep;
      S.name = name || 'document.pdf';
      S.path = path || null;
      S.savedPath = null;
      S.needsPassword = needsPassword;
      S.pages = pages;
      S.els = [];
      S.undo = [];
      S.redo = [];
      S.sel = null;
      S.current = 0;
      buildPages();
      showEditor();
      S.zoomMode = 'fit-width';
      applyZoom(computeFit('fit-width'), null);
      viewer.scrollTop = 0;
      viewer.scrollLeft = 0;
      setDirty(false);
      updateUndoUI();
      updateSelectionUI();
      updateCurrentPage();
      if (path && isDesktop) addRecent(path, S.name);
      if (S.hasForms || hasSigFields) {
        toast(S.hasForms
          ? 'This PDF has fillable form fields — click a highlighted field to type in it.'
          : 'This PDF has signature fields — click "Sign here" to sign.', { duration: 6000 });
      }
    } finally {
      busy(false);
    }
  }

  function closeDocument(silent) {
    if (S.editing) finishEdit();
    for (const p of S.pages) {
      if (p.task) try { p.task.cancel(); } catch (_) { /* */ }
    }
    if (S.doc) { try { S.doc.destroy(); } catch (_) { /* */ } }
    if (pageObserver) pageObserver.disconnect();
    if (thumbObserver) thumbObserver.disconnect();
    pagesEl.innerHTML = '';
    thumbsEl.innerHTML = '';
    S.doc = null;
    S.pages = [];
    S.els = [];
    S.sel = null;
    S.bytes = null;
    S.fieldObjects = null;
    S.hasForms = false;
    S.pendingSigField = null;
    if (!silent) {
      S.name = '';
      S.path = null;
      S.savedPath = null;
      setDirty(false);
      showHome();
    }
  }

  function showEditor() {
    homeEl.hidden = true;
    editorEl.hidden = false;
    thumbsEl.classList.toggle('collapsed', !prefs.sidebar);
  }
  function showHome() {
    editorEl.hidden = true;
    homeEl.hidden = false;
    renderRecent();
    updateTitle();
  }

  /* ------------------------------------------------------------------ */
  /* page building & rendering                                          */
  /* ------------------------------------------------------------------ */
  let pageObserver = null;
  let thumbObserver = null;

  function buildPages() {
    pagesEl.innerHTML = '';
    thumbsEl.innerHTML = '';
    pageObserver = new IntersectionObserver(onPageIntersect, { root: viewer, rootMargin: '900px 0px' });
    thumbObserver = new IntersectionObserver(onThumbIntersect, { root: thumbsEl, rootMargin: '400px 0px' });
    const maxW = Math.max(...S.pages.map((p) => p.vp1.width));
    for (const p of S.pages) {
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.index = p.index;
      div.style.width = `calc(${p.vp1.width}px * var(--z))`;
      div.style.height = `calc(${p.vp1.height}px * var(--z))`;
      const loading = document.createElement('div');
      loading.className = 'page-loading';
      loading.textContent = 'Loading…';
      const sigLayer = document.createElement('div');
      sigLayer.className = 'sigfields';
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      div.append(loading, sigLayer, overlay);
      p.sigLayer = sigLayer;
      p.sigFields = [];
      p.annotsLoaded = false;
      pagesEl.appendChild(div);
      p.div = div;
      p.overlay = overlay;
      p.loading = loading;
      p.canvas = null;
      p.renderKey = null;
      p.visible = false;
      pageObserver.observe(div);

      const th = document.createElement('div');
      th.className = 'thumb';
      th.dataset.index = p.index;
      const box = document.createElement('div');
      box.className = 'thumb-box';
      const tw = Math.round(120 * (p.vp1.width / maxW));
      const thh = Math.round(tw * p.vp1.height / p.vp1.width);
      const tc = document.createElement('canvas');
      tc.style.width = tw + 'px';
      tc.style.height = thh + 'px';
      box.appendChild(tc);
      const num = document.createElement('div');
      num.className = 'thumb-num';
      num.textContent = p.index + 1;
      th.append(box, num);
      th.onclick = () => goToPage(p.index);
      thumbsEl.appendChild(th);
      p.thumb = th;
      p.thumbCanvas = tc;
      p.thumbDone = false;
      thumbObserver.observe(th);
    }
    $('#page-count').textContent = S.pages.length;
  }

  function onPageIntersect(entries) {
    for (const e of entries) {
      const p = S.pages[+e.target.dataset.index];
      if (p) p.visible = e.isIntersecting;
    }
    scheduleRender();
  }
  function onThumbIntersect(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const p = S.pages[+e.target.dataset.index];
      if (p && !p.thumbDone) renderThumb(p);
    }
  }

  let renderScheduled = false;
  let rendering = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => { renderScheduled = false; renderLoop(); });
  }
  async function renderLoop() {
    if (rendering) return;
    rendering = true;
    try {
      for (;;) {
        const key = S.zoom * dpr();
        const todo = S.pages.filter((p) => p.visible && p.renderKey !== key)
          .sort((a, b) => Math.abs(a.index - S.current) - Math.abs(b.index - S.current));
        if (!todo.length) break;
        await renderPage(todo[0], key);
      }
      releaseFarPages();
    } finally {
      rendering = false;
    }
  }

  async function renderPage(p, key) {
    const doc = S.doc;
    let scale = key;
    const maxPx = 16e6;
    const area = p.vp1.width * p.vp1.height * scale * scale;
    if (area > maxPx) scale *= Math.sqrt(maxPx / area);
    const vp = p.proxy.getViewport({ scale });
    const c = document.createElement('canvas');
    c.className = 'pdf-canvas';
    c.width = Math.max(1, Math.floor(vp.width));
    c.height = Math.max(1, Math.floor(vp.height));
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const task = p.proxy.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
    p.task = task;
    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.error('Render error', e);
      p.renderKey = key;
      if (p.loading) p.loading.textContent = 'This page could not be displayed';
      return;
    } finally {
      if (p.task === task) p.task = null;
    }
    if (S.doc !== doc) return;
    if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); }
    p.div.insertBefore(c, p.div.firstChild);
    if (!p.annotsLoaded) buildAnnotationLayer(p);
    p.canvas = c;
    p.renderKey = key;
    if (p.loading) { p.loading.remove(); p.loading = null; }
  }

  async function buildAnnotationLayer(p) {
    p.annotsLoaded = true;
    const doc = S.doc;
    let annots;
    try {
      annots = await p.proxy.getAnnotations({ intent: 'display' });
    } catch (e) {
      console.warn('getAnnotations failed', e);
      return;
    }
    if (S.doc !== doc) return;
    const widgets = annots.filter((a) => a.subtype === 'Widget');
    p.sigFields = widgets
      .filter((a) => a.fieldType === 'Sig' && !a.hidden)
      .map((a) => {
        const [x1, y1, x2, y2] = p.vp1.convertToViewportRectangle(a.rect);
        return { name: a.fieldName || '', x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      })
      .filter((f) => f.w > 2 && f.h > 2);
    renderSigFields(p);
    const forms = widgets.filter((a) => a.fieldType !== 'Sig');
    if (!forms.length) return;
    const div = document.createElement('div');
    div.className = 'annotationLayer';
    p.div.insertBefore(div, p.sigLayer);
    try {
      const layer = new pdfjsLib.AnnotationLayer({
        div,
        page: p.proxy,
        viewport: p.proxy.getViewport({ scale: 1 }).clone({ dontFlip: true }),
      });
      await layer.render({
        annotations: forms,
        linkService: LINK_STUB,
        downloadManager: null,
        annotationStorage: doc.annotationStorage,
        renderForms: true,
        enableScripting: false,
        hasJSActions: false,
        fieldObjects: S.fieldObjects,
        imageResourcesPath: '',
      });
      p.annotLayer = layer;
      for (const inp of div.querySelectorAll('input, textarea, select')) inp.spellcheck = false;
    } catch (e) {
      console.warn('Form layer failed', e);
      div.remove();
    }
  }

  function renderSigFields(p) {
    p.sigLayer.innerHTML = '';
    p.sigFields.forEach((f, idx) => {
      const b = document.createElement('button');
      b.className = 'sigfield';
      b.dataset.idx = idx;
      b.title = f.name ? `Signature field: ${f.name}` : 'Signature field';
      b.style.left = `calc(${f.x}px * var(--z))`;
      b.style.top = `calc(${f.y}px * var(--z))`;
      b.style.width = `calc(${f.w}px * var(--z))`;
      b.style.height = `calc(${f.h}px * var(--z))`;
      b.innerHTML = '<span><svg class="ico"><use href="#i-sign"/></svg>Sign here</span>';
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (S.editing) finishEdit();
        S.pendingSigField = { page: p.index, ...f };
        openSig('signature');
      });
      p.sigLayer.appendChild(b);
    });
    updateSigFieldVisibility();
  }

  function sigFieldAt(page, x, y) {
    const p = S.pages[page];
    if (!p || !p.sigFields) return null;
    const f = p.sigFields.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    return f ? { page, ...f } : null;
  }

  function updateSigFieldVisibility() {
    for (const p of S.pages) {
      if (!p.sigLayer) continue;
      for (const b of p.sigLayer.children) {
        const f = p.sigFields[+b.dataset.idx];
        if (!f) continue;
        const covered = S.els.some((e) => e.page === p.index && !isText(e)
          && e.x < f.x + f.w && e.x + e.w > f.x && e.y < f.y + f.h && e.y + e.h > f.y);
        b.classList.toggle('filled', covered);
      }
    }
  }

  function releaseFarPages() {
    const alive = S.pages.filter((p) => p.canvas);
    if (alive.length <= 10) return;
    for (const p of alive) {
      if (!p.visible && Math.abs(p.index - S.current) > 5) {
        p.canvas.width = 0;
        p.canvas.remove();
        p.canvas = null;
        p.renderKey = null;
      }
    }
  }

  async function renderThumb(p) {
    p.thumbDone = true;
    const doc = S.doc;
    const cssW = parseFloat(p.thumbCanvas.style.width);
    const scale = (cssW / p.vp1.width) * dpr();
    const vp = p.proxy.getViewport({ scale });
    const c = p.thumbCanvas;
    c.width = Math.max(1, Math.floor(vp.width));
    c.height = Math.max(1, Math.floor(vp.height));
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    try {
      await p.proxy.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
    } catch (e) {
      if (S.doc === doc) p.thumbDone = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* zoom                                                               */
  /* ------------------------------------------------------------------ */
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 5;
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

  function computeFit(mode) {
    if (!S.pages.length) return 1;
    const availW = viewer.clientWidth - 56;
    const maxW = Math.max(...S.pages.map((p) => p.vp1.width));
    const fw = availW / maxW;
    if (mode === 'fit-width') return clampZoom(fw);
    const p = S.pages[S.current] || S.pages[0];
    const fh = (viewer.clientHeight - 44) / p.vp1.height;
    return clampZoom(Math.min(availW / p.vp1.width, fh));
  }
  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

  function applyZoom(z, anchor) {
    z = clampZoom(z);
    let a = null;
    if (S.pages.length) {
      const vr = viewer.getBoundingClientRect();
      const ax = anchor ? anchor.x : vr.left + vr.width / 2;
      const ay = anchor ? anchor.y : vr.top + Math.min(vr.height / 2, 120);
      let pi = pageAt(ax, ay);
      if (pi < 0) pi = S.current;
      const p = S.pages[pi];
      if (p && p.div) {
        const r = p.div.getBoundingClientRect();
        a = { pi, fx: (ax - r.left) / r.width, fy: (ay - r.top) / r.height, ax: ax - vr.left, ay: ay - vr.top };
      }
    }
    S.zoom = z;
    pagesEl.style.setProperty('--z', z);
    pagesEl.style.setProperty('--scale-factor', z);
    updateZoomUI();
    if (a) {
      const p = S.pages[a.pi];
      const left = p.div.offsetLeft + a.fx * p.div.offsetWidth;
      const top = p.div.offsetTop + a.fy * p.div.offsetHeight;
      viewer.scrollLeft = left - a.ax;
      viewer.scrollTop = top - a.ay;
    }
    measureAllText();
    updateBarPlacement();
    scheduleRender();
  }

  function updateZoomUI() {
    const pct = Math.round(S.zoom * 100) + '%';
    if (S.zoomMode === 'fit-width' || S.zoomMode === 'fit-page') {
      zoomSelect.value = S.zoomMode;
    } else {
      const match = $$('option', zoomSelect).find((o) => Math.abs(parseFloat(o.value) - S.zoom) < 1e-6);
      if (match) zoomSelect.value = match.value;
      else {
        const o = zoomSelect.querySelector('option[value="custom"]');
        o.textContent = pct;
        zoomSelect.value = 'custom';
      }
    }
    zoomSelect.title = `Zoom: ${pct}`;
  }

  function zoomStep(dir) {
    const z = S.zoom;
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > z + 1e-3) || ZOOM_MAX;
    else next = [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-3) || ZOOM_MIN;
    S.zoomMode = 'custom';
    applyZoom(next, null);
  }

  /* ------------------------------------------------------------------ */
  /* page navigation                                                    */
  /* ------------------------------------------------------------------ */
  function pageAt(x, y) {
    for (const p of S.pages) {
      const r = p.div.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return p.index;
    }
    return -1;
  }
  function nearestPageAt(x, y) {
    let best = -1;
    let bestD = Infinity;
    for (const p of S.pages) {
      const r = p.div.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p.index; }
    }
    return best;
  }

  function updateCurrentPage() {
    if (!S.pages.length) return;
    const vr = viewer.getBoundingClientRect();
    let best = S.current;
    let bestArea = -1;
    for (const p of S.pages) {
      if (!p.visible && p.index !== S.current) continue;
      const r = p.div.getBoundingClientRect();
      const h = Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
      const w = Math.max(0, Math.min(r.right, vr.right) - Math.max(r.left, vr.left));
      const area = h * w;
      if (area > bestArea + 1) { bestArea = area; best = p.index; }
    }
    setCurrent(best);
  }
  function setCurrent(i) {
    const changed = i !== S.current;
    S.current = i;
    if (document.activeElement !== pageInput) pageInput.value = i + 1;
    $('#btn-prev').disabled = i <= 0;
    $('#btn-next').disabled = i >= S.pages.length - 1;
    for (const p of S.pages) p.thumb.classList.toggle('active', p.index === i);
    if (changed) {
      const th = S.pages[i] && S.pages[i].thumb;
      if (th && !thumbsEl.classList.contains('collapsed')) {
        const tr = th.getBoundingClientRect();
        const cr = thumbsEl.getBoundingClientRect();
        if (tr.top < cr.top || tr.bottom > cr.bottom) th.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  function goToPage(i) {
    i = Math.max(0, Math.min(S.pages.length - 1, i));
    const p = S.pages[i];
    if (!p) return;
    viewer.scrollTop = p.div.offsetTop - 16;
    setCurrent(i);
    scheduleRender();
  }

  let scrollRaf = 0;
  viewer.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      updateCurrentPage();
      scheduleRender();
    });
  });

  /* ------------------------------------------------------------------ */
  /* elements: model                                                    */
  /* ------------------------------------------------------------------ */
  const getEl = (id) => S.els.find((e) => e.id === id) || null;
  const isText = (el) => el.kind === 'text' || el.kind === 'date';
  const nodeFor = (id) => pagesEl.querySelector(`.el[data-id="${CSS.escape(id)}"]`);

  function pageDims(i) {
    const p = S.pages[i];
    return { w: p.vp1.width, h: p.vp1.height };
  }
  function clampEl(el) {
    const { w, h } = pageDims(el.page);
    el.x = Math.min(Math.max(0, el.x), Math.max(0, w - el.w));
    el.y = Math.min(Math.max(0, el.y), Math.max(0, h - el.h));
  }

  /** Centre of the visible part of the current page, in page points. */
  function visibleCenter(pi) {
    const p = S.pages[pi];
    const r = p.div.getBoundingClientRect();
    const vr = viewer.getBoundingClientRect();
    const l = Math.max(r.left, vr.left), rt = Math.min(r.right, vr.right);
    const t = Math.max(r.top, vr.top), b = Math.min(r.bottom, vr.bottom);
    let cx = (l + rt) / 2, cy = (t + b) / 2;
    if (rt <= l || b <= t) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    return { x: (cx - r.left) / S.zoom, y: (cy - r.top) / S.zoom };
  }

  function placementPoint(at) {
    if (at) return at;
    const pi = Math.min(S.current, S.pages.length - 1);
    return { page: pi, ...visibleCenter(pi) };
  }

  function avoidStacking(el) {
    let guard = 0;
    while (guard++ < 20 && S.els.some((o) => o !== el && o.page === el.page && Math.abs(o.x - el.x) < 2 && Math.abs(o.y - el.y) < 2)) {
      el.x += 14; el.y += 14;
      clampEl(el);
    }
  }

  function addImageElement(kind, assetId, at, extra = {}, fit = null) {
    if (!S.pages.length) return null;
    const a = S.assets.get(assetId);
    if (!fit && at && (kind === 'signature' || kind === 'initials')) fit = sigFieldAt(at.page, at.x, at.y);
    const pt = fit ? { page: fit.page, x: fit.x + fit.w / 2, y: fit.y + fit.h / 2 } : placementPoint(at);
    const { w: pw, h: ph } = pageDims(pt.page);
    const aspect = a.w / a.h;
    let w, h;
    if (fit) {
      const bw = fit.w * 0.94, bh = fit.h * 0.9;
      w = bw; h = w / aspect;
      if (h > bh) { h = bh; w = h * aspect; }
      at = pt;
    } else if (kind === 'signature' || kind === 'initials') {
      h = kind === 'signature' ? 40 : 30;
      w = h * aspect;
      const maxW = Math.min(kind === 'signature' ? 220 : 110, pw * 0.5);
      if (w > maxW) { w = maxW; h = w / aspect; }
      if (w < 24) { w = 24; h = w / aspect; }
    } else if (MARK_KINDS.has(kind)) {
      w = h = kind === 'dot' ? 9 : kind === 'check' ? 18 : 15;
    } else {
      w = Math.min(200, pw * 0.5);
      h = w / aspect;
      if (h > ph * 0.5) { h = ph * 0.5; w = h * aspect; }
    }
    checkpoint();
    const el = Object.assign({
      id: uid('e'), page: pt.page, kind, x: pt.x - w / 2, y: pt.y - h / 2, w, h, asset: assetId, baseAsset: assetId, color: null, opacity: 1,
    }, extra);
    clampEl(el);
    if (!at) avoidStacking(el);
    S.els.push(el);
    S.sel = el.id;
    renderAllEls();
    return el;
  }

  function addTextElement(kind, at) {
    if (!S.pages.length) return;
    if (S.editing) finishEdit();
    const pt = placementPoint(at);
    const before = snapshot();
    const el = {
      id: uid('e'), page: pt.page, kind,
      x: pt.x, y: pt.y,
      w: 10, h: prefs.textSize * LINE_HEIGHT,
      text: kind === 'date' ? formatDate(new Date(), prefs.dateFormat) : '',
      font: prefs.textFont, fontSize: prefs.textSize, color: prefs.textColor, opacity: 1,
    };
    if (kind === 'date') { el.dateFormat = prefs.dateFormat; el.dateISO = new Date().toISOString().slice(0, 10); }
    S.els.push(el);
    S.sel = el.id;
    renderAllEls();
    const node = nodeFor(el.id);
    measureText(el, node);
    el.x -= kind === 'date' ? el.w / 2 : 0;
    el.y -= el.h / 2;
    clampEl(el);
    if (!at) avoidStacking(el);
    applyElStyle(node, el);
    if (kind === 'date') {
      S.undo.push(before);
      S.redo = [];
      setDirty(true);
      updateUndoUI();
      updateBadges();
    } else {
      startEdit(el, { snapshot: before, isNew: true, dirtyBefore: S.dirty });
    }
  }

  function deleteEl(id) {
    const el = getEl(id);
    if (!el) return;
    if (S.editing === id) { S.editing = null; }
    checkpoint();
    S.els = S.els.filter((e) => e.id !== id);
    if (S.sel === id) S.sel = null;
    renderAllEls();
  }

  function duplicateEl(id) {
    const el = getEl(id);
    if (!el) return;
    if (S.editing) finishEdit();
    checkpoint();
    const c = JSON.parse(JSON.stringify(el));
    c.id = uid('e');
    c.x += 12; c.y += 12;
    clampEl(c);
    S.els.push(c);
    S.sel = c.id;
    renderAllEls();
  }

  /* ------------------------------------------------------------------ */
  /* elements: DOM                                                      */
  /* ------------------------------------------------------------------ */
  function renderAllEls() {
    for (const p of S.pages) p.overlay.innerHTML = '';
    for (const el of S.els) {
      const p = S.pages[el.page];
      if (!p) continue;
      p.overlay.appendChild(buildNode(el));
    }
    measureAllText();
    updateBarPlacement();
    updateBadges();
    updateSelectionUI();
  }

  function buildNode(el) {
    const n = document.createElement('div');
    n.className = 'el';
    n.dataset.id = el.id;
    n.dataset.kind = el.kind;
    if (isText(el)) {
      const t = document.createElement('div');
      t.className = 'el-text';
      t.textContent = el.text;
      t.spellcheck = false;
      t.addEventListener('input', () => onTextInput(el.id));
      t.addEventListener('blur', () => { if (S.editing === el.id) finishEdit(); });
      t.addEventListener('paste', (e) => {
        e.preventDefault();
        const txt = (e.clipboardData.getData('text/plain') || '').replace(/\r\n?/g, '\n');
        document.execCommand('insertText', false, txt);
      });
      n.appendChild(t);
    } else {
      const img = document.createElement('img');
      img.draggable = false;
      img.alt = '';
      img.src = S.assets.get(el.asset).src;
      n.appendChild(img);
    }
    for (const c of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('div');
      h.className = 'h ' + c;
      h.dataset.corner = c;
      n.appendChild(h);
    }
    const bar = document.createElement('div');
    bar.className = 'el-bar';
    if (isText(el)) bar.appendChild(barBtn('i-pen', 'Edit text', () => { const e2 = getEl(el.id); if (e2) startEdit(e2); }));
    bar.appendChild(barBtn('i-copy', 'Duplicate (Ctrl+D)', () => duplicateEl(el.id)));
    bar.appendChild(barBtn('i-trash', 'Delete (Del)', () => deleteEl(el.id), true));
    n.appendChild(bar);
    applyElStyle(n, el);
    return n;
  }
  function barBtn(icon, title, fn, danger) {
    const b = document.createElement('button');
    b.title = title;
    if (danger) b.className = 'danger';
    b.innerHTML = `<svg class="ico"><use href="#${icon}"/></svg>`;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function applyElStyle(n, el) {
    if (!n) return;
    n.style.left = `calc(${el.x}px * var(--z))`;
    n.style.top = `calc(${el.y}px * var(--z))`;
    if (isText(el)) {
      const t = n.firstChild;
      t.style.fontSize = `calc(${el.fontSize}px * var(--z))`;
      t.style.fontFamily = FONT_CSS[el.font] || FONT_CSS.Helvetica;
      t.style.color = el.color;
      t.style.opacity = el.opacity;
      n.style.width = '';
      n.style.height = '';
    } else {
      n.style.width = `calc(${el.w}px * var(--z))`;
      n.style.height = `calc(${el.h}px * var(--z))`;
      n.firstChild.style.opacity = el.opacity;
    }
    n.classList.toggle('selected', S.sel === el.id);
    n.classList.toggle('bar-below', el.y * S.zoom < 48);
  }

  function measureText(el, node) {
    node = node || nodeFor(el.id);
    if (!node || !S.zoom) return;
    const r = node.firstChild.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    el.w = r.width / S.zoom;
    el.h = r.height / S.zoom;
  }
  function measureAllText() {
    for (const el of S.els) if (isText(el)) measureText(el);
  }
  function updateBarPlacement() {
    for (const el of S.els) {
      const n = nodeFor(el.id);
      if (n) n.classList.toggle('bar-below', el.y * S.zoom < 48);
    }
  }

  function updateBadges() {
    updateSigFieldVisibility();
    const counts = new Map();
    for (const el of S.els) counts.set(el.page, (counts.get(el.page) || 0) + 1);
    for (const p of S.pages) {
      let b = p.thumb.querySelector('.thumb-badge');
      const c = counts.get(p.index) || 0;
      if (c && !b) {
        b = document.createElement('div');
        b.className = 'thumb-badge';
        p.thumb.querySelector('.thumb-box').appendChild(b);
      }
      if (b) {
        if (c) b.textContent = c;
        else b.remove();
      }
    }
  }

  function select(id) {
    if (S.sel === id) return;
    if (S.editing && S.editing !== id) finishEdit();
    S.sel = id;
    for (const n of $$('.el', pagesEl)) n.classList.toggle('selected', n.dataset.id === id);
    updateSelectionUI();
  }

  /* ------------------------------------------------------------------ */
  /* text editing                                                       */
  /* ------------------------------------------------------------------ */
  function startEdit(el, opts = {}) {
    if (S.editing && S.editing !== el.id) finishEdit();
    const node = nodeFor(el.id);
    if (!node) return;
    const t = node.firstChild;
    S.editing = el.id;
    S.editSnapshot = opts.snapshot || snapshot();
    S.editIsNew = !!opts.isNew;
    S.editStartText = el.text;
    S.editDirtyBefore = opts.isNew ? opts.dirtyBefore : S.dirty;
    select(el.id);
    node.classList.add('editing');
    t.contentEditable = 'plaintext-only';
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    t.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(t);
    if (!opts.isNew && el.kind !== 'date') range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function readEditableText(t) {
    return (t.innerText || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/\n+$/, '');
  }

  function onTextInput(id) {
    const el = getEl(id);
    const node = nodeFor(id);
    if (!el || !node) return;
    el.text = readEditableText(node.firstChild);
    measureText(el, node);
    setDirty(true);
  }

  function finishEdit() {
    const id = S.editing;
    if (!id) return;
    S.editing = null;
    const el = getEl(id);
    const node = nodeFor(id);
    if (node) {
      node.classList.remove('editing');
      node.firstChild.contentEditable = 'false';
      node.firstChild.blur();
    }
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (!el) return;
    const txt = node ? readEditableText(node.firstChild) : el.text;
    if (!txt.trim()) {
      S.els = S.els.filter((e) => e.id !== id);
      if (S.sel === id) S.sel = null;
      if (!S.editIsNew) {
        S.undo.push(S.editSnapshot);
        S.redo = [];
        setDirty(true);
      } else {
        setDirty(!!S.editDirtyBefore);
      }
      renderAllEls();
      updateUndoUI();
      return;
    }
    el.text = txt;
    if (node) node.firstChild.textContent = txt;
    if (S.editIsNew || txt !== S.editStartText) {
      S.undo.push(S.editSnapshot);
      if (S.undo.length > 200) S.undo.shift();
      S.redo = [];
      setDirty(true);
    } else {
      setDirty(!!S.editDirtyBefore);
    }
    measureText(el, node);
    clampEl(el);
    applyElStyle(node, el);
    updateUndoUI();
    updateBadges();
    updateSelectionUI();
  }

  /* ------------------------------------------------------------------ */
  /* pointer interaction: move / resize                                 */
  /* ------------------------------------------------------------------ */
  pagesEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.el-bar')) return;
    const node = e.target.closest('.el');
    if (!node) {
      if (S.editing) finishEdit();
      select(null);
      return;
    }
    const el = getEl(node.dataset.id);
    if (!el) return;
    const handle = e.target.closest('.h');
    if (S.editing === el.id && !handle) return;
    if (S.editing) finishEdit();
    e.preventDefault();
    viewer.focus({ preventScroll: true });
    const wasSelected = S.sel === el.id;
    select(el.id);
    if (handle) startResize(e, el, node, handle.dataset.corner);
    else startDrag(e, el, node, wasSelected);
  });

  pagesEl.addEventListener('dblclick', (e) => {
    const node = e.target.closest('.el');
    if (!node) return;
    const el = getEl(node.dataset.id);
    if (el && isText(el) && S.editing !== el.id) startEdit(el);
  });

  function autoScroll(ev) {
    const vr = viewer.getBoundingClientRect();
    const edge = 36;
    if (ev.clientY < vr.top + edge) viewer.scrollTop -= 14;
    else if (ev.clientY > vr.bottom - edge) viewer.scrollTop += 14;
    if (ev.clientX < vr.left + edge) viewer.scrollLeft -= 14;
    else if (ev.clientX > vr.right - edge) viewer.scrollLeft += 14;
  }

  function startDrag(e, el, node, wasSelected) {
    const sx = e.clientX, sy = e.clientY;
    const r0 = S.pages[el.page].div.getBoundingClientRect();
    const grabX = (e.clientX - r0.left) / S.zoom - el.x;
    const grabY = (e.clientY - r0.top) / S.zoom - el.y;
    let moved = false;
    const move = (ev) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
        moved = true;
        checkpoint();
        node.classList.add('dragging');
      }
      autoScroll(ev);
      let pi = nearestPageAt(ev.clientX, ev.clientY);
      if (pi < 0) pi = el.page;
      const r = S.pages[pi].div.getBoundingClientRect();
      el.x = (ev.clientX - r.left) / S.zoom - grabX;
      el.y = (ev.clientY - r.top) / S.zoom - grabY;
      if (pi !== el.page) {
        el.page = pi;
        S.pages[pi].overlay.appendChild(node);
      }
      clampEl(el);
      applyElStyle(node, el);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      node.classList.remove('dragging');
      if (moved) {
        updateBadges();
        setCurrent(el.page);
      } else if (wasSelected && isText(el)) {
        startEdit(el);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function startResize(e, el, node, corner) {
    const sx = e.clientX, sy = e.clientY;
    const x0 = el.x, y0 = el.y, w0 = el.w, h0 = el.h, fs0 = el.fontSize;
    const east = corner.includes('e');
    const south = corner.includes('s');
    const { w: pw, h: ph } = pageDims(el.page);
    let started = false;
    const move = (ev) => {
      if (!started) { started = true; checkpoint(); node.classList.add('dragging'); }
      const dx = (ev.clientX - sx) / S.zoom * (east ? 1 : -1);
      const dy = (ev.clientY - sy) / S.zoom * (south ? 1 : -1);
      let s = ((w0 + dx) / w0 + (h0 + dy) / h0) / 2;
      const maxW = east ? pw - x0 : x0 + w0;
      const maxH = south ? ph - y0 : y0 + h0;
      s = Math.min(s, maxW / w0, maxH / h0);
      const minSize = isText(el) ? 4 / fs0 : Math.max(6 / w0, 6 / h0);
      s = Math.max(s, minSize);
      if (isText(el)) {
        el.fontSize = Math.round(Math.min(300, Math.max(4, fs0 * s)) * 10) / 10;
        s = el.fontSize / fs0;
      }
      const w = w0 * s, h = h0 * s;
      el.x = east ? x0 : x0 + w0 - w;
      el.y = south ? y0 : y0 + h0 - h;
      if (!isText(el)) { el.w = w; el.h = h; }
      applyElStyle(node, el);
      if (isText(el)) measureText(el, node);
      if (S.sel === el.id) updatePropsValues();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      node.classList.remove('dragging');
      if (started) {
        if (isText(el)) { measureText(el, node); prefs.textSize = Math.round(el.fontSize); savePrefs(); }
        clampEl(el);
        applyElStyle(node, el);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /* ------------------------------------------------------------------ */
  /* properties panel                                                   */
  /* ------------------------------------------------------------------ */
  let propCheckpointDone = false;
  function propCheckpoint() {
    if (!propCheckpointDone) { checkpoint(); propCheckpointDone = true; }
  }
  function propCommitEnd() { propCheckpointDone = false; }

  function updateSelectionUI() {
    const el = S.sel ? getEl(S.sel) : null;
    const props = $('#props');
    props.hidden = !el;
    $('#tool-tip').hidden = !!el;
    if (!el) return;
    $('#props-title').textContent = KIND_LABEL[el.kind] || 'Selected';
    const text = isText(el);
    $('#props-text').hidden = !text;
    $('#props-date').hidden = el.kind !== 'date';
    const asset = el.baseAsset ? S.assets.get(el.baseAsset) : null;
    const colorable = text || MARK_KINDS.has(el.kind) || ((el.kind === 'signature' || el.kind === 'initials') && asset && asset.transparent);
    $('#props-color').hidden = !colorable;
    if (colorable) {
      const palette = text ? TEXT_COLORS : INK_COLORS;
      swatches($('#prop-colors'), palette, el.color || (text ? '#000000' : null), (c) => setElColor(el.id, c));
    }
    if (el.kind === 'date') {
      const sel = $('#prop-date-format');
      sel.innerHTML = '';
      const d = el.dateISO ? new Date(el.dateISO + 'T12:00:00') : new Date();
      for (const f of DATE_FORMATS) {
        const o = document.createElement('option');
        o.value = f;
        o.textContent = formatDate(d, f);
        sel.appendChild(o);
      }
      sel.value = el.dateFormat || prefs.dateFormat;
    }
    updatePropsValues();
  }
  function updatePropsValues() {
    const el = S.sel ? getEl(S.sel) : null;
    if (!el) return;
    if (isText(el)) {
      const sz = $('#prop-size');
      sz.value = Math.round(el.fontSize);
      $('#prop-size-val').textContent = Math.round(el.fontSize * 10) / 10;
      for (const b of $$('#prop-font button')) b.classList.toggle('active', b.dataset.font === el.font);
    }
    $('#prop-opacity').value = Math.round(el.opacity * 100);
    $('#prop-opacity-val').textContent = Math.round(el.opacity * 100);
  }

  async function setElColor(id, color) {
    const el = getEl(id);
    if (!el) return;
    if (S.editing && S.editing !== id) finishEdit();
    propCheckpoint();
    el.color = color;
    if (isText(el)) {
      prefs.textColor = color;
    } else if (MARK_KINDS.has(el.kind)) {
      el.asset = el.baseAsset = markAsset(el.kind, color);
      prefs.markColor = color;
    } else {
      el.asset = await tintedAsset(el.baseAsset, color);
    }
    savePrefs();
    const node = nodeFor(id);
    if (node && !isText(el)) node.firstChild.src = S.assets.get(el.asset).src;
    applyElStyle(node, el);
    clearTimeout(setElColor.t);
    setElColor.t = setTimeout(propCommitEnd, 600);
  }

  $('#prop-size').addEventListener('input', (e) => {
    const el = getEl(S.sel);
    if (!el || !isText(el)) return;
    propCheckpoint();
    el.fontSize = +e.target.value;
    $('#prop-size-val').textContent = el.fontSize;
    const n = nodeFor(el.id);
    applyElStyle(n, el);
    measureText(el, n);
    clampEl(el);
    applyElStyle(n, el);
    prefs.textSize = el.fontSize;
  });
  $('#prop-size').addEventListener('change', () => { propCommitEnd(); savePrefs(); });
  $('#prop-opacity').addEventListener('input', (e) => {
    const el = getEl(S.sel);
    if (!el) return;
    propCheckpoint();
    el.opacity = +e.target.value / 100;
    $('#prop-opacity-val').textContent = e.target.value;
    applyElStyle(nodeFor(el.id), el);
  });
  $('#prop-opacity').addEventListener('change', propCommitEnd);
  $('#prop-font').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const el = getEl(S.sel);
    if (!b || !el || !isText(el) || el.font === b.dataset.font) return;
    checkpoint();
    el.font = b.dataset.font;
    prefs.textFont = el.font;
    savePrefs();
    const n = nodeFor(el.id);
    applyElStyle(n, el);
    measureText(el, n);
    clampEl(el);
    applyElStyle(n, el);
    updatePropsValues();
  });
  $('#prop-date-format').addEventListener('change', (e) => {
    const el = getEl(S.sel);
    if (!el || el.kind !== 'date') return;
    if (S.editing) finishEdit();
    checkpoint();
    el.dateFormat = e.target.value;
    prefs.dateFormat = el.dateFormat;
    savePrefs();
    const d = el.dateISO ? new Date(el.dateISO + 'T12:00:00') : new Date();
    el.text = formatDate(d, el.dateFormat);
    const n = nodeFor(el.id);
    n.firstChild.textContent = el.text;
    measureText(el, n);
    clampEl(el);
    applyElStyle(n, el);
  });
  $('#prop-dup').onclick = () => S.sel && duplicateEl(S.sel);
  $('#prop-del').onclick = () => S.sel && deleteEl(S.sel);

  /* ------------------------------------------------------------------ */
  /* saved signatures                                                   */
  /* ------------------------------------------------------------------ */
  let saved = lsGet(LS.saved, []);
  if (!Array.isArray(saved)) saved = [];

  function addSaved(kind, src, w, h, transparent) {
    if (saved.some((s) => s.src === src)) return;
    saved.unshift({ id: uid('s'), kind, src, w, h, transparent, created: Date.now() });
    const sameKind = saved.filter((s) => s.kind === kind);
    if (sameKind.length > 12) {
      const drop = new Set(sameKind.slice(12).map((s) => s.id));
      saved = saved.filter((s) => !drop.has(s.id));
    }
    if (!lsSet(LS.saved, saved)) {
      saved.shift();
      toast("Couldn't save the signature for later — storage is full. Delete an old one and try again.", { error: true });
    }
    renderSaved();
  }
  function removeSaved(id) {
    saved = saved.filter((s) => s.id !== id);
    lsSet(LS.saved, saved);
    renderSaved();
  }
  function renderSaved() {
    for (const kind of ['signature', 'initials']) {
      const box = kind === 'signature' ? $('#saved-signatures') : $('#saved-initials');
      box.innerHTML = '';
      const list = saved.filter((s) => s.kind === kind);
      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'saved-empty';
        e.textContent = kind === 'signature' ? 'No saved signatures yet.' : 'No saved initials yet.';
        box.appendChild(e);
        continue;
      }
      for (const s of list) {
        const it = document.createElement('div');
        it.className = 'saved-item';
        it.title = 'Click to add, or drag onto the page';
        it.draggable = true;
        const img = document.createElement('img');
        img.src = s.src;
        img.alt = kind;
        const x = document.createElement('button');
        x.className = 'x';
        x.title = 'Delete';
        x.innerHTML = '<svg class="ico"><use href="#i-close"/></svg>';
        x.onclick = async (e) => {
          e.stopPropagation();
          const r = await dialog({
            title: kind === 'signature' ? 'Delete saved signature?' : 'Delete saved initials?',
            message: 'It will be removed from your saved list. Items already placed on the document stay.',
            buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: 'Delete', value: true, primary: true }],
          });
          if (r) removeSaved(s.id);
        };
        it.append(img, x);
        it.onclick = () => useSaved(s);
        it.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-pdfsig', s.id);
          e.dataTransfer.effectAllowed = 'copy';
          try { e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2); } catch (_) { /* */ }
        });
        box.appendChild(it);
      }
    }
  }
  async function useSaved(s, at) {
    if (!S.pages.length) return;
    const id = await assetFromSrc(s.src, s.transparent !== false);
    addImageElement(s.kind, id, at);
  }

  /* ------------------------------------------------------------------ */
  /* signature dialog                                                   */
  /* ------------------------------------------------------------------ */
  const Sig = { kind: 'signature', tab: prefs.sigTab, strokes: [], cur: null, uploadImg: null, uploadCanvas: null, font: prefs.typeFont };
  const sigModal = $('#sig-modal');
  const drawCanvas = $('#draw-canvas');
  const drawWrap = $('#draw-wrap');

  function openSig(kind) {
    if (!S.pages.length) return;
    if (S.editing) finishEdit();
    Sig.kind = kind;
    Sig.strokes = [];
    Sig.cur = null;
    for (const b of $$('#sig-kind button')) b.classList.toggle('active', b.dataset.kind === kind);
    sigModal.hidden = false;
    setSigTab(Sig.tab);
    applyKindTexts();
    sizeDrawCanvas();
    updateSigInsert();
  }
  function closeSig() {
    sigModal.hidden = true;
    S.pendingSigField = null;
  }
  function applyKindTexts() {
    const ini = Sig.kind === 'initials';
    $('#sig-title').textContent = ini ? 'Create initials' : 'Create signature';
    $('#draw-placeholder').textContent = ini ? 'Draw your initials here' : 'Draw your signature here';
    const ti = $('#type-input');
    if (ini) {
      const fromName = (prefs.typeName || '').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('');
      ti.value = prefs.typeInitials || fromName;
      ti.placeholder = 'Type your initials';
    } else {
      ti.value = prefs.typeName || '';
      ti.placeholder = 'Type your name';
    }
    renderFontGrid();
  }
  function setSigTab(tab) {
    Sig.tab = tab;
    prefs.sigTab = tab;
    savePrefs();
    for (const b of $$('#sig-tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of $$('.tab-panel', sigModal)) p.hidden = p.dataset.panel !== tab;
    if (tab === 'draw') sizeDrawCanvas();
    if (tab === 'type') { renderFontGrid(); setTimeout(() => $('#type-input').focus(), 20); }
    updateSigInsert();
  }
  function updateSigInsert() {
    let ok = false;
    if (Sig.tab === 'draw') ok = Sig.strokes.length > 0;
    else if (Sig.tab === 'type') ok = $('#type-input').value.trim().length > 0;
    else ok = !!Sig.uploadCanvas;
    $('#sig-insert').disabled = !ok;
    $('#draw-placeholder').hidden = Sig.strokes.length > 0;
  }

  /* --- draw --- */
  function sizeDrawCanvas() {
    if (sigModal.hidden || Sig.tab !== 'draw') return;
    const r = drawWrap.getBoundingClientRect();
    if (!r.width) return;
    drawCanvas.width = Math.round(r.width * dpr());
    drawCanvas.height = Math.round(r.height * dpr());
    redrawCanvas();
  }
  function redrawCanvas() {
    const ctx = drawCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    for (const s of Sig.strokes) drawStroke(ctx, s);
  }
  function drawStroke(ctx, s) {
    const pts = s.pts;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (!pts.length) return;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, (s.width * pts[0].w) / 2 + 0.3, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (pts.length === 2) {
      ctx.lineWidth = s.width * (pts[0].w + pts[1].w) / 2;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      return;
    }
    let px = pts[0].x, py = pts[0].y;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.lineWidth = s.width * pts[i].w;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      ctx.stroke();
      px = mx; py = my;
    }
    const last = pts[pts.length - 1];
    ctx.lineWidth = s.width * last.w;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  function addDrawPoint(ev) {
    const r = drawCanvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    const s = Sig.cur;
    const last = s.pts[s.pts.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 0.7) return;
    let w;
    if (ev.pointerType === 'pen' && ev.pressure > 0) {
      w = 0.35 + ev.pressure * 1.3;
      if (last) w = last.w * 0.6 + w * 0.4;
    } else if (!last) {
      w = 1.05;
    } else {
      const dt = Math.max(1, ev.timeStamp - last.t);
      const v = Math.hypot(x - last.x, y - last.y) / dt;
      const target = Math.max(0.55, Math.min(1.25, 1.3 - v * 0.32));
      w = last.w * 0.72 + target * 0.28;
    }
    s.pts.push({ x, y, t: ev.timeStamp, w });
  }
  let drawRaf = 0;
  function requestRedraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => { drawRaf = 0; redrawCanvas(); });
  }
  drawCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    drawCanvas.setPointerCapture(e.pointerId);
    Sig.cur = { color: prefs.inkColor, width: prefs.inkWidth, pts: [] };
    Sig.strokes.push(Sig.cur);
    addDrawPoint(e);
    requestRedraw();
    updateSigInsert();
  });
  drawCanvas.addEventListener('pointermove', (e) => {
    if (!Sig.cur) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (evs.length) for (const ce of evs) addDrawPoint(ce);
    else addDrawPoint(e);
    requestRedraw();
  });
  const endStroke = () => { Sig.cur = null; requestRedraw(); updateSigInsert(); };
  drawCanvas.addEventListener('pointerup', endStroke);
  drawCanvas.addEventListener('pointercancel', endStroke);
  drawCanvas.addEventListener('lostpointercapture', () => { if (Sig.cur) endStroke(); });
  $('#draw-undo').onclick = () => { Sig.strokes.pop(); redrawCanvas(); updateSigInsert(); };
  $('#draw-clear').onclick = () => { Sig.strokes = []; redrawCanvas(); updateSigInsert(); };
  $('#draw-width').value = prefs.inkWidth;
  $('#draw-width').oninput = (e) => { prefs.inkWidth = +e.target.value; savePrefs(); };
  function renderInkSwatches() {
    swatches($('#draw-colors'), INK_COLORS, prefs.inkColor, (c) => {
      prefs.inkColor = c;
      savePrefs();
      for (const s of Sig.strokes) s.color = c;
      redrawCanvas();
    });
  }

  function exportDrawing() {
    if (!Sig.strokes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of Sig.strokes) {
      for (const p of s.pts) {
        const r = (s.width * p.w) / 2 + 2;
        minX = Math.min(minX, p.x - r); minY = Math.min(minY, p.y - r);
        maxX = Math.max(maxX, p.x + r); maxY = Math.max(maxY, p.y + r);
      }
    }
    const K = 4;
    const c = document.createElement('canvas');
    c.width = Math.ceil((maxX - minX) * K);
    c.height = Math.ceil((maxY - minY) * K);
    const ctx = c.getContext('2d');
    ctx.setTransform(K, 0, 0, K, -minX * K, -minY * K);
    for (const s of Sig.strokes) drawStroke(ctx, s);
    return trimCanvas(c, 4);
  }

  /* --- type --- */
  function renderFontGrid() {
    const grid = $('#font-grid');
    const text = $('#type-input').value.trim() || (Sig.kind === 'initials' ? 'AB' : 'Your Name');
    if (!grid.children.length) {
      for (const f of SIG_FONTS) {
        const b = document.createElement('button');
        b.className = 'font-card';
        b.dataset.font = f;
        b.style.fontFamily = `"${f}", cursive`;
        b.title = f;
        b.onclick = () => { Sig.font = f; prefs.typeFont = f; savePrefs(); renderFontGrid(); };
        grid.appendChild(b);
      }
    }
    for (const b of grid.children) {
      b.textContent = text;
      b.classList.toggle('active', b.dataset.font === Sig.font);
      b.style.color = prefs.typeColor;
      b.style.fontSize = '32px';
      if (b.scrollWidth > b.clientWidth - 4) {
        const fs = Math.max(12, Math.floor(32 * (b.clientWidth - 28) / b.scrollWidth));
        b.style.fontSize = fs + 'px';
      }
    }
  }
  $('#type-input').addEventListener('input', (e) => {
    if (Sig.kind === 'initials') prefs.typeInitials = e.target.value;
    else prefs.typeName = e.target.value;
    savePrefs();
    renderFontGrid();
    updateSigInsert();
  });
  $('#type-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#sig-insert').disabled) { e.preventDefault(); sigInsert(); }
  });
  function renderTypeSwatches() {
    swatches($('#type-colors'), INK_COLORS, prefs.typeColor, (c) => { prefs.typeColor = c; savePrefs(); renderFontGrid(); });
  }
  async function exportTyped() {
    const text = $('#type-input').value.trim();
    if (!text) return null;
    const fs = 160;
    const font = `${fs}px "${Sig.font}"`;
    try { await document.fonts.load(font, text); } catch (_) { /* */ }
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const m = probe.measureText(text);
    const left = Math.ceil(m.actualBoundingBoxLeft || 0);
    const right = Math.ceil(m.actualBoundingBoxRight || m.width);
    const asc = Math.ceil(m.actualBoundingBoxAscent || fs);
    const desc = Math.ceil(m.actualBoundingBoxDescent || fs * 0.3);
    const pad = Math.ceil(fs * 0.25);
    const c = document.createElement('canvas');
    c.width = Math.max(1, left + right + pad * 2);
    c.height = Math.max(1, asc + desc + pad * 2);
    const ctx = c.getContext('2d');
    ctx.font = font;
    ctx.fillStyle = prefs.typeColor;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, pad + left, pad + asc);
    return trimCanvas(c, 6);
  }

  /* --- upload --- */
  function processUpload() {
    const img = Sig.uploadImg;
    if (!img) return;
    const maxDim = 1600;
    const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if ($('#upload-removebg').checked) removeBackground(ctx, c.width, c.height);
    let out = c;
    if ($('#upload-trim').checked) out = trimCanvas(c, 6) || c;
    Sig.uploadCanvas = out;
    const prev = $('#upload-preview');
    prev.src = out.toDataURL('image/png');
    prev.hidden = false;
    $('#upload-empty').hidden = true;
    $('#upload-change').hidden = false;
    updateSigInsert();
  }
  function removeBackground(ctx, w, h) {
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    const n = w * h;
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = d[o + 3];
      const lum = a === 0 ? 255 : Math.round(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]);
      hist[lum]++;
    }
    // paper brightness = 75th percentile of luminance
    let acc = 0, paper = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.75) { paper = v; break; } }
    const hi = Math.max(60, paper - 18);
    const lo = Math.max(0, hi - 85);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const lum = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      let alpha;
      if (lum >= hi) alpha = 0;
      else if (lum <= lo) alpha = 1;
      else alpha = (hi - lum) / (hi - lo);
      d[o + 3] = Math.round(d[o + 3] * alpha);
      // deepen faint ink so it reads well once the paper is gone
      if (alpha > 0 && alpha < 1) {
        const f = 0.55;
        d[o] = Math.round(d[o] * f); d[o + 1] = Math.round(d[o + 1] * f); d[o + 2] = Math.round(d[o + 2] * f);
      }
    }
    ctx.putImageData(id, 0, 0);
  }
  async function loadUploadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name)) {
      toast('Please choose an image file (PNG, JPG, WEBP, BMP or GIF).', { error: true });
      return;
    }
    try {
      const src = await readFileAsDataURL(file);
      Sig.uploadImg = await loadImage(src);
      $('#upload-removebg').checked = !/png|webp|gif/i.test(file.type) || !(await imageHasAlpha(Sig.uploadImg));
      processUpload();
    } catch (e) {
      toast(errMsg(e), { error: true });
    }
  }
  async function imageHasAlpha(img) {
    const c = document.createElement('canvas');
    const k = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return canvasHasTransparency(c);
  }
  $('#upload-choose').onclick = (e) => { e.stopPropagation(); $('#file-sig-img').value = ''; $('#file-sig-img').click(); };
  $('#upload-change').onclick = () => { $('#file-sig-img').value = ''; $('#file-sig-img').click(); };
  $('#upload-zone').addEventListener('click', (e) => { if (!Sig.uploadImg && e.target === e.currentTarget) $('#file-sig-img').click(); });
  $('#file-sig-img').addEventListener('change', (e) => loadUploadFile(e.target.files[0]));
  $('#upload-removebg').onchange = processUpload;
  $('#upload-trim').onchange = processUpload;
  const uz = $('#upload-zone');
  uz.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); uz.classList.add('over'); e.dataTransfer.dropEffect = 'copy'; } });
  uz.addEventListener('dragleave', () => uz.classList.remove('over'));
  uz.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    uz.classList.remove('over');
    loadUploadFile(e.dataTransfer.files[0]);
  });

  async function sigInsert() {
    let c = null;
    if (Sig.tab === 'draw') c = exportDrawing();
    else if (Sig.tab === 'type') c = await exportTyped();
    else c = Sig.uploadCanvas;
    if (!c) { toast('Nothing to insert yet.', { error: true }); return; }
    const src = c.toDataURL('image/png');
    const transparent = canvasHasTransparency(c);
    const id = addAsset(src, c.width, c.height, { transparent });
    if ($('#sig-save').checked) {
      let ssrc = src, sw = c.width, sh = c.height;
      if (c.width > 1400) {
        const k = 1400 / c.width;
        const sc = document.createElement('canvas');
        sc.width = 1400; sc.height = Math.max(1, Math.round(c.height * k));
        sc.getContext('2d').drawImage(c, 0, 0, sc.width, sc.height);
        ssrc = sc.toDataURL('image/png'); sw = sc.width; sh = sc.height;
        addAsset(ssrc, sw, sh, { transparent });
      }
      addSaved(Sig.kind, ssrc, sw, sh, transparent);
    }
    const field = S.pendingSigField;
    closeSig();
    addImageElement(Sig.kind, id, null, {}, field);
  }

  $('#sig-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSigTab(b.dataset.tab); });
  $('#sig-kind').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.kind === Sig.kind) return;
    Sig.kind = b.dataset.kind;
    for (const x of $$('#sig-kind button')) x.classList.toggle('active', x === b);
    applyKindTexts();
    updateSigInsert();
  });
  $('#sig-insert').onclick = sigInsert;
  for (const b of $$('[data-close]', sigModal)) b.onclick = closeSig;
  sigModal.addEventListener('pointerdown', (e) => { if (e.target === sigModal) closeSig(); });

  /* ------------------------------------------------------------------ */
  /* adding images & marks                                              */
  /* ------------------------------------------------------------------ */
  async function addImageFromFile(file, at) {
    try {
      const src0 = await readFileAsDataURL(file);
      const img = await loadImage(src0);
      const maxDim = 2400;
      const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const transparent = canvasHasTransparency(c);
      const src = transparent ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92);
      const id = addAsset(src, c.width, c.height, { transparent, mime: transparent ? 'image/png' : 'image/jpeg' });
      addImageElement('image', id, at);
    } catch (e) {
      toast(errMsg(e), { error: true });
    }
  }

  function addFill(kind) {
    if (!S.pages.length) return;
    if (kind === 'text' || kind === 'date') return addTextElement(kind, null);
    if (kind === 'image') { $('#file-img').value = ''; $('#file-img').click(); return; }
    const color = prefs.markColor || '#000000';
    const id = markAsset(kind, color);
    addImageElement(kind, id, null, { color });
  }
  $$('[data-add]').forEach((b) => { b.onclick = () => addFill(b.dataset.add); });
  $('#file-img').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) addImageFromFile(f, null); });
  $('#tool-signature').onclick = () => openSig('signature');
  $('#tool-initials').onclick = () => openSig('initials');

  /* ------------------------------------------------------------------ */
  /* saving                                                             */
  /* ------------------------------------------------------------------ */
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#000000');
    const n = m ? parseInt(m[1], 16) : 0;
    return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  const PDF_FONT = { Helvetica: 'Helvetica', Times: 'TimesRoman', Courier: 'Courier' };

  function rasterizeText(el) {
    const K = 4;
    const lines = el.text.split('\n');
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(el.w * K));
    c.height = Math.max(1, Math.ceil(el.h * K));
    const ctx = c.getContext('2d');
    ctx.font = `${el.fontSize * K}px ${FONT_CSS[el.font] || FONT_CSS.Helvetica}`;
    ctx.fillStyle = el.color || '#000';
    ctx.textBaseline = 'alphabetic';
    const tm = textMetrics(el);
    lines.forEach((ln, i) => ctx.fillText(ln, 0, (tm.first + i * tm.step) * K));
    return c.toDataURL('image/png');
  }

  async function drawElements(pdfDoc, pageFor, mapFor) {
    const { degrees } = PDFLib;
    const imgCache = new Map();
    const fontCache = new Map();
    const embedAsset = async (assetId, srcOverride) => {
      const key = srcOverride || assetId;
      if (imgCache.has(key)) return imgCache.get(key);
      const a = srcOverride ? { src: srcOverride, mime: 'image/png' } : S.assets.get(assetId);
      const bytes = dataUrlToBytes(a.src);
      const img = a.mime === 'image/jpeg' ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
      imgCache.set(key, img);
      return img;
    };
    const getFont = async (name) => {
      if (fontCache.has(name)) return fontCache.get(name);
      const f = await pdfDoc.embedFont(PDFLib.StandardFonts[PDF_FONT[name] || 'Helvetica']);
      fontCache.set(name, f);
      return f;
    };
    for (const el of S.els) {
      const page = pageFor(el.page);
      const map = mapFor(el.page);
      const rot = degrees(map.rotation);
      if (!isText(el)) {
        const img = await embedAsset(el.asset);
        const [x, y] = map.toPdf(el.x, el.y + el.h);
        page.drawImage(img, { x, y, width: el.w, height: el.h, rotate: rot, opacity: el.opacity });
        continue;
      }
      if (!el.text) continue;
      const font = await getFont(el.font);
      const lines = el.text.split('\n');
      let encodable = true;
      try { for (const ln of lines) font.encodeText(ln); } catch (_) { encodable = false; }
      if (!encodable) {
        const img = await embedAsset(null, rasterizeText(el));
        const [x, y] = map.toPdf(el.x, el.y + el.h);
        page.drawImage(img, { x, y, width: el.w, height: el.h, rotate: rot, opacity: el.opacity });
        continue;
      }
      const tm = textMetrics(el);
      const color = hexToRgb(el.color);
      lines.forEach((ln, i) => {
        if (!ln) return;
        const [x, y] = map.toPdf(el.x, el.y + tm.first + i * tm.step);
        page.drawText(ln, { x, y, size: el.fontSize, font, color, rotate: rot, opacity: el.opacity });
      });
    }
  }

  /** pdf.js stores a filled-in value on the widget; move it to the field itself so every PDF reader sees it. */
  function normalizeFieldValues(pdfDoc) {
    const { PDFName, PDFDict } = PDFLib;
    const V = PDFName.of('V'), T = PDFName.of('T'), Parent = PDFName.of('Parent');
    for (const page of pdfDoc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const w = annots.lookupMaybe(i, PDFDict);
        if (!w || w.has(T)) continue;
        const val = w.get(V);
        if (!val) continue;
        const parent = w.lookupMaybe(Parent, PDFDict);
        if (!parent) continue;
        parent.set(V, val);
        w.delete(V);
      }
    }
  }

  async function buildDirect() {
    const { PDFDocument } = PDFLib;
    let src = S.bytes;
    if (S.doc.annotationStorage.size > 0) {
      try {
        src = await S.doc.saveDocument();
      } catch (e) {
        throw Object.assign(new Error('Could not write the form field values: ' + errMsg(e)), { fallback: true });
      }
    }
    const pdfDoc = await PDFDocument.load(src, { updateMetadata: false });
    if (src !== S.bytes) normalizeFieldValues(pdfDoc);
    if (pdfDoc.getPageCount() !== S.pages.length) throw Object.assign(new Error('Page count mismatch'), { fallback: true });
    const pages = pdfDoc.getPages();
    await drawElements(
      pdfDoc,
      (i) => pages[i],
      (i) => {
        const vp = S.pages[i].vp1;
        return { rotation: vp.rotation, toPdf: (x, y) => vp.convertToPdfPoint(x, y) };
      },
    );
    return pdfDoc.save();
  }

  async function buildFlattened() {
    const { PDFDocument } = PDFLib;
    const out = await PDFDocument.create();
    const pages = [];
    for (const p of S.pages) {
      const { width: W, height: H } = p.vp1;
      let scale = 200 / 72;
      const maxPx = 14e6;
      if (W * H * scale * scale > maxPx) scale = Math.sqrt(maxPx / (W * H));
      const vp = p.proxy.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await p.proxy.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
      const jpg = await out.embedJpg(dataUrlToBytes(c.toDataURL('image/jpeg', 0.9)));
      c.width = 0;
      const pg = out.addPage([W, H]);
      pg.drawImage(jpg, { x: 0, y: 0, width: W, height: H });
      pages.push(pg);
    }
    await drawElements(
      out,
      (i) => pages[i],
      (i) => {
        const H = S.pages[i].vp1.height;
        return { rotation: 0, toPdf: (x, y) => [x, H - y] };
      },
    );
    return out.save();
  }

  async function buildPdf() {
    if (S.editing) finishEdit();
    measureAllText();
    let useFlatten = S.needsPassword;
    let reason = 'This PDF is password-protected.';
    if (!useFlatten) {
      try {
        busy(true, 'Saving…');
        return await buildDirect();
      } catch (e) {
        console.warn('Direct save failed', e);
        const msg = String((e && e.message) || '');
        if (/encrypt/i.test(msg) || (e && e.constructor && e.constructor.name === 'EncryptedPDFError')) reason = 'This PDF is protected with editing restrictions.';
        else reason = 'This PDF has an unusual internal structure that can\'t be edited directly.';
        useFlatten = true;
      } finally {
        busy(false);
      }
    }
    const ok = await dialog({
      title: 'Save as flattened copy?',
      message: `${reason}\n\nPDF Signature can still save it, but each page will be stored as a high-resolution image with your signature on top. The text in the saved copy won't be selectable or searchable.`,
      buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: 'Save flattened copy', value: true, primary: true }],
    });
    if (!ok) return null;
    busy(true, 'Saving…');
    try {
      return await buildFlattened();
    } finally {
      busy(false);
    }
  }

  function signedName() {
    const base = (S.name || 'document.pdf').replace(/\.pdf$/i, '');
    return /[-_ ]signed$/i.test(base) ? `${base}.pdf` : `${base}-signed.pdf`;
  }

  async function save() {
    if (!S.doc) return false;
    if (isDesktop && S.savedPath) return saveTo(S.savedPath);
    return saveAs();
  }

  async function saveTo(target) {
    try {
      const bytes = await buildPdf();
      if (!bytes) return false;
      busy(true, 'Saving…');
      try { await api.writeFile(target, bytes); } finally { busy(false); }
      afterSaved(target);
      return true;
    } catch (e) {
      console.error(e);
      toast(`Couldn't save: ${errMsg(e)}`, { error: true, duration: 8000 });
      return false;
    }
  }

  async function saveAs() {
    if (!S.doc) return false;
    try {
      const bytes = await buildPdf();
      if (!bytes) return false;
      if (isDesktop) {
        let def = signedName();
        const ref = S.savedPath || S.path;
        if (ref) {
          const info = await api.pathInfo(ref);
          def = info.dir + info.sep + (S.savedPath ? info.base : signedName());
        }
        const p = await api.saveDialog(def, bytes);
        if (!p) return false;
        afterSaved(p);
      } else {
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = signedName();
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        if (S.doc) S.doc.annotationStorage.resetModified();
        setDirty(false);
        toast(`Downloaded ${a.download}`);
      }
      return true;
    } catch (e) {
      console.error(e);
      toast(`Couldn't save: ${errMsg(e)}`, { error: true, duration: 8000 });
      return false;
    }
  }

  function afterSaved(p) {
    S.savedPath = p;
    if (S.doc) S.doc.annotationStorage.resetModified();
    setDirty(false);
    const name = p.split(/[\\/]/).pop();
    addRecent(p, name);
    toast(`Saved ${name}`, {
      actions: [
        { label: 'Show in folder', run: () => api.showInFolder(p) },
        { label: 'Open', run: () => api.openPath(p) },
      ],
    });
  }

  /* ------------------------------------------------------------------ */
  /* recent files                                                       */
  /* ------------------------------------------------------------------ */
  function getRecent() { const r = lsGet(LS.recent, []); return Array.isArray(r) ? r : []; }
  function addRecent(path, name) {
    if (!isDesktop || !path) return;
    const r = getRecent().filter((x) => x.path.toLowerCase() !== path.toLowerCase());
    r.unshift({ path, name, time: Date.now() });
    lsSet(LS.recent, r.slice(0, 10));
  }
  function removeRecent(path) {
    lsSet(LS.recent, getRecent().filter((x) => x.path !== path));
    renderRecent();
  }
  function renderRecent() {
    const list = isDesktop ? getRecent() : [];
    $('#recent-wrap').hidden = !list.length;
    const ul = $('#recent-list');
    ul.innerHTML = '';
    for (const r of list) {
      const li = document.createElement('li');
      li.title = r.path;
      li.innerHTML = '<svg class="ico"><use href="#i-file"/></svg><div class="r-text"><div class="r-name"></div><div class="r-path"></div></div>';
      li.querySelector('.r-name').textContent = r.name;
      li.querySelector('.r-path').textContent = r.path;
      const x = document.createElement('button');
      x.className = 'icon-btn r-remove';
      x.title = 'Remove from list';
      x.innerHTML = '<svg class="ico"><use href="#i-close"/></svg>';
      x.onclick = (e) => { e.stopPropagation(); removeRecent(r.path); };
      li.appendChild(x);
      li.onclick = () => openPath(r.path);
      ul.appendChild(li);
    }
  }
  $('#recent-clear').onclick = () => { lsSet(LS.recent, []); renderRecent(); };

  /* ------------------------------------------------------------------ */
  /* drag & drop                                                        */
  /* ------------------------------------------------------------------ */
  function hasFiles(e) { return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); }
  function draggedKinds(e) {
    const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []);
    return {
      pdf: items.some((i) => i.kind === 'file' && i.type === 'application/pdf'),
      image: items.some((i) => i.kind === 'file' && /^image\//.test(i.type)),
    };
  }
  const isPdfFile = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const isImageFile = (f) => f && (/^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
  let dropHighlight = null;
  function highlightPage(i) {
    if (dropHighlight === i) return;
    if (dropHighlight != null && S.pages[dropHighlight]) S.pages[dropHighlight].div.classList.remove('drop-target');
    dropHighlight = i;
    if (i != null && S.pages[i]) S.pages[i].div.classList.add('drop-target');
  }
  const dragOverlay = $('#drag-overlay');
  const modalOpen = () => !sigModal.hidden || isDialogOpen();

  document.addEventListener('dragover', (e) => {
    const sigDrag = Array.from(e.dataTransfer.types || []).includes('application/x-pdfsig');
    if (modalOpen()) { if (!e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } return; }
    if (sigDrag || hasFiles(e)) e.preventDefault();
    const k = draggedKinds(e);
    const onEditor = !editorEl.hidden && S.pages.length;
    if (hasFiles(e) && (k.pdf || !onEditor)) {
      dragOverlay.hidden = false;
      $('#dropzone').classList.add('over');
      e.dataTransfer.dropEffect = 'copy';
      highlightPage(null);
      return;
    }
    dragOverlay.hidden = true;
    if (onEditor && (sigDrag || (hasFiles(e) && k.image))) {
      const pi = pageAt(e.clientX, e.clientY);
      highlightPage(pi >= 0 ? pi : null);
      e.dataTransfer.dropEffect = pi >= 0 ? 'copy' : 'none';
    } else if (hasFiles(e)) {
      e.dataTransfer.dropEffect = 'none';
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      dragOverlay.hidden = true;
      $('#dropzone').classList.remove('over');
      highlightPage(null);
    }
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragOverlay.hidden = true;
    $('#dropzone').classList.remove('over');
    highlightPage(null);
    if (modalOpen()) return;
    const sigId = e.dataTransfer.getData('application/x-pdfsig');
    const pi = S.pages.length && !editorEl.hidden ? pageAt(e.clientX, e.clientY) : -1;
    const at = pi >= 0 ? (() => {
      const r = S.pages[pi].div.getBoundingClientRect();
      return { page: pi, x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
    })() : null;
    if (sigId) {
      const s = saved.find((x) => x.id === sigId);
      if (s && at) useSaved(s, at);
      return;
    }
    const files = Array.from(e.dataTransfer.files || []);
    const pdf = files.find(isPdfFile);
    if (pdf) { openFileObject(pdf); return; }
    const img = files.find(isImageFile);
    if (img && S.pages.length && !editorEl.hidden) { addImageFromFile(img, at); return; }
    if (files.length) toast('Please drop a PDF file.', { error: true });
  });
  document.addEventListener('dragend', () => highlightPage(null));

  /* ------------------------------------------------------------------ */
  /* toolbar & menus                                                    */
  /* ------------------------------------------------------------------ */
  $('#home-open').onclick = openViaDialog;
  $('#dropzone').addEventListener('click', (e) => { if (e.target.id === 'dropzone') openViaDialog(); });
  $('#dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViaDialog(); } });
  $('#file-pdf').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await openBytes(new Uint8Array(await f.arrayBuffer()), f.name, null, true);
    } catch (err) { toast(errMsg(err), { error: true }); }
  });
  $('#btn-open').onclick = openViaDialog;
  $('#btn-save').onclick = () => save();
  $('#btn-undo').onclick = undo;
  $('#btn-redo').onclick = redo;
  $('#btn-prev').onclick = () => goToPage(S.current - 1);
  $('#btn-next').onclick = () => goToPage(S.current + 1);
  $('#btn-zoom-in').onclick = () => zoomStep(1);
  $('#btn-zoom-out').onclick = () => zoomStep(-1);
  $('#btn-sidebar').onclick = () => {
    prefs.sidebar = !prefs.sidebar;
    savePrefs();
    thumbsEl.classList.toggle('collapsed', !prefs.sidebar);
    if (S.zoomMode.startsWith('fit')) applyZoom(computeFit(S.zoomMode), null);
  };
  zoomSelect.addEventListener('change', () => {
    const v = zoomSelect.value;
    if (v === 'fit-width' || v === 'fit-page') { S.zoomMode = v; applyZoom(computeFit(v), null); }
    else if (v !== 'custom') { S.zoomMode = 'custom'; applyZoom(parseFloat(v), null); }
    viewer.focus({ preventScroll: true });
  });
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const n = parseInt(pageInput.value, 10); if (n) goToPage(n - 1); pageInput.blur(); }
    if (e.key === 'Escape') { pageInput.value = S.current + 1; pageInput.blur(); }
  });
  pageInput.addEventListener('focus', () => pageInput.select());
  pageInput.addEventListener('blur', () => { pageInput.value = S.current + 1; });

  const moreMenu = $('#more-menu');
  $('#btn-more').onclick = (e) => {
    e.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
    const has = !!S.savedPath;
    for (const b of $$('[data-act="show-folder"],[data-act="open-saved"]', moreMenu)) {
      b.disabled = !has;
      b.style.opacity = has ? '' : '.45';
    }
  };
  document.addEventListener('pointerdown', (e) => { if (!moreMenu.hidden && !e.target.closest('.menu-wrap')) moreMenu.hidden = true; });
  moreMenu.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    moreMenu.hidden = true;
    switch (b.dataset.act) {
      case 'save-as': saveAs(); break;
      case 'open': openViaDialog(); break;
      case 'show-folder': if (S.savedPath) api.showInFolder(S.savedPath); break;
      case 'open-saved': if (S.savedPath) api.openPath(S.savedPath); break;
      case 'clear-all': {
        if (!S.els.length) { toast('There are no added items to remove.'); break; }
        const r = await dialog({
          title: 'Remove all added items?',
          message: 'All signatures, text and marks you added to this document will be removed. You can undo this.',
          buttons: [{ label: 'Cancel', value: false, cancel: true }, { label: 'Remove all', value: true, primary: true }],
        });
        if (r) { checkpoint(); S.els = []; S.sel = null; renderAllEls(); }
        break;
      }
      case 'close-doc':
        if (await confirmDiscard()) closeDocument(false);
        break;
      default: break;
    }
  });

  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !S.pages.length) return;
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0022);
    S.zoomMode = 'custom';
    applyZoom(S.zoom * f, { x: e.clientX, y: e.clientY });
  }, { passive: false });

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (S.pages.length && (S.zoomMode === 'fit-width' || S.zoomMode === 'fit-page')) applyZoom(computeFit(S.zoomMode), null);
      if (!sigModal.hidden) { sizeDrawCanvas(); renderFontGrid(); }
    }, 120);
  });

  /* ------------------------------------------------------------------ */
  /* keyboard                                                           */
  /* ------------------------------------------------------------------ */
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (isDialogOpen()) {
      if (e.key === 'Escape' && dlgResolve) { e.preventDefault(); dlgResolve.finish(dlgResolve.cancelVal); }
      else if (e.key === 'Enter' && dlgResolve && dlgResolve.primaryVal != null && !(document.activeElement && document.activeElement.tagName === 'BUTTON')) {
        e.preventDefault(); dlgResolve.finish(dlgResolve.primaryVal);
      }
      return;
    }
    if (!sigModal.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeSig(); }
      else if (ctrl && key === 'z' && Sig.tab === 'draw') { e.preventDefault(); $('#draw-undo').click(); }
      return;
    }
    if (busyCount) return;

    if (ctrl && key === 'o') { e.preventDefault(); openViaDialog(); return; }
    if (editorEl.hidden || !S.pages.length) return;

    if (ctrl && key === 's') { e.preventDefault(); if (e.shiftKey) saveAs(); else save(); return; }

    const t = e.target;
    const inField = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (S.editing) {
      if (e.key === 'Escape' || (e.key === 'Enter' && ctrl)) { e.preventDefault(); finishEdit(); }
      return;
    }
    if (inField && t !== viewer) {
      const ctrlOnly = t.tagName === 'INPUT' && (t.type === 'range' || t.type === 'checkbox') && ctrl && (key === 'z' || key === 'y');
      if (!ctrlOnly) return;
    }

    if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((ctrl && key === 'y') || (ctrl && key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); zoomStep(1); return; }
    if (ctrl && key === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (ctrl && key === '0') { e.preventDefault(); S.zoomMode = 'fit-width'; applyZoom(computeFit('fit-width'), null); return; }

    const el = S.sel ? getEl(S.sel) : null;
    if (el) {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteEl(el.id); return; }
      if (ctrl && key === 'd') { e.preventDefault(); duplicateEl(el.id); return; }
      if (e.key === 'Escape') { e.preventDefault(); select(null); return; }
      if (e.key === 'Enter' && isText(el)) { e.preventDefault(); startEdit(el); return; }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) {
        e.preventDefault();
        if (!e.repeat) checkpoint();
        el.x += d[0]; el.y += d[1];
        clampEl(el);
        applyElStyle(nodeFor(el.id), el);
        return;
      }
    } else if (!ctrl && !inField) {
      if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !e.shiftKey)) { e.preventDefault(); goToPage(S.current + 1); }
      else if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !e.shiftKey)) { e.preventDefault(); goToPage(S.current - 1); }
      else if (e.key === 'Home') { e.preventDefault(); goToPage(0); }
      else if (e.key === 'End') { e.preventDefault(); goToPage(S.pages.length - 1); }
    }
  });

  /* ------------------------------------------------------------------ */
  /* closing                                                            */
  /* ------------------------------------------------------------------ */
  if (isDesktop) {
    api.onCloseRequest(async () => {
      if (await confirmDiscard()) api.forceClose();
    });
    api.onOpenFile((p) => openPath(p));
  } else {
    window.addEventListener('beforeunload', (e) => {
      if (S.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ------------------------------------------------------------------ */
  /* init                                                               */
  /* ------------------------------------------------------------------ */
  renderInkSwatches();
  renderTypeSwatches();
  renderSaved();
  renderRecent();
  updateTitle();
  updateUndoUI();
  pagesEl.style.setProperty('--z', 1);
  pagesEl.style.setProperty('--scale-factor', 1);
  // warm up handwriting fonts so previews are instant
  if (document.fonts) for (const f of SIG_FONTS) document.fonts.load(`32px "${f}"`, 'Ab').catch(() => {});

  if (isDesktop) {
    api.getInitialFile().then((p) => { if (p) openPath(p); }).catch(() => {});
  }

  // test hook (harmless in production)
  window.__pdfsig = { S, renderAllEls, openBytes, buildDirect, buildFlattened, addFill, addImageElement, addTextElement, finishEdit, applyZoom, markAsset, startEdit, getEl };
})();
