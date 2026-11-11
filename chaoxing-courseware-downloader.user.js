// ==UserScript==
// @name         超星学习通课件下载
// @namespace    https://github.com/wuheshidaozod/chaoxing-courseware-downloader
// @author       wuheshidaozod
// @license      MIT
// @homepageURL  https://github.com/wuheshidaozod/chaoxing-courseware-downloader
// @supportURL   https://github.com/wuheshidaozod/chaoxing-courseware-downloader/issues
// @downloadURL  https://raw.githubusercontent.com/wuheshidaozod/chaoxing-courseware-downloader/main/chaoxing-courseware-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/wuheshidaozod/chaoxing-courseware-downloader/main/chaoxing-courseware-downloader.user.js
// @version      1.1.0
// @description  在超星学习通章节学习页面列出当前章节的课件（PPT/PDF/Word 等），一键下载原文件或 PDF 版；自动修复 WPS 导出 PDF 在 Edge/Acrobat 中公式显示为方框的问题
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @match        *://*.chaoxing.com/mooc-ans/mycourse/studentstudy*
// @require      https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      chaoxing.com
// @connect      cldisk.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DOC_TYPES = /\.(pptx?|pdf|docx?|xlsx?|zip|rar|7z|txt)$/i;

  // ---------- 收集当前章节的课件 ----------
  function collectFiles() {
    const found = new Map();
    const visit = (doc, depth) => {
      if (!doc || depth > 4) return;
      doc.querySelectorAll('iframe').forEach((f) => {
        const raw = f.getAttribute('data');
        if (raw) {
          try {
            const d = JSON.parse(raw);
            if (d.objectid && (DOC_TYPES.test(d.name || '') || DOC_TYPES.test(d.type || '') || /insertdoc/.test(f.className))) {
              found.set(d.objectid, { objectid: d.objectid, name: d.name || d.objectid, size: d.hsize || '' });
            }
          } catch (e) { /* ignore */ }
        }
        try { visit(f.contentDocument, depth + 1); } catch (e) { /* cross-origin */ }
      });
    };
    visit(document, 0);
    return [...found.values()];
  }

  // ---------- 查询下载地址 ----------
  const statusCache = new Map();
  async function getStatus(objectid) {
    if (statusCache.has(objectid)) return statusCache.get(objectid);
    const r = await fetch(`${location.origin}/ananas/status/${objectid}?flag=normal&_dc=${Date.now()}`, { credentials: 'include' });
    const j = await r.json();
    if (j.status !== 'success') throw new Error('status: ' + j.status);
    statusCache.set(objectid, j);
    return j;
  }

  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_');
  }

  // ==FIXER-BEGIN==
  // WPS 导出的 PDF 常把整个 .ttc 字体集合（如 cambria.ttc）嵌入为 FontFile2，
  // 这违反 PDF 规范，Edge(Acrobat 引擎)/Adobe Reader 无法加载，公式显示为方框。
  // 这里从集合中取出 /FontName 对应的单个字体替换回去。
  function ttcExtract(ttc, wantName) {
    const dv = new DataView(ttc.buffer, ttc.byteOffset, ttc.byteLength);
    const tag = (o) => String.fromCharCode(ttc[o], ttc[o + 1], ttc[o + 2], ttc[o + 3]);
    const numFonts = dv.getUint32(8);
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(wantName.replace(/^[A-Z]{6}\+/, ''));
    const fonts = [];
    for (let i = 0; i < numFonts; i++) {
      const off = dv.getUint32(12 + i * 4);
      const n = dv.getUint16(off + 4);
      const tables = [];
      for (let t = 0; t < n; t++) {
        const r = off + 12 + t * 16;
        tables.push({ tag: tag(r), sum: dv.getUint32(r + 4), off: dv.getUint32(r + 8), len: dv.getUint32(r + 12) });
      }
      // 读取 name 表中的 1/4/6 号名称
      const names = [];
      const nt = tables.find((t) => t.tag === 'name');
      if (nt) {
        const cnt = dv.getUint16(nt.off + 2), so = nt.off + dv.getUint16(nt.off + 4);
        for (let k = 0; k < cnt; k++) {
          const r = nt.off + 6 + k * 12;
          const pid = dv.getUint16(r), nid = dv.getUint16(r + 6), len = dv.getUint16(r + 8), o = so + dv.getUint16(r + 10);
          if (![1, 4, 6].includes(nid)) continue;
          let s = '';
          if (pid === 0 || pid === 3) for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode(dv.getUint16(o + j));
          else for (let j = 0; j < len; j++) s += String.fromCharCode(ttc[o + j]);
          names.push(norm(s));
        }
      }
      fonts.push({ off, n, tables, names });
    }
    const pick = fonts.find((f) => f.names.includes(want))
      || fonts.find((f) => f.names.some((s) => s && (s.includes(want) || want.includes(s))))
      || fonts[0];
    // 组装独立 TTF
    const n = pick.n;
    let size = 12 + 16 * n;
    for (const t of pick.tables) size += (t.len + 3) & ~3;
    const out = new Uint8Array(size);
    const ov = new DataView(out.buffer);
    out.set(ttc.subarray(pick.off, pick.off + 12), 0);
    let p = 12 + 16 * n, headPos = -1;
    pick.tables.forEach((t, i) => {
      const r = 12 + i * 16;
      for (let j = 0; j < 4; j++) out[r + j] = t.tag.charCodeAt(j);
      ov.setUint32(r + 4, t.sum); ov.setUint32(r + 8, p); ov.setUint32(r + 12, t.len);
      out.set(ttc.subarray(t.off, t.off + t.len), p);
      if (t.tag === 'head') headPos = p;
      p += (t.len + 3) & ~3;
    });
    if (headPos >= 0) { // 重新计算 checkSumAdjustment
      ov.setUint32(headPos + 8, 0);
      let sum = 0;
      for (let i = 0; i < size; i += 4) sum = (sum + ov.getUint32(i)) >>> 0;
      ov.setUint32(headPos + 8, (0xB1B0AFBA - sum) >>> 0);
    }
    return out;
  }

  async function fixPdfFonts(bytes, PDFLib) {
    const { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } = PDFLib;
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    const ctx = doc.context;
    const log = [];
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const ffRef = obj.get(PDFName.of('FontFile2'));
      if (!ffRef) continue;
      const stream = ctx.lookup(ffRef);
      if (!(stream instanceof PDFRawStream)) continue;
      const data = decodePDFRawStream(stream).decode();
      if (!(data[0] === 0x74 && data[1] === 0x74 && data[2] === 0x63 && data[3] === 0x66)) continue; // 'ttcf'
      const fn = String(obj.get(PDFName.of('FontName')) || '').replace(/^\//, '');
      const ttf = ttcExtract(data, fn);
      ctx.assign(ffRef, ctx.flateStream(ttf, { Length1: ttf.length }));
      log.push(`${fn}: ${(data.length / 1024) | 0}KB -> ${(ttf.length / 1024) | 0}KB`);
    }
    if (!log.length) return { bytes, fixed: false, log };
    return { bytes: await doc.save({ useObjectStreams: false }), fixed: true, log };
  }
  // ==FIXER-END==

  function gmGetBytes(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer',
        headers: { Referer: location.origin + '/' },
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(new Uint8Array(r.response)) : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('超时')),
      });
    });
  }

  function saveBlob(bytes, filename) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = sanitize(filename);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function download(url, filename, btn) {
    if (/\.pdf$/i.test(filename) && typeof GM_xmlhttpRequest === 'function' && typeof PDFLib !== 'undefined') {
      return downloadPdf(url, filename, btn);
    }
    return downloadRaw(url, filename, btn);
  }

  async function downloadPdf(url, filename, btn) {
    const old = btn.textContent;
    btn.disabled = true;
    const done = (msg) => { btn.textContent = msg; setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2500); };
    try {
      btn.textContent = '下载中…';
      const raw = await gmGetBytes(url);
      btn.textContent = '修复中…';
      let out = raw, fixed = false;
      try {
        const r = await fixPdfFonts(raw, PDFLib);
        out = r.bytes; fixed = r.fixed;
        if (fixed) console.log('[课件下载] 已修复字体', filename, r.log);
      } catch (e) {
        console.warn('[课件下载] 字体修复失败，保存原文件', e);
      }
      saveBlob(out, filename);
      done(fixed ? '✓ 已修复' : '✓ 完成');
    } catch (e) {
      console.warn('[课件下载] 读取 PDF 失败，改为直接下载', e);
      btn.textContent = old; btn.disabled = false;
      downloadRaw(url, filename, btn);
    }
  }

  function downloadRaw(url, filename, btn) {
    const old = btn.textContent;
    btn.textContent = '下载中…';
    btn.disabled = true;
    const done = (msg) => { btn.textContent = msg; setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2500); };
    if (typeof GM_download === 'function') {
      GM_download({
        url,
        name: sanitize(filename),
        headers: { Referer: location.origin + '/' },
        onload: () => done('✓ 完成'),
        onerror: (e) => {
          console.warn('[课件下载] GM_download 失败，改为新标签打开', e);
          window.open(url, '_blank');
          done('已打开');
        },
      });
    } else {
      window.open(url, '_blank');
      done('已打开');
    }
  }

  // ---------- UI ----------
  const panel = document.createElement('div');
  panel.id = 'cx-dl-panel';
  panel.innerHTML = `
    <style>
      #cx-dl-panel{position:fixed;left:16px;bottom:90px;z-index:999999;width:320px;max-height:60vh;overflow:auto;
        background:#fff;border:1px solid #d0d7e2;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);
        font:13px/1.5 "Microsoft YaHei",sans-serif;color:#333}
      #cx-dl-panel .hd{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#3a8bff;color:#fff;
        border-radius:8px 8px 0 0;cursor:pointer;user-select:none;position:sticky;top:0}
      #cx-dl-panel .bd{padding:8px 12px}
      #cx-dl-panel.collapsed .bd{display:none}
      #cx-dl-panel .item{padding:6px 0;border-bottom:1px dashed #e5e5e5}
      #cx-dl-panel .item:last-child{border-bottom:none}
      #cx-dl-panel .nm{word-break:break-all}
      #cx-dl-panel .sz{color:#999;margin-left:4px}
      #cx-dl-panel button{margin:4px 6px 0 0;padding:2px 10px;border:1px solid #3a8bff;background:#fff;color:#3a8bff;border-radius:4px;cursor:pointer}
      #cx-dl-panel button:hover{background:#3a8bff;color:#fff}
      #cx-dl-panel button:disabled{opacity:.6;cursor:default}
      #cx-dl-panel .empty{color:#999}
    </style>
    <div class="hd"><span>📥 课件下载</span><span class="tg">收起</span></div>
    <div class="bd"><div class="list empty">正在查找课件…</div>
      <button class="all" style="display:none">全部下载（原文件）</button>
      <button class="refresh">刷新</button>
    </div>`;
  document.body.appendChild(panel);

  const listEl = panel.querySelector('.list');
  const allBtn = panel.querySelector('.all');
  panel.querySelector('.hd').onclick = () => {
    panel.classList.toggle('collapsed');
    panel.querySelector('.tg').textContent = panel.classList.contains('collapsed') ? '展开' : '收起';
  };
  panel.querySelector('.refresh').onclick = () => { lastKey = ''; render(); };

  let lastKey = '';
  let current = [];

  async function render() {
    const files = collectFiles();
    const key = files.map((f) => f.objectid).join(',');
    if (key === lastKey) return;
    lastKey = key;
    current = files;
    if (!files.length) {
      listEl.className = 'list empty';
      listEl.textContent = '当前章节没有找到课件';
      allBtn.style.display = 'none';
      return;
    }
    listEl.className = 'list';
    listEl.innerHTML = '';
    allBtn.style.display = files.length > 1 ? '' : 'none';
    for (const f of files) {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `<div class="nm"></div>`;
      div.querySelector('.nm').textContent = f.name;
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = f.size;
      div.querySelector('.nm').appendChild(sz);

      const bOrig = document.createElement('button');
      bOrig.textContent = '原文件';
      bOrig.onclick = async () => {
        try {
          const s = await getStatus(f.objectid);
          download(s.download, s.filename || f.name, bOrig);
        } catch (e) { alertErr(e); }
      };
      div.appendChild(bOrig);

      if (!/\.pdf$/i.test(f.name)) {
        const bPdf = document.createElement('button');
        bPdf.textContent = 'PDF 版';
        bPdf.onclick = async () => {
          try {
            const s = await getStatus(f.objectid);
            if (!s.pdf) throw new Error('该文件没有 PDF 版本');
            download(s.pdf, (s.filename || f.name).replace(/\.[^.]+$/, '') + '.pdf', bPdf);
          } catch (e) { alertErr(e); }
        };
        div.appendChild(bPdf);
      }
      listEl.appendChild(div);
    }
  }

  allBtn.onclick = async () => {
    for (const f of current) {
      try {
        const s = await getStatus(f.objectid);
        download(s.download, s.filename || f.name, allBtn);
        await new Promise((r) => setTimeout(r, 800));
      } catch (e) { console.error('[课件下载]', f.name, e); }
    }
  };

  function alertErr(e) {
    console.error('[课件下载]', e);
    listEl.insertAdjacentHTML('afterbegin', `<div style="color:#e33">获取下载地址失败：${String(e.message || e).replace(/</g, '&lt;')}</div>`);
  }

  // 章节切换是 AJAX 加载，定时检测
  setInterval(render, 2000);
  render();
})();
