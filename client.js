// dsh-memory-star-map 客户端半（浏览器模块）
// v2「星河」：真 3D 记忆星图 —— 玻璃地球居中，二十八宿为球壳锚点，
// 每条记忆 = 地球表面点亮一个点 + 向外放射一颗新星（挂靠在其星宿簇下）。
// 视觉层：烘焙星云银河背景 + 正弦闪烁星 + 参数化流星雨 + 预烘焙光晕 sprite；
// 性能层：动画状态全 ref 化（不再每帧 setState）、类型化绘制项（无每帧闭包）、
//         原生 non-passive 滚轮、指针事件（鼠标/触摸统一）、双指捏合缩放、惯性相机。
window.__ModuleLoader__.load({
  id: 'dsh-memory-star-map',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState, useMemo, useCallback } = React

    // ---------- 常量：二十八宿（四象） ----------
    // 配色参考「星河化相」现代深空方案：青龙翠青 / 朱雀珊瑚 / 白虎冰蓝 / 玄武湛蓝
    const GROUP_COLOR = { 青龙: '#4fe3c1', 朱雀: '#ff8f73', 白虎: '#dbe7fb', 玄武: '#7aa5ff' }
    const GROUP_RGB = { 青龙: '79,227,193', 朱雀: '255,143,115', 白虎: '219,231,251', 玄武: '122,165,255' }
    const MANSIONS = [
      { g: '青龙', n: '角' }, { g: '青龙', n: '亢' }, { g: '青龙', n: '氐' },
      { g: '青龙', n: '房' }, { g: '青龙', n: '心' }, { g: '青龙', n: '尾' }, { g: '青龙', n: '箕' },
      { g: '朱雀', n: '井' }, { g: '朱雀', n: '鬼' }, { g: '朱雀', n: '柳' },
      { g: '朱雀', n: '星' }, { g: '朱雀', n: '张' }, { g: '朱雀', n: '翼' }, { g: '朱雀', n: '轸' },
      { g: '白虎', n: '奎' }, { g: '白虎', n: '娄' }, { g: '白虎', n: '胃' },
      { g: '白虎', n: '昴' }, { g: '白虎', n: '毕' }, { g: '白虎', n: '觜' }, { g: '白虎', n: '参' },
      { g: '玄武', n: '斗' }, { g: '玄武', n: '牛' }, { g: '玄武', n: '女' },
      { g: '玄武', n: '虚' }, { g: '玄武', n: '危' }, { g: '玄武', n: '室' }, { g: '玄武', n: '壁' },
    ].map(m => ({ ...m, c: GROUP_COLOR[m.g], rgb: GROUP_RGB[m.g] }))

    // 二十八宿 = 28 个技艺大类，可改名（如「摄影」）。MANSIONS 是活数组：
    // applyMansions 原地改写后 canvas 下一帧即读新名，React 侧靠 mansionsVer 触发重渲染。
    const DEFAULT_MANSION_NAMES = MANSIONS.map(m => m.n)
    function mansionsSnapshot() {
      return MANSIONS.map(m => ({ name: m.n, desc: m.d || '' }))
    }
    function applyMansions(list) {
      if (!Array.isArray(list)) return false
      for (let i = 0; i < MANSIONS.length && i < list.length; i++) {
        const it = list[i]
        if (!it || typeof it !== 'object') continue
        const nm = String(it.name != null ? it.name : (it.n || '')).trim()
        if (nm) MANSIONS[i].n = nm.slice(0, 24)
        MANSIONS[i].d = String(it.desc || it.d || '').slice(0, 120)
      }
      return true
    }
    // 语义星座：共享标签的记忆自动连线，每颗最多保留 top3 关系（按共享数 > 时间近邻）
    function computeLinks(stars) {
      const map = new Map()
      if (!Array.isArray(stars) || stars.length < 2) return map
      const norm = new Map()
      for (const s of stars) {
        map.set(s.id, [])
        norm.set(s.id, new Set((Array.isArray(s.tags) ? s.tags : []).map(t => String(t).trim().toLowerCase()).filter(Boolean)))
      }
      const cand = new Map() // id -> [{oid, shared, ts}]
      for (let i = 0; i < stars.length; i++) {
        const ta = norm.get(stars[i].id)
        if (!ta.size) continue
        for (let j = i + 1; j < stars.length; j++) {
          const tb = norm.get(stars[j].id)
          if (!tb.size) continue
          let shared = 0
          for (const t of ta) if (tb.has(t)) shared++
          if (!shared) continue
          const a = stars[i].id, b = stars[j].id
          if (!cand.has(a)) cand.set(a, [])
          if (!cand.has(b)) cand.set(b, [])
          cand.get(a).push({ oid: b, shared })
          cand.get(b).push({ oid: a, shared })
        }
      }
      const tsOf = new Map(stars.map(s => [s.id, Date.parse(s.time || '') || 0]))
      const pairSeen = new Set()
      for (const [id, arr] of cand) {
        const t0 = tsOf.get(id) || 0
        arr.sort((x, y) => y.shared - x.shared || Math.abs((tsOf.get(x.oid) || 0) - t0) - Math.abs((tsOf.get(y.oid) || 0) - t0))
        const out = map.get(id)
        for (const c of arr) {
          if (out.length >= 3) break
          if (out.includes(c.oid)) continue
          out.push(c.oid)
          const key = id < c.oid ? id + '|' + c.oid : c.oid + '|' + id
          if (!pairSeen.has(key)) {
            pairSeen.add(key)
            const other = map.get(c.oid)
            if (other && other.length < 3 && !other.includes(id)) other.push(id)
          }
        }
      }
      for (const [id, arr] of map) map.set(id, new Set(arr))
      return map
    }

    // ---------- 3D 几何常量 ----------
    const R_E = 90        // 地球半径
    const R_M = 270       // 二十八宿锚点球壳半径
    const PERS = 1500     // 透视距离
    const AUTO_SPIN = 0.027 // 空闲自转速度（弧度/秒）
    const HOME = { yaw: 0.6, pitch: -0.25, k: 0.9 }

    // ---------- 小工具 ----------
    const TAU = Math.PI * 2
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
    function mulberry32(seed) {
      let a = seed >>> 0
      return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }
    function hexToRgb3(hex) {
      const n = parseInt(hex.slice(1), 16)
      return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
    }
    function rgba(rgb3, a) { return `rgba(${rgb3},${a})` }
    function genId() {
      return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    }
    function hashStr(s) {
      let hh = 0
      for (let i = 0; i < s.length; i++) { hh = (hh * 31 + s.charCodeAt(i)) | 0 }
      return Math.abs(hh)
    }
    function relTime(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      const s = (Date.now() - d.getTime()) / 1000
      if (s < 60) return '刚刚'
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
      if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前'
      return d.toLocaleDateString()
    }
    function fmtDate(ts) {
      const d = new Date(ts)
      const p = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    function fmtTime(iso) {
      if (!iso) return '—'
      const d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      return d.toLocaleString()
    }
    // 宿主 API 候选路径；只有响应带我们的版本标记 v===2 才认作真宿主
    const API_BASES = [
      '/app/api/memory-star-map',
      '/api/memory-star-map',
      '/app/api/memory-star-map-2',
      '/api/memory-star-map-2',
      '/app/api/memory-star-map-3',
      '/api/memory-star-map-3',
    ]
    // 已确认支持 v3 的宿主 base（僵尸旧实例只回 v2，会吞掉 mansions，必须绕开）
    let prefBase = null
    function baseOrder() {
      return prefBase ? [prefBase, ...API_BASES.filter(b => b !== prefBase)] : API_BASES
    }
    async function apiFetch(path, opts) {
      for (const base of baseOrder()) {
        try {
          const r = await fetch(base + path, opts)
          if (!r.ok) continue
          const j = await r.json().catch(() => null)
          if (j && j.v === 3) { prefBase = base; return j }
          if (j && j.v === 2) return j
        } catch { /* 换下一个候选 */ }
      }
      return null
    }

    // ---------- 样式（一次性注入 <style>：玻璃拟态 + hover 态 + 动画） ----------
    const STYLE_ID = 'dsh-memory-star-map-style-v2'
    const CSS = `
.msm-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:520px;color:#e8eefc;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#04060f;overflow:hidden}
.msm-toolbar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:linear-gradient(180deg,rgba(13,18,42,.92),rgba(8,11,28,.8));border-bottom:1px solid rgba(120,140,220,.14);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);flex-wrap:wrap;z-index:10}
.msm-brand{font-weight:800;font-size:15px;letter-spacing:.5px;display:flex;align-items:center;gap:8px;background:linear-gradient(90deg,#dce8ff,#8fb2ff 60%,#6ee7d2);-webkit-background-clip:text;background-clip:text;color:transparent;white-space:nowrap}
.msm-logo{width:22px;height:22px;flex:none}
.msm-stat{font-size:12px;color:#8fa2cf;display:flex;align-items:center;gap:6px;white-space:nowrap}
.msm-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#3fd68f;box-shadow:0 0 8px rgba(63,214,143,.9)}
.msm-dot.local{background:#ffc46b;box-shadow:0 0 8px rgba(255,196,107,.9)}
.msm-dot.wait{background:#7286b8;box-shadow:none;animation:msm-blink 1.2s infinite}
.msm-search{flex:1;min-width:130px;max-width:260px;background:rgba(10,15,36,.72);border:1px solid rgba(120,140,220,.2);border-radius:10px;color:#e8eefc;padding:7px 12px;font-size:13px;outline:none;transition:border-color .2s,box-shadow .2s}
.msm-search::placeholder{color:#5f7099}
.msm-search:focus{border-color:rgba(140,170,255,.55);box-shadow:0 0 0 3px rgba(90,120,255,.15)}
.msm-btn{border:1px solid transparent;border-radius:10px;padding:7px 14px;cursor:pointer;font-size:13px;font-weight:600;color:#fff;background:linear-gradient(135deg,#3d6bf0,#5f4fe0);transition:transform .15s,box-shadow .2s,filter .2s;white-space:nowrap;font-family:inherit}
.msm-btn:hover{filter:brightness(1.14);transform:translateY(-1px);box-shadow:0 6px 18px rgba(70,100,240,.35)}
.msm-btn:active{transform:translateY(0) scale(.97)}
.msm-btn.ghost{background:rgba(120,140,220,.1);border-color:rgba(120,140,220,.25);color:#b9c8ef}
.msm-btn.ghost:hover{background:rgba(120,140,220,.22);color:#dfe8ff;box-shadow:none}
.msm-btn.violet{background:linear-gradient(135deg,#8a4fe0,#5f4fe0)}
.msm-btn.violet:hover{box-shadow:0 6px 18px rgba(138,79,224,.4)}
.msm-btn.shower{background:linear-gradient(135deg,#2aa7d6,#4f5fe0)}
.msm-btn.shower:hover{box-shadow:0 6px 18px rgba(42,167,214,.4)}
.msm-btn.danger{background:linear-gradient(135deg,#b0455a,#8a2c46)}
.msm-btn.danger:hover{box-shadow:0 6px 18px rgba(176,69,90,.4)}
.msm-btn.green{background:linear-gradient(135deg,#2f9e6f,#1f7a8c)}
.msm-btn.green:hover{box-shadow:0 6px 18px rgba(47,158,111,.4)}
.msm-btn:disabled{opacity:.45;cursor:not-allowed;transform:none!important;box-shadow:none!important;filter:none!important}
.msm-icon-btn{width:32px;height:32px;padding:0;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-size:15px;line-height:1}
.msm-icon-btn.off{opacity:.45}
.msm-stage{flex:1;position:relative;overflow:hidden;min-height:380px}
.msm-canvas-wrap{position:absolute;inset:0;cursor:grab;touch-action:none}
.msm-canvas-wrap.grabbing{cursor:grabbing}
.msm-canvas-wrap.pointing{cursor:pointer}
.msm-panel{position:absolute;z-index:20;background:rgba(11,15,34,.68);backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%);border:1px solid rgba(150,170,255,.14);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.06);animation:msm-in .28s cubic-bezier(.2,.9,.3,1.15);max-height:calc(100% - 28px);overflow:auto;display:flex;flex-direction:column;scrollbar-width:thin;scrollbar-color:rgba(120,140,220,.3) transparent}
.msm-panel.right{right:14px;top:14px;width:min(340px,calc(100% - 28px))}
.msm-panel.left{left:14px;top:14px;width:min(360px,calc(100% - 28px))}
@keyframes msm-in{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:none}}
.msm-panel-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:14px 16px 8px;font-size:14px}
.msm-panel-title{font-weight:700;line-height:1.4;word-break:break-all}
.msm-panel-body{padding:2px 16px 12px;font-size:13px;line-height:1.65}
.msm-panel-foot{display:flex;gap:8px;padding:12px 16px;border-top:1px solid rgba(120,140,220,.12);margin-top:auto;flex-wrap:wrap}
.msm-x{background:transparent;border:none;color:#8fa2cf;cursor:pointer;font-size:13px;width:26px;height:26px;border-radius:8px;transition:.15s;flex:none}
.msm-x:hover{background:rgba(255,120,120,.16);color:#ffd9d9}
.msm-content{white-space:pre-wrap;color:#c7d4f2;margin:0 0 6px;word-break:break-word}
.msm-tag{display:inline-block;margin:0 6px 6px 0;padding:2px 9px;background:rgba(90,120,255,.14);border:1px solid rgba(120,150,255,.18);border-radius:999px;font-size:11px;color:#a9c0ff;cursor:pointer;transition:.15s}
.msm-tag:hover{background:rgba(90,120,255,.3);color:#d5e0ff}
.msm-meta{font-size:12px;color:#8fa2cf;margin-top:7px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.msm-chip{padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid}
.msm-field{display:block;font-size:12px;color:#9db0dc;margin:12px 0 5px}
.msm-input{width:100%;box-sizing:border-box;background:rgba(8,12,30,.75);border:1px solid rgba(120,140,220,.22);border-radius:10px;color:#e8eefc;padding:8px 11px;font-size:13px;font-family:inherit;outline:none;transition:border-color .2s,box-shadow .2s}
.msm-input:focus{border-color:rgba(140,170,255,.6);box-shadow:0 0 0 3px rgba(90,120,255,.14)}
textarea.msm-input{resize:vertical;min-height:84px;line-height:1.6}
select.msm-input option{background:#0c1126;color:#e8eefc}
.msm-stars-pick{display:flex;gap:2px;margin-top:5px}
.msm-star-btn{background:none;border:none;font-size:20px;cursor:pointer;color:#39436b;padding:0 2px;transition:transform .12s,color .15s;line-height:1}
.msm-star-btn.on{color:#ffd479;text-shadow:0 0 10px rgba(255,212,121,.55)}
.msm-star-btn:hover{transform:scale(1.22)}
.msm-legend{display:flex;gap:8px;align-items:center;padding:8px 16px;font-size:12px;color:#7d8fc0;border-top:1px solid rgba(120,140,220,.1);background:rgba(7,10,26,.78);flex-wrap:wrap;z-index:10}
.msm-gchip{display:flex;align-items:center;gap:6px;padding:3px 11px;border-radius:999px;border:1px solid rgba(120,140,220,.18);background:rgba(120,140,220,.06);cursor:pointer;font-weight:600;font-size:12px;transition:.18s;user-select:none;color:inherit;font-family:inherit}
.msm-gchip:hover{background:rgba(120,140,220,.16)}
.msm-gchip.off{opacity:.32;filter:grayscale(1)}
.msm-mrow{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.msm-mrow .msm-input{flex:1;min-width:0}
.msm-midx{font-size:11px;color:#7d8fc0;width:20px;flex:none;font-variant-numeric:tabular-nums}
.msm-mcount{font-size:11px;color:#8fa2cf;background:rgba(120,140,220,.12);border-radius:999px;padding:1px 8px;flex:none}
.msm-mini{padding:4px 10px;font-size:11px;border-radius:999px;margin-left:-4px}
.msm-hud{position:absolute;left:14px;bottom:14px;z-index:14;display:flex;flex-direction:column;gap:7px;padding:12px 14px;border-radius:16px;background:rgba(11,15,34,.62);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(150,170,255,.16);box-shadow:0 10px 30px rgba(0,0,0,.4);animation:msm-in .35s ease;pointer-events:auto;max-width:230px}
.msm-hud-t{display:flex;align-items:center;gap:8px;font-size:12px;color:#c9d6f5;font-weight:600;letter-spacing:.4px}
.msm-hud-x{margin-left:auto;background:none;border:none;color:#7d8fc0;cursor:pointer;font-size:14px;line-height:1;padding:0 2px}
.msm-hud-x:hover{color:#fff}
.msm-hud-row{display:flex;justify-content:space-between;gap:14px;font-size:12px;color:#aebadf;line-height:1.5}
.msm-hud-row b{color:#e8eeff;font-weight:600;font-variant-numeric:tabular-nums}
.msm-hud-link{color:#9db8ff;cursor:pointer;text-decoration:none;max-width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msm-hud-link:hover{color:#fff;text-decoration:underline}
.msm-spark{display:flex;align-items:flex-end;gap:3px;height:26px;margin-top:2px}
.msm-spark i{width:8px;border-radius:2px 2px 0 0;background:linear-gradient(180deg,#8fb2ff,#5f4fe0);opacity:.85;min-height:2px}
.msm-spark-lab{display:flex;justify-content:space-between;font-size:10px;color:#6d7fa8;margin-top:1px}
.msm-timeline{position:absolute;left:50%;transform:translateX(-50%);bottom:14px;z-index:16;display:flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;background:rgba(11,15,34,.66);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(150,170,255,.18);box-shadow:0 10px 30px rgba(0,0,0,.45);animation:msm-in .35s ease;pointer-events:auto;max-width:calc(100% - 340px)}
.msm-tl-btn{background:none;border:none;color:#c9d6f5;cursor:pointer;font-size:14px;line-height:1;padding:3px 4px;border-radius:6px}
.msm-tl-btn:hover{color:#fff;background:rgba(140,160,240,.14)}
.msm-timeline input[type=range]{width:clamp(120px,22vw,260px);accent-color:#8fb2ff;cursor:pointer}
.msm-tl-date{font-size:11px;color:#9fb0d8;min-width:78px;text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap}
.msm-relchip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;background:rgba(120,140,220,.13);border:1px solid rgba(150,170,255,.18);color:#a9c0ff;font-size:11px;cursor:pointer;max-width:100%}
.msm-relchip:hover{background:rgba(120,140,220,.25);color:#fff}
.msm-relchip i{width:6px;height:6px;border-radius:50%;flex:none}
.msm-gdot{width:8px;height:8px;border-radius:50%;flex:none}
.msm-hint{margin-left:auto;color:#5c6c9a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msm-empty{position:absolute;left:0;right:0;bottom:30px;margin:0 auto;width:max-content;z-index:15;display:flex;align-items:center;gap:12px;padding:12px 18px;background:rgba(11,15,34,.74);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(150,170,255,.16);border-radius:14px;color:#b9c8ef;font-size:13px;animation:msm-in .4s ease;box-shadow:0 10px 30px rgba(0,0,0,.45);max-width:calc(100% - 40px);flex-wrap:wrap;justify-content:center}
@media (prefers-reduced-motion: reduce){.msm-root *{animation:none !important;transition:none !important}}
.msm-tooltip{position:absolute;left:0;top:0;z-index:30;pointer-events:none;max-width:250px;padding:8px 12px;background:rgba(8,11,28,.88);border:1px solid rgba(150,170,255,.22);border-radius:11px;font-size:12px;line-height:1.5;color:#dbe5ff;box-shadow:0 8px 24px rgba(0,0,0,.5);opacity:0;transition:opacity .12s;will-change:transform}
.msm-tooltip.show{opacity:1}
.msm-cand{display:flex;gap:9px;padding:9px 8px;border-radius:10px;cursor:pointer;font-size:13px;line-height:1.55;transition:background .15s;border:1px solid transparent}
.msm-cand:hover{background:rgba(120,140,220,.09)}
.msm-cand input{margin-top:4px;accent-color:#7a9dff;flex:none}
.msm-candlist{max-height:300px;overflow:auto;margin:6px -4px;padding:0 4px;scrollbar-width:thin;scrollbar-color:rgba(120,140,220,.3) transparent}
.msm-spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:msm-rot .8s linear infinite;vertical-align:-2px;margin-right:7px}
@keyframes msm-rot{to{transform:rotate(360deg)}}
@keyframes msm-blink{50%{opacity:.3}}
.msm-panel::-webkit-scrollbar,.msm-candlist::-webkit-scrollbar{width:8px}
.msm-panel::-webkit-scrollbar-thumb,.msm-candlist::-webkit-scrollbar-thumb{background:rgba(120,140,220,.25);border-radius:4px}
.msm-panel::-webkit-scrollbar-thumb:hover,.msm-candlist::-webkit-scrollbar-thumb:hover{background:rgba(120,140,220,.45)}
`
    function ensureStyle() {
      try {
        if (document.getElementById(STYLE_ID)) return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        document.head.appendChild(el)
      } catch { /* 非浏览器环境兜底 */ }
    }

    // ---------- 3D 方向与布局 ----------
    function sph(yaw, pitch) {
      const cp = Math.cos(pitch)
      return { x: cp * Math.cos(yaw), y: Math.sin(pitch), z: cp * Math.sin(yaw) }
    }
    // 二十八宿在球壳上的方向：四象各占一个天区（7 宿散开成小星座）
    const MANSION_DIR = MANSIONS.map((m, i) => {
      const k = Math.floor(i / 7), j = i % 7
      const yaw = k * Math.PI / 2 + Math.PI / 4 + (j - 3) * 0.34
      const pitch = (k % 2 ? 0.34 : -0.34) + ((j % 3) - 1) * 0.38
      return sph(yaw, pitch)
    })
    function mansionIndex(star) {
      const i = MANSIONS.findIndex(m => m.n === star.mansion)
      return i >= 0 ? i : hashStr(star.id || star.title || '') % MANSIONS.length
    }
    function norm(v) {
      const l = Math.hypot(v.x, v.y, v.z) || 1
      return { x: v.x / l, y: v.y / l, z: v.z / l }
    }
    function tangentBasis(d) {
      const up = Math.abs(d.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
      const t1 = norm({ x: up.y * d.z - up.z * d.y, y: up.z * d.x - up.x * d.z, z: up.x * d.y - up.y * d.x })
      const t2 = norm({ x: d.y * t1.z - d.z * t1.y, y: d.z * t1.x - d.x * t1.z, z: d.x * t1.y - d.y * t1.x })
      return [t1, t2]
    }
    // 单颗记忆的 3D 位置：挂靠星宿方向 + 簇内扇形偏移
    function starLayout(stars) {
      const counter = new Map()
      return stars.map(star => {
        const mi = mansionIndex(star)
        const idx = counter.get(mi) || 0
        counter.set(mi, idx + 1)
        const base = MANSION_DIR[mi]
        const [t1, t2] = tangentBasis(base)
        const col = idx % 5, row = Math.floor(idx / 5)
        const o1 = (col - 2) * 0.13, o2 = (row - 1) * 0.15
        const dir = norm({
          x: base.x + t1.x * o1 + t2.x * o2,
          y: base.y + t1.y * o1 + t2.y * o2,
          z: base.z + t1.z * o1 + t2.z * o2,
        })
        const r = R_M + 80 + row * 70
        return {
          star, mi, dir, ts: Date.parse(star.time || '') || 0,
          pos: { x: dir.x * r, y: dir.y * r, z: dir.z * r },
          surf: { x: dir.x * R_E, y: dir.y * R_E, z: dir.z * R_E },
        }
      })
    }
    function rotate(p, yaw, pitch) {
      const cy = Math.cos(yaw), sy = Math.sin(yaw)
      const x1 = p.x * cy + p.z * sy, z1 = -p.x * sy + p.z * cy
      const cx = Math.cos(pitch), sx = Math.sin(pitch)
      const y2 = p.y * cx - z1 * sx, z2 = p.y * sx + z1 * cx
      return { x: x1, y: y2, z: z2 }
    }

    // ---------- 预烘焙光晕 sprite（发光不走 shadowBlur / 每帧渐变） ----------
    const SPRITE_CACHE = new Map()
    const SPR_SIZES = [8, 12, 16, 24, 32, 48, 72, 110, 160, 240]
    function glowSprite(rgb3, radius) {
      let s = SPR_SIZES[SPR_SIZES.length - 1]
      for (const cand of SPR_SIZES) { if (cand >= radius) { s = cand; break } }
      const key = rgb3 + '|' + s
      let cv = SPRITE_CACHE.get(key)
      if (!cv) {
        cv = document.createElement('canvas')
        cv.width = cv.height = s * 2
        const g = cv.getContext('2d')
        const grd = g.createRadialGradient(s, s, 0, s, s, s)
        grd.addColorStop(0, `rgba(${rgb3},1)`)
        grd.addColorStop(0.32, `rgba(${rgb3},0.4)`)
        grd.addColorStop(1, `rgba(${rgb3},0)`)
        g.fillStyle = grd
        g.fillRect(0, 0, s * 2, s * 2)
        SPRITE_CACHE.set(key, cv)
      }
      return { cv, s }
    }

    // ---------- 流星系统（参数取自 tsParticles / shooting-star-trails 实测区间） ----------
    const MET_ICE = '205,228,255'
    const MET_GOLD = '255,214,140'
    function createMeteors() {
      const list = []       // 飞行中的流星
      const flashes = []    // 命中/消亡闪光环
      let clock = 0
      let nextAt = 2.5      // 首颗稍快出现，让用户立刻看到效果

      function spawn(W, H, o) {
        if (!W || !H || list.length > 7) return
        o = o || {}
        const gold = o.gold != null ? o.gold : Math.random() < 0.22
        const speed = o.speed || (520 + Math.random() * 380)
        let sx, sy, vx, vy, dist
        if (o.tx != null && o.ty != null) {
          // 定向流星：从目标斜上方 260–420px 处飞向目标（庆祝「点亮」）
          const dirX = Math.random() < 0.5 ? 1 : -1
          const ang = (45 + Math.random() * 30) * Math.PI / 180
          dist = 260 + Math.random() * 160
          sx = o.tx - Math.cos(ang) * dist * dirX
          sy = o.ty - Math.sin(ang) * dist
          const dx = o.tx - sx, dy = o.ty - sy
          const l = Math.hypot(dx, dy) || 1
          vx = dx / l * speed; vy = dy / l * speed
        } else {
          // 环境流星：顶部随机 x，角度 55–70°，多向右下、少数左下
          const ang = (55 + Math.random() * 15) * Math.PI / 180
          const dirX = Math.random() < 0.72 ? 1 : -1
          sx = Math.random() * W * 1.2 - W * 0.1
          sy = Math.random() * H * 0.35 - H * 0.05
          vx = Math.cos(ang) * speed * dirX
          vy = Math.sin(ang) * speed
          dist = Math.hypot(W, H) * 1.4
        }
        list.push({
          x: sx, y: sy, vx, vy,
          traveled: 0,
          maxDist: dist,
          tail: o.tail || (160 + Math.random() * 140),
          rgb: gold ? MET_GOLD : MET_ICE,
          life: (o.life || (0.9 + Math.random() * 0.7)),
          t: 0,
        })
      }

      function shower(W, H, n) {
        n = n || 5
        for (let i = 0; i < n; i++) {
          setTimeout(() => spawn(W, H, { gold: Math.random() < 0.5, speed: 620 + Math.random() * 420 }), i * (120 + Math.random() * 260))
        }
      }

      function celebrate(W, H, x, y) {
        // 定向飞向某点（新星「诞生」）+ 一圈闪光
        spawn(W, H, { tx: x, ty: y, gold: true, speed: 700 })
        flashes.push({ x, y, t: 0, life: 0.7, rgb: MET_GOLD, r0: 4, r1: 34 })
      }

      function update(dt, W, H) {
        clock += dt
        if (clock > nextAt) {
          const visible = list.filter(m => m.maxDist > 0).length
          if (visible < 2) spawn(W, H)
          nextAt = clock + 4 + Math.random() * 6   // 每 4–10 秒一颗，同屏 ≤2
        }
        for (let i = list.length - 1; i >= 0; i--) {
          const m = list[i]
          const step = Math.hypot(m.vx, m.vy) * dt
          m.x += m.vx * dt; m.y += m.vy * dt
          m.traveled += step; m.t += dt
          const done = m.t > m.life || m.traveled > m.maxDist ||
            m.x < -400 || m.x > W + 400 || m.y > H + 400
          if (done) {
            if (m.maxDist < Math.hypot(W, H) * 1.4) {
              // 定向流星抵达：终点闪光
              flashes.push({ x: m.x, y: m.y, t: 0, life: 0.55, rgb: m.rgb, r0: 3, r1: 26 })
            }
            list.splice(i, 1)
          }
        }
        for (let i = flashes.length - 1; i >= 0; i--) {
          flashes[i].t += dt
          if (flashes[i].t > flashes[i].life) flashes.splice(i, 1)
        }
      }

      function draw(ctx) {
        if (list.length) {
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          for (const m of list) {
            const fade = clamp(1 - m.t / m.life, 0, 1) * clamp(m.t / 0.08, 0, 1)
            if (fade <= 0.01) continue
            const l = Math.hypot(m.vx, m.vy) || 1
            const tx = m.x - m.vx / l * m.tail, ty = m.y - m.vy / l * m.tail
            const grad = ctx.createLinearGradient(m.x, m.y, tx, ty)
            grad.addColorStop(0, `rgba(${m.rgb},${0.85 * fade})`)
            grad.addColorStop(0.55, `rgba(${m.rgb},${0.22 * fade})`)
            grad.addColorStop(1, `rgba(${m.rgb},0)`)
            ctx.strokeStyle = grad
            ctx.lineWidth = 1.8
            ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tx, ty); ctx.stroke()
            // 流星头
            const sp = glowSprite(m.rgb, 8)
            ctx.globalAlpha = fade
            ctx.drawImage(sp.cv, m.x - 8, m.y - 8, 16, 16)
            ctx.globalAlpha = 1
            ctx.fillStyle = `rgba(255,255,255,${0.9 * fade})`
            ctx.beginPath(); ctx.arc(m.x, m.y, 1.3, 0, TAU); ctx.fill()
          }
          ctx.restore()
        }
        if (flashes.length) {
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          for (const f of flashes) {
            const p = f.t / f.life
            const a = (1 - p) * 0.8
            ctx.strokeStyle = `rgba(${f.rgb},${a})`
            ctx.lineWidth = 1.4 * (1 - p) + 0.4
            ctx.beginPath(); ctx.arc(f.x, f.y, f.r0 + (f.r1 - f.r0) * p, 0, TAU); ctx.stroke()
          }
          ctx.restore()
        }
      }

      return { spawn, shower, celebrate, update, draw, get count() { return list.length } }
    }

    // ---------- 页面容器 ----------
    function StarMapPage(props) {
      ensureStyle()
      const [stars, setStars] = useState([])
      const [loaded, setLoaded] = useState(false)
      const [selectedId, setSelectedId] = useState(null)
      const [filter, setFilter] = useState('')
      const [form, setForm] = useState(null) // null | { editing: star | null }
      const [storeKind, setStoreKind] = useState('…') // 'host' | 'local' | '…'
      const [showExtract, setShowExtract] = useState(false)
      const [hiddenGroups, setHiddenGroups] = useState(() => new Set())
      const [autoSpin, setAutoSpin] = useState(true)
      const [showMansions, setShowMansions] = useState(false)
      const [mansionsVer, setMansionsVer] = useState(0)
      const [focusMode, setFocusMode] = useState(false)
      const [showConst, setShowConst] = useState(true)
      const [isolate, setIsolate] = useState(false)
      const [showStats, setShowStats] = useState(true)
      const [timeCut, setTimeCut] = useState(null) // null=全部；否则=时间戳，只显示 <= cut 的星
      const [playing, setPlaying] = useState(false)
      const cutRef = useRef(null) // 播放步进镜像，避免在 updater 里做副作用
      // 待认领区：提炼出的候选记忆，用户点亮后才入星图
      const [pending, setPending] = useState(() => {
        try { return JSON.parse(localStorage.getItem('dsh-memory-star-map-pending') || '[]') } catch { return [] }
      })
      const ctlRef = useRef({ reset() {}, shower() {} })

      // 调试钩子：仅当 localStorage 显式设置 dsh-memory-star-map-debug=1 时暴露，
      // 供自动化渲染验证使用（正常使用无副作用）
      try {
        if (localStorage.getItem('dsh-memory-star-map-debug') === '1') {
          window.__msmDebug = {
            setSelectedId,
            get stars() { return stars },
            get pending() { return pending },
            setFilter,
            ctl: ctlRef,
          }
        }
      } catch { /* 忽略 */ }

      const savePending = useCallback((list) => {
        setPending(list)
        try { localStorage.setItem('dsh-memory-star-map-pending', JSON.stringify(list)) } catch { /* 隐私模式等 */ }
      }, [])

      useEffect(() => {
        let alive = true
        ;(async () => {
          let fallback2 = null
          for (const base of API_BASES) {
            try {
              const r = await fetch(base)
              if (!r.ok) continue
              const d = await r.json()
              if (d && d.v === 3 && Array.isArray(d.stars)) {
                prefBase = base
                if (!alive) return
                if (Array.isArray(d.mansions)) { applyMansions(d.mansions); setMansionsVer(v => v + 1) }
                setStars(d.stars)
                setStoreKind('host')
                setLoaded(true)
                return
              }
              if (d && d.v === 2 && Array.isArray(d.stars) && !fallback2) fallback2 = { base, d }
            } catch { /* 换下一个候选 */ }
          }
          if (fallback2) {
            prefBase = fallback2.base
            if (!alive) return
            setStars(fallback2.d.stars)
            setStoreKind('host')
            setLoaded(true)
            return
          }
          try {
            const s = JSON.parse(localStorage.getItem('dsh-memory-star-map') || '{"stars":[]}')
            if (alive) {
              if (Array.isArray(s.mansions)) { applyMansions(s.mansions); setMansionsVer(v => v + 1) }
              setStars(s.stars || []); setStoreKind('local')
            }
          } catch { if (alive) { setStars([]); setStoreKind('local') } }
          finally { if (alive) setLoaded(true) }
        })()
        return () => { alive = false }
      }, [])

      const persist = useCallback(async (next) => {
        setStars(next)
        try { localStorage.setItem('dsh-memory-star-map', JSON.stringify({ stars: next, mansions: mansionsSnapshot() })) } catch { /* 忽略 */ }
        let fallbackOk = false
        for (const base of baseOrder()) {
          try {
            const r = await fetch(base, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ stars: next, mansions: mansionsSnapshot() }),
            })
            if (r.ok) {
              const j = await r.json().catch(() => null)
              if (j && j.ok === true && j.v === 3) { prefBase = base; setStoreKind('host'); return }
              if (j && j.ok === true && j.v === 2) fallbackOk = true
            }
          } catch { /* 换下一个候选 */ }
        }
        if (fallbackOk) { setStoreKind('host'); return }
        setStoreKind('local')
      }, [])

      const matchIds = useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return null
        const set = new Set()
        for (const s of stars) {
          const hay = [s.title, s.content, (s.tags || []).join(' '), s.mansion].join(' ').toLowerCase()
          if (hay.includes(q)) set.add(s.id)
        }
        return set
      }, [stars, filter])
      const matchCount = matchIds ? matchIds.size : stars.length

      const layout = useMemo(() => starLayout(stars), [stars])

      // 语义星座：同 tag 自动连线
      const linksMap = useMemo(() => computeLinks(stars), [stars])
      // 时间轴范围
      const timeSpan = useMemo(() => {
        let t0 = Infinity, t1 = -Infinity
        for (const s of stars) { const t = Date.parse(s.time || '') || 0; if (t > 0) { if (t < t0) t0 = t; if (t > t1) t1 = t } }
        if (t1 < 0) return null
        return { t0, t1: Math.max(t1, Date.now()) }
      }, [stars])
      const cutChanged = useCallback((v) => { cutRef.current = v; setTimeCut(v) }, [])
      // 回放：80ms 步进，全程约 12s
      useEffect(() => {
        if (!playing || !timeSpan) return
        const span = Math.max(1, timeSpan.t1 - timeSpan.t0)
        const step = span / 150
        const id = setInterval(() => {
          const cur = cutRef.current == null ? timeSpan.t0 : cutRef.current
          const nx = cur + step
          if (nx >= timeSpan.t1) { cutChanged(null); setPlaying(false) }
          else cutChanged(nx)
        }, 80)
        return () => clearInterval(id)
      }, [playing, timeSpan, cutChanged])
      const togglePlay = useCallback(() => {
        if (!timeSpan) return
        setPlaying(p => {
          if (!p && cutRef.current == null) cutChanged(timeSpan.t0)
          return !p
        })
      }, [timeSpan, cutChanged])
      // 统计
      const stats = useMemo(() => {
        const now = Date.now()
        let week = 0, month = 0
        const mc = new Map()
        for (const s of stars) {
          const age = now - (Date.parse(s.time || '') || 0)
          if (age < 7 * 864e5) week++
          if (age < 30 * 864e5) month++
          const mi = mansionIndex(s)
          mc.set(mi, (mc.get(mi) || 0) + 1)
        }
        let topMi = -1, topN = 0
        for (const [mi, n] of mc) if (n > topN) { topN = n; topMi = mi }
        let topLink = null, topLn = 0
        for (const [id, set] of linksMap) if (set.size > topLn) { topLn = set.size; topLink = id }
        const months = []
        for (let i = 5; i >= 0; i--) {
          const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - i)
          const nx = new Date(d); nx.setMonth(nx.getMonth() + 1)
          let c = 0
          for (const s of stars) { const t = Date.parse(s.time || '') || 0; if (t >= d.getTime() && t < nx.getTime()) c++ }
          months.push({ label: (d.getMonth() + 1) + '月', c })
        }
        return { total: stars.length, week, month, topMi, topN, topLink, topLn, months }
      }, [stars, linksMap, mansionsVer])
      // 聚焦邻域（ego-network）
      const focusSet = useMemo(() => {
        if (!focusMode || !selectedId) return null
        const set = new Set([selectedId])
        const lk = linksMap.get(selectedId)
        if (lk) for (const oid of lk) set.add(oid)
        return set
      }, [focusMode, selectedId, linksMap])
      // 搜索隔离
      const isolateIds = (isolate && matchIds) ? matchIds : null
      // 导出
      const exportPNG = useCallback(() => {
        const cv = document.querySelector('.msm-stage canvas')
        if (!cv) return
        cv.toBlob((b) => {
          if (!b) return
          const a = document.createElement('a')
          a.href = URL.createObjectURL(b)
          a.download = 'memory-star-map-' + Date.now().toString(36) + '.png'
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 4000)
        }, 'image/png')
      }, [])
      const exportJSON = useCallback(() => {
        const blob = new Blob([JSON.stringify({ v: 3, stars, mansions: mansionsSnapshot() }, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'memory-star-map.json'
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      }, [stars])
      const focusStar = useCallback((id) => {
        const it = layout.find(l => l.star.id === id)
        setSelectedId(id)
        if (it && ctlRef.current.focusOn) { setFocusMode(true); ctlRef.current.focusOn(it.pos, 1.7) }
      }, [layout])
      useEffect(() => { if (!selectedId) setFocusMode(false) }, [selectedId])
      // Esc 级联退出
      useEffect(() => {
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          if (focusMode) { setFocusMode(false); return }
          if (form) { setForm(null); return }
          if (showExtract) { setShowExtract(false); return }
          if (showMansions) setShowMansions(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [focusMode, form, showExtract, showMansions])
      try {
        if (window.__msmDebug) {
          window.__msmDebug.focusStar = focusStar
          window.__msmDebug.setCut = cutChanged
          window.__msmDebug.togglePlay = togglePlay
        }
      } catch { /* 忽略 */ }

      const groupCounts = useMemo(() => {
        const c = { 青龙: 0, 朱雀: 0, 白虎: 0, 玄武: 0 }
        for (const s of stars) c[MANSIONS[mansionIndex(s)].g]++
        return c
      }, [stars, mansionsVer])

      const saveStar = useCallback(async (star) => {
        const idx = stars.findIndex(s => s.id === star.id)
        // 新记忆未指定星宿时自动分配（轮转二十八宿）
        if (idx < 0 && !star.mansion) {
          star = { ...star, mansion: MANSIONS[stars.length % MANSIONS.length].n }
        }
        const next = idx >= 0
          ? stars.map(s => (s.id === star.id ? star : s))
          : [...stars, star]
        await persist(next)
        setForm(null)
        setSelectedId(star.id)
        if (idx < 0) ctlRef.current.shower(4) // 新星诞生 → 流星庆祝
      }, [stars, persist])

      const deleteStar = useCallback(async (id) => {
        await persist(stars.filter(s => s.id !== id))
        setSelectedId(null)
      }, [stars, persist])

      // 星宿改名：同步改写既有记忆的归属名（含互换名的情况），连同星数据一起持久化
      const saveMansions = useCallback(async (list) => {
        const oldNames = MANSIONS.map(m => m.n)
        applyMansions(list)
        const renamed = {}
        oldNames.forEach((on, i) => { if (on !== MANSIONS[i].n) renamed[on] = MANSIONS[i].n })
        const nextStars = Object.keys(renamed).length
          ? stars.map(s => (renamed[s.mansion] ? { ...s, mansion: renamed[s.mansion] } : s))
          : stars
        setMansionsVer(v => v + 1)
        await persist(nextStars)
      }, [stars, persist])

      // 点亮：把勾选的候选记忆变成星（自动分配星宿），从待认领区移除
      const acceptCandidates = useCallback(async (cands) => {
        const base = stars.length
        const newStars = cands.map((c, i) => ({
          id: genId(),
          title: c.title,
          content: c.content || '',
          tags: c.tags || [],
          links: [],
          source: 'auto',
          from: c.from || '',
          time: new Date().toISOString(),
          importance: c.importance || 3,
          mansion: (typeof c.mansion === 'number' && c.mansion >= 0 && c.mansion < MANSIONS.length)
            ? MANSIONS[c.mansion].n
            : (typeof c.mansion === 'string' && c.mansion ? c.mansion : MANSIONS[(base + i) % MANSIONS.length].n),
        }))
        await persist([...stars, ...newStars])
        savePending(pending.filter(p => cands.indexOf(p) < 0))
        ctlRef.current.shower(clamp(2 + cands.length, 3, 8)) // 点亮越多，流星越热闹
      }, [stars, pending, persist, savePending])

      const toggleGroup = useCallback((g) => {
        setHiddenGroups(prev => {
          const next = new Set(prev)
          if (next.has(g)) next.delete(g); else next.add(g)
          return next
        })
      }, [])

      const selected = stars.find(s => s.id === selectedId) || null
      const shower = () => ctlRef.current.shower(6)

      return h('div', { className: 'msm-root' },
        h('div', { className: 'msm-toolbar' },
          h('span', { className: 'msm-brand' }, h(Logo), '记忆星图'),
          h('span', { className: 'msm-stat' },
            h('span', {
              className: 'msm-dot' + (storeKind === 'local' ? ' local' : storeKind === 'host' ? '' : ' wait'),
            }),
            storeKind === 'local' ? '本地暂存' : storeKind === 'host' ? '主机存储' : '连接中…'),
          h('span', { className: 'msm-stat' },
            matchIds ? `记忆 ${stars.length} · 命中 ${matchCount}` : `记忆 ${stars.length} 颗`),
          h('input', {
            className: 'msm-search', placeholder: '🔍 搜索标题 / 内容 / 标签…', value: filter,
            onChange: e => setFilter(e.target.value), 'aria-label': '搜索记忆',
          }),
          filter && matchIds && h('button', {
            className: 'msm-btn ghost msm-mini' + (isolate ? '' : ' off'),
            onClick: () => setIsolate(v => !v),
            title: isolate ? '取消隔离，显示全部记忆' : '只看命中，隔离其余记忆',
          }, isolate ? '隔离中' : '隔离'),
          h('button', {
            className: 'msm-btn ghost msm-icon-btn' + (autoSpin ? '' : ' off'),
            onClick: () => setAutoSpin(v => !v),
            title: autoSpin ? '暂停空闲自转' : '恢复空闲自转', 'aria-label': '自转开关',
          }, '⟳'),
          h('button', {
            className: 'msm-btn ghost msm-icon-btn',
            onClick: () => ctlRef.current.reset(), title: '复位视角', 'aria-label': '复位视角',
          }, '⌖'),
          h('button', {
            className: 'msm-btn shower msm-icon-btn',
            onClick: shower, title: '来一场流星雨', 'aria-label': '流星雨',
          }, '☄'),
          h('button', {
            className: 'msm-btn ghost msm-icon-btn' + (showConst ? '' : ' off'),
            onClick: () => setShowConst(v => !v), title: '星座连线：自动连接共享标签的记忆', 'aria-label': '星座连线',
          }, '✧'),
          h('button', {
            className: 'msm-btn ghost msm-icon-btn',
            onClick: exportPNG, title: '导出星图 PNG', 'aria-label': '导出 PNG',
          }, '📷'),
          h('button', {
            className: 'msm-btn ghost msm-icon-btn',
            onClick: exportJSON, title: '导出数据 JSON', 'aria-label': '导出 JSON',
          }, '⤓'),
          h('button', {
            className: 'msm-btn ghost msm-icon-btn' + (showStats ? '' : ' off'),
            onClick: () => setShowStats(v => !v), title: '星海统计面板', 'aria-label': '统计',
          }, '📊'),
          h('button', {
            className: 'msm-btn ghost',
            onClick: () => setShowMansions(v => !v),
            title: '二十八宿 = 28 个技艺大类，可改名归类',
          }, '🏷 星宿'),
          h('button', { className: 'msm-btn', onClick: () => setForm({ editing: null }) }, '＋ 新记忆'),
          h('button', {
            className: 'msm-btn violet',
            onClick: () => setShowExtract(v => !v),
          }, pending.length ? `✨ 提炼会话 (${pending.length})` : '✨ 提炼会话'),
        ),
        h('div', { className: 'msm-stage' },
          h(StarMapCanvas, {
            layout, matchIds, hiddenGroups, selectedId, setSelectedId,
            loaded, autoSpin, ctlRef,
            linksMap, focusSet, showConst, isolateIds, timeCut, onFocusStar: focusStar,
          }),
          loaded && stars.length === 0 && !form && h('div', { className: 'msm-empty' },
            h('span', null, '星海空空，还没有一颗记忆之星'),
            h('button', { className: 'msm-btn', onClick: () => setForm({ editing: null }) }, '种下第一颗星'),
            h('button', { className: 'msm-btn ghost', onClick: () => setShowExtract(true) }, '✨ 从会话提炼'),
          ),
          timeSpan && stars.length > 2 && h('div', { className: 'msm-timeline' },
            h('button', {
              className: 'msm-tl-btn', title: '回到最早',
              onClick: () => { setPlaying(false); cutChanged(timeSpan.t0) },
            }, '⏮'),
            h('button', {
              className: 'msm-tl-btn', title: playing ? '暂停' : '播放记忆诞生史',
              onClick: togglePlay,
            }, playing ? '⏸' : '▶'),
            h('button', {
              className: 'msm-tl-btn', title: '回到现在',
              onClick: () => { setPlaying(false); cutChanged(null) },
            }, '⏭'),
            h('input', {
              type: 'range', min: timeSpan.t0, max: timeSpan.t1, step: Math.max(1, Math.round((timeSpan.t1 - timeSpan.t0) / 500)),
              value: timeCut == null ? timeSpan.t1 : Math.min(Math.max(timeCut, timeSpan.t0), timeSpan.t1),
              onChange: (e) => { setPlaying(false); cutChanged(Number(e.target.value)) },
              'aria-label': '时间回放',
            }),
            h('span', { className: 'msm-tl-date' }, timeCut == null ? '至今' : fmtDate(timeCut)),
          ),
          showStats && stars.length > 0 && h(StatsHud, {
            stats, stars,
            onClose: () => setShowStats(false),
            onJump: (id) => focusStar(id),
          }),
          selected && !form && h(DetailPanel, {
            key: selected.id,
            star: selected,
            onEdit: () => setForm({ editing: selected }),
            onDelete: () => deleteStar(selected.id),
            onClose: () => setSelectedId(null),
            onTagClick: (t) => setFilter(t),
            focusMode,
            onFocus: () => focusStar(selected.id),
            onExitFocus: () => setFocusMode(false),
            relStars: Array.from(linksMap.get(selected.id) || []).map(oid => stars.find(s => s.id === oid)).filter(Boolean).map(s => ({ id: s.id, title: s.title || '(无题)', mi: mansionIndex(s) })),
            onRelClick: (id) => focusStar(id),
          }),
          form && h(StarForm, {
            editing: form.editing,
            onCancel: () => setForm(null),
            onSubmit: saveStar,
          }),
          showExtract && h(ExtractPanel, {
            pending, savePending, onAccept: acceptCandidates,
            onClose: () => setShowExtract(false),
            onShower: (n) => ctlRef.current.shower(n),
          }),
          showMansions && h(MansionPanel, {
            stars,
            onClose: () => setShowMansions(false),
            onSave: saveMansions,
          }),
        ),
        h('div', { className: 'msm-legend' },
          Object.keys(GROUP_COLOR).map(g =>
            h('button', {
              key: g,
              className: 'msm-gchip' + (hiddenGroups.has(g) ? ' off' : ''),
              onClick: () => toggleGroup(g),
              title: hiddenGroups.has(g) ? `显示${g}七宿` : `隐藏${g}七宿`,
            },
              h('span', { className: 'msm-gdot', style: { background: GROUP_COLOR[g], boxShadow: `0 0 7px ${GROUP_COLOR[g]}` } }),
              g, h('span', { style: { opacity: 0.65, fontWeight: 400 } }, groupCounts[g] || ''))),
          h('span', { className: 'msm-hint' }, '拖拽旋转 · 滚轮缩放 · 双击星点聚焦其记忆网络 · 双击空处复位 · Esc 退出 · 流星划过时许个愿'),
        ),
      )
    }

    // ---------- 星宿管理：二十八宿 = 28 个技艺大类（可改名） ----------
    function StatsHud({ stats, stars, onClose, onJump }) {
      const maxM = Math.max(1, ...stats.months.map(m => m.c))
      const topStar = stats.topLink ? stars.find(s => s.id === stats.topLink) : null
      return h('div', { className: 'msm-hud' },
        h('div', { className: 'msm-hud-t' }, '✦ 星海统计', h('button', { className: 'msm-hud-x', onClick: onClose, title: '收起统计' }, '×')),
        h('div', { className: 'msm-hud-row' }, h('span', null, '记忆总数'), h('b', null, String(stats.total))),
        h('div', { className: 'msm-hud-row' }, h('span', null, '近 7 天'), h('b', null, '+' + stats.week)),
        h('div', { className: 'msm-hud-row' }, h('span', null, '近 30 天'), h('b', null, '+' + stats.month)),
        stats.topMi >= 0 && h('div', { className: 'msm-hud-row' },
          h('span', null, '最活跃'),
          h('span', { style: { color: GROUP_COLOR[MANSIONS[stats.topMi].g] || '#c9d6f5', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            MANSIONS[stats.topMi].n + ' ×' + stats.topN)),
        topStar && h('div', { className: 'msm-hud-row' },
          h('span', null, '最连接'),
          h('a', { className: 'msm-hud-link', title: '点击聚焦: ' + topStar.title, onClick: () => onJump(topStar.id) }, topStar.title || '(无题)')),
        h('div', { className: 'msm-spark' },
          stats.months.map((m, i) => h('i', { key: i, title: m.label + ' 新增 ' + m.c + ' 颗', style: { height: Math.max(2, Math.round(m.c / maxM * 22)) + 'px' } }))),
        h('div', { className: 'msm-spark-lab' }, h('span', null, '近 6 个月'), h('span', null, stats.months.map(m => m.c).reduce((a, b) => a + b, 0) + ' 颗')),
      )
    }
    function MansionPanel({ stars, onClose, onSave }) {
      const [draft, setDraft] = useState(() => MANSIONS.map(m => ({ name: m.n, desc: m.d || '' })))
      const counts = useMemo(() => {
        const c = new Array(MANSIONS.length).fill(0)
        for (const s of stars) c[mansionIndex(s)]++
        return c
      }, [stars])
      const dirty = useMemo(() => draft.some((d, i) => d.name.trim() !== MANSIONS[i].n), [draft])
      const setName = (i, v) => setDraft(prev => prev.map((d, j) => (j === i ? { ...d, name: v } : d)))
      return h('div', { className: 'msm-panel right', style: { width: 'min(420px,calc(100% - 28px))' } },
        h('div', { className: 'msm-panel-head' },
          h('b', null, '🏷 星宿 · 技艺大类'),
          h('button', { className: 'msm-x', onClick: onClose, title: '关闭', 'aria-label': '关闭' }, '✕'),
        ),
        h('div', { className: 'msm-panel-body' },
          h('div', { className: 'msm-meta', style: { marginBottom: 10 } },
            '每宿即一个技艺大类：改成「摄影」，摄影类记忆就会挂到这颗星下并在类内连线；会话提炼也会自动归入最匹配的大类。'),
          draft.map((d, i) => h('div', { key: i, className: 'msm-mrow' },
            h('span', { className: 'msm-gdot', style: { background: MANSIONS[i].c, boxShadow: `0 0 7px ${MANSIONS[i].c}` } }),
            h('span', { className: 'msm-midx' }, String(i + 1).padStart(2, '0')),
            h('input', {
              className: 'msm-input', value: d.name, maxLength: 24,
              onChange: e => setName(i, e.target.value),
              'aria-label': `第 ${i + 1} 宿名称`,
            }),
            h('span', { className: 'msm-mcount', title: '该大类下的记忆数' }, counts[i] || 0))),
        ),
        h('div', { className: 'msm-panel-foot' },
          h('button', {
            className: 'msm-btn green', disabled: !dirty,
            onClick: () => onSave(draft.map((d, i) => ({ ...d, name: d.name.trim() || MANSIONS[i].n }))),
          }, '💾 保存改名'),
          h('button', {
            className: 'msm-btn ghost',
            onClick: () => setDraft(DEFAULT_MANSION_NAMES.map(n => ({ name: n, desc: '' }))),
          }, '恢复默认'),
        ),
      )
    }

    // ---------- 品牌小图标（内联 SVG） ----------
    function Logo() {
      return h('svg', { className: 'msm-logo', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('defs', null,
          h('linearGradient', { id: 'msm-logo-g', x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0', stopColor: '#7aa5ff' }),
            h('stop', { offset: '1', stopColor: '#4fe3c1' }))),
        h('circle', { cx: '12', cy: '13.5', r: '6.2', stroke: 'url(#msm-logo-g)', strokeWidth: '1.5', opacity: '0.95' }),
        h('ellipse', { cx: '12', cy: '13.5', rx: '9.4', ry: '3.4', stroke: '#8fb2ff', strokeWidth: '0.9', opacity: '0.5', transform: 'rotate(-18 12 13.5)' }),
        h('path', { d: 'M4.2 5.4 L10.4 9.2', stroke: '#ffd479', strokeWidth: '1.6', strokeLinecap: 'round' }),
        h('circle', { cx: '10.9', cy: '9.5', r: '1.15', fill: '#fff3d6' }),
        h('circle', { cx: '15.4', cy: '11.6', r: '0.9', fill: '#dbe7fb' }),
      )
    }
    function MiniIcon() {
      return h('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('circle', { cx: '12', cy: '13.5', r: '6.2', stroke: '#7aa5ff', strokeWidth: '1.8' }),
        h('path', { d: 'M4.2 5.4 L10.4 9.2', stroke: '#ffd479', strokeWidth: '2', strokeLinecap: 'round' }),
        h('circle', { cx: '10.9', cy: '9.5', r: '1.4', fill: '#fff3d6' }),
      )
    }

    // ---------- 3D 画布 ----------
    // 绘制项类型（类型化条目，避免每帧创建大量闭包）
    const T_LINE = 1, T_DASH = 2, T_GLOW = 3, T_DOT = 4, T_RING = 5, T_GRADLINE = 6, T_LINK = 7

    function StarMapCanvas({ layout, matchIds, hiddenGroups, selectedId, setSelectedId, loaded, autoSpin, ctlRef, linksMap, focusSet, showConst, isolateIds, timeCut, onFocusStar }) {
      const wrapRef = useRef(null)
      const canvasRef = useRef(null)
      const tooltipRef = useRef(null)
      const sizeRef = useRef({ w: 0, h: 0 })
      // 相机状态完全 ref 化：动画循环不再触发 React 重渲染
      const viewRef = useRef({ yaw: HOME.yaw, pitch: HOME.pitch, k: HOME.k, targetK: HOME.k, vy: 0, vp: 0, resetting: false, fly: null })
      const layoutRef = useRef(layout); layoutRef.current = layout
      const matchRef = useRef(matchIds); matchRef.current = matchIds
      const hiddenRef = useRef(hiddenGroups); hiddenRef.current = hiddenGroups
      const selRef = useRef(selectedId); selRef.current = selectedId
      const spinRef = useRef(autoSpin); spinRef.current = autoSpin
      const loadedRef = useRef(loaded); loadedRef.current = loaded
      const linksRef = useRef(linksMap); linksRef.current = linksMap
      const focusRef = useRef(focusSet); focusRef.current = focusSet
      const constRef = useRef(showConst); constRef.current = showConst
      const isoRef = useRef(isolateIds); isoRef.current = isolateIds
      const tcRef = useRef(timeCut); tcRef.current = timeCut
      const prevTcRef = useRef(null)
      const focusFnRef = useRef(onFocusStar); focusFnRef.current = onFocusStar
      const dragRef = useRef(null)       // { id, sx, sy, yaw, pitch, moved, lastX, lastY, lastT }
      const pointersRef = useRef(new Map()) // pointerId -> {x,y}（双指捏合）
      const pinchRef = useRef(null)      // { dist, k0 }
      const lastActRef = useRef(0)
      const screenRef = useRef([])       // 每帧投影结果，供点击/悬停命中
      const hoverRef = useRef(null)      // 悬停中的星 id
      const [hover, setHover] = useState(null) // { id, title, mansion, imp, tags } —— 仅 id 变化时 setState
      const bgRef = useRef(null)         // 静态背景层（星云+银河+底色）
      const twinkleRef = useRef([])      // 闪烁星（归一化坐标，resize 免重建）
      const metRef = useRef(null)        // 流星系统
      const bornRef = useRef(new Map())  // id -> 诞生时刻（秒）
      const seenRef = useRef(new Set())  // 已见过的星 id（首帧不庆祝）
      const firstRef = useRef(true)

      if (!metRef.current && typeof document !== 'undefined') metRef.current = createMeteors()

      // 尺寸观察 + 静态背景重建
      useEffect(() => {
        const el = wrapRef.current
        if (!el) return
        const rebuild = () => {
          const r = el.getBoundingClientRect()
          const w = Math.max(1, r.width), hh = Math.max(1, r.height)
          if (Math.abs(sizeRef.current.w - w) < 1 && Math.abs(sizeRef.current.h - hh) < 1) return
          sizeRef.current = { w, h: hh }
          bgRef.current = buildBackground(w, hh)
        }
        rebuild()
        const ro = new ResizeObserver(rebuild)
        ro.observe(el)
        return () => ro.disconnect()
      }, [])

      // 闪烁星一次性生成（归一化坐标）
      useEffect(() => {
        const rnd = mulberry32(20261120)
        const arr = []
        for (let i = 0; i < 300; i++) {
          const depth = 0.2 + rnd() * 0.8
          arr.push({
            fx: rnd(), fy: rnd(),
            r: 0.4 + depth * 1.25,
            base: 0.16 + rnd() * 0.5,
            sp: depth > 0.75 ? 0.6 + rnd() * 1.1 : 1.6 + rnd() * 2.4, // 亮星闪得慢
            ph: rnd() * TAU,
            flare: depth > 0.93,
          })
        }
        twinkleRef.current = arr
      }, [])

      // 对外控制接口（复位 / 流星雨）
      useEffect(() => {
        ctlRef.current = {
          reset() {
            const v = viewRef.current
            v.resetting = true
            v.fly = null
            v.targetK = HOME.k
            v.vy = 0; v.vp = 0
          },
          shower(n) {
            const { w, h } = sizeRef.current
            if (metRef.current) metRef.current.shower(w, h, n || 5)
          },
          // 聚焦飞行：把 pos 转到视线中心（前向 -Z），cubicInOut 0.95s
          focusOn(pos, k) {
            const v = viewRef.current
            const Lxz = Math.hypot(pos.x, pos.z)
            let yawT = Math.atan2(-pos.x, pos.z) + Math.PI
            yawT += Math.round((v.yaw - yawT) / TAU) * TAU // 取最近等价角，防止长旋转
            const pitchT = clamp(-Math.atan2(pos.y, Lxz), -1.35, 1.35)
            v.fly = { y0: v.yaw, p0: v.pitch, k0: v.k, y1: yawT, p1: pitchT, k1: k || 1.8, t: 0, dur: 0.95 }
            v.resetting = false
            v.vy = 0; v.vp = 0
          },
        }
      }, [ctlRef])

      // ---------- 主绘制循环 ----------
      useEffect(() => {
        let raf = 0
        let last = 0
        const loop = (nowMs) => {
          raf = requestAnimationFrame(loop)
          if (!last) last = nowMs
          const dt = Math.min(0.05, (nowMs - last) / 1000)
          last = nowMs
          frame(dt, nowMs / 1000)
        }
        raf = requestAnimationFrame(loop)
        return () => cancelAnimationFrame(raf)
      }, [])

      function frame(dt, t) {
        const cv = canvasRef.current
        const { w: W, h: H } = sizeRef.current
        if (!cv || W < 2 || H < 2) return
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
          cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr)
        }
        const ctx = cv.getContext('2d', { alpha: false })
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

        const v = viewRef.current
        const dragging = !!dragRef.current
        // 相机：聚焦飞行 > 复位缓动 > 惯性/空闲自转 + 缩放平滑
        if (v.fly) {
          v.fly.t += dt
          const u = Math.min(1, v.fly.t / v.fly.dur)
          const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2 // cubicInOut
          v.yaw = v.fly.y0 + (v.fly.y1 - v.fly.y0) * e
          v.pitch = v.fly.p0 + (v.fly.p1 - v.fly.p0) * e
          v.k = v.fly.k0 + (v.fly.k1 - v.fly.k0) * e
          v.targetK = v.fly.k1
          if (u >= 1) { v.k = v.fly.k1; v.fly = null; lastActRef.current = t * 1000 }
        } else if (v.resetting) {
          const ty = HOME.yaw + Math.round((v.yaw - HOME.yaw) / TAU) * TAU
          v.yaw += (ty - v.yaw) * Math.min(1, dt * 7)
          v.pitch += (HOME.pitch - v.pitch) * Math.min(1, dt * 7)
          if (Math.abs(ty - v.yaw) < 0.004 && Math.abs(HOME.pitch - v.pitch) < 0.004) {
            v.yaw = ty; v.pitch = HOME.pitch; v.resetting = false
          }
        } else if (!dragging) {
          if (Math.abs(v.vy) > 1e-5 || Math.abs(v.vp) > 1e-5) {
            v.yaw += v.vy * dt
            v.pitch = clamp(v.pitch + v.vp * dt, -1.35, 1.35)
            const decay = Math.exp(-dt * 3.4)
            v.vy *= decay; v.vp *= decay
          } else if (spinRef.current && t * 1000 - lastActRef.current > 2500) {
            v.yaw += AUTO_SPIN * dt
          }
        }
        v.k += (v.targetK - v.k) * Math.min(1, dt * 9)
        const { yaw, pitch, k } = v

        // 1) 静态深空背景（星云 + 银河，烘焙层）
        const bg = bgRef.current
        if (bg) ctx.drawImage(bg, 0, 0, W, H)
        else { ctx.fillStyle = '#05070f'; ctx.fillRect(0, 0, W, H) }

        // 2) 闪烁星
        ctx.fillStyle = '#cddaff'
        for (const s of twinkleRef.current) {
          const wave = Math.sin(t * s.sp + s.ph)
          const a = s.base * (0.45 + 0.55 * wave)
          if (a < 0.02) continue
          const x = s.fx * W, y = s.fy * H
          ctx.globalAlpha = a
          ctx.beginPath(); ctx.arc(x, y, s.r, 0, TAU); ctx.fill()
          if (s.flare && wave > 0.9) {
            const fa = (wave - 0.9) * 6 * s.base
            const L = 2.5 + s.r * 3
            ctx.globalAlpha = fa
            ctx.strokeStyle = '#e6eeff'; ctx.lineWidth = 0.7
            ctx.beginPath()
            ctx.moveTo(x - L, y); ctx.lineTo(x + L, y)
            ctx.moveTo(x, y - L); ctx.lineTo(x, y + L)
            ctx.stroke()
          }
        }
        ctx.globalAlpha = 1

        // 3) 环境流星（在星图场景之后，成为天空前景）
        const met = metRef.current
        if (met) met.update(dt, W, H)

        const proj = (p) => {
          const r = rotate(p, yaw, pitch)
          const s = PERS / (PERS + r.z)
          return { x: W / 2 + r.x * s * k, y: H / 2 + r.y * s * k, z: r.z, s }
        }
        const depthAlpha = (z) => clamp(0.28 + 0.72 * ((PERS * 0.45 - z) / (PERS * 0.9)), 0.16, 1)

        // 4) 玻璃地球 + 装饰轨道环
        const c0 = proj({ x: 0, y: 0, z: 0 })
        const gR = R_E * c0.s * k
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const halo = glowSprite('74,134,255', gR * 1.8)
        ctx.globalAlpha = 0.34
        ctx.drawImage(halo.cv, c0.x - gR * 1.8, c0.y - gR * 1.8, gR * 3.6, gR * 3.6)
        ctx.restore()
        ctx.globalAlpha = 1
        const globe = ctx.createRadialGradient(c0.x - gR * 0.34, c0.y - gR * 0.38, gR * 0.05, c0.x, c0.y, gR)
        globe.addColorStop(0, 'rgba(122,182,255,0.32)')
        globe.addColorStop(0.42, 'rgba(43,98,190,0.28)')
        globe.addColorStop(0.8, 'rgba(15,42,98,0.34)')
        globe.addColorStop(1, 'rgba(7,20,54,0.52)')
        ctx.fillStyle = globe
        ctx.beginPath(); ctx.arc(c0.x, c0.y, gR, 0, TAU); ctx.fill()
        // 晨昏线 + 经纬网 + 高光（裁进圆盘内）
        ctx.save()
        ctx.beginPath(); ctx.arc(c0.x, c0.y, gR, 0, TAU); ctx.clip()
        const term = ctx.createRadialGradient(c0.x - gR * 0.5, c0.y - gR * 0.55, gR * 0.25, c0.x - gR * 0.5, c0.y - gR * 0.55, gR * 1.95)
        term.addColorStop(0, 'rgba(2,6,18,0)')
        term.addColorStop(0.6, 'rgba(2,6,18,0)')
        term.addColorStop(1, 'rgba(2,6,18,0.6)')
        ctx.fillStyle = term
        ctx.fillRect(c0.x - gR, c0.y - gR, gR * 2, gR * 2)
        ctx.strokeStyle = 'rgba(150,200,255,0.09)'; ctx.lineWidth = 1
        for (const f of [0.36, 0.7]) {
          ctx.beginPath(); ctx.ellipse(c0.x, c0.y, gR, gR * f, 0, 0, TAU); ctx.stroke()
          ctx.beginPath(); ctx.ellipse(c0.x, c0.y, gR * f, gR, 0, 0, TAU); ctx.stroke()
        }
        const spec = ctx.createRadialGradient(c0.x - gR * 0.42, c0.y - gR * 0.46, 0, c0.x - gR * 0.42, c0.y - gR * 0.46, gR * 0.52)
        spec.addColorStop(0, 'rgba(255,255,255,0.22)')
        spec.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = spec
        ctx.fillRect(c0.x - gR, c0.y - gR, gR * 2, gR * 2)
        ctx.restore()
        // 菲涅尔边缘：越靠边越亮
        const rim = ctx.createRadialGradient(c0.x, c0.y, gR * 0.7, c0.x, c0.y, gR)
        rim.addColorStop(0, 'rgba(150,200,255,0)')
        rim.addColorStop(0.85, 'rgba(150,200,255,0.14)')
        rim.addColorStop(1, 'rgba(196,228,255,0.55)')
        ctx.strokeStyle = rim; ctx.lineWidth = 1.4
        ctx.beginPath(); ctx.arc(c0.x, c0.y, gR - 0.7, 0, TAU); ctx.stroke()
        // 倾斜轨道环 + 一颗巡游的金色小卫星
        const tilt = -0.38 + Math.sin(t * 0.06) * 0.12
        ctx.save()
        ctx.strokeStyle = 'rgba(140,180,255,0.16)'
        ctx.setLineDash([3, 5]); ctx.lineWidth = 1
        ctx.beginPath(); ctx.ellipse(c0.x, c0.y, gR * 1.5, gR * 0.44, tilt, 0, TAU); ctx.stroke()
        ctx.setLineDash([])
        const sa = t * 0.45
        const ex = Math.cos(sa) * gR * 1.5, ey = Math.sin(sa) * gR * 0.44
        const sxp = c0.x + ex * Math.cos(tilt) - ey * Math.sin(tilt)
        const syp = c0.y + ex * Math.sin(tilt) + ey * Math.cos(tilt)
        const front = Math.sin(sa) > 0
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = front ? 0.9 : 0.22
        const sat = glowSprite('255,214,140', 8)
        ctx.drawImage(sat.cv, sxp - 5, syp - 5, 10, 10)
        ctx.fillStyle = 'rgba(255,240,205,0.95)'
        ctx.beginPath(); ctx.arc(sxp, syp, front ? 1.6 : 1, 0, TAU); ctx.fill()
        ctx.restore()
        ctx.globalAlpha = 1

        const Lraw = layoutRef.current
        const match = matchRef.current
        const hidden = hiddenRef.current
        const hoverId = hoverRef.current
        const iso = isoRef.current
        const tc = tcRef.current
        const fs = focusRef.current
        const L = (tc != null || iso)
          ? Lraw.filter(l => (tc == null || (l.ts || 0) <= tc) && (!iso || iso.has(l.star.id)))
          : Lraw
        // 星诞生追踪（新星有 1.2s 的点亮动画）
        if (firstRef.current && loadedRef.current) {
          firstRef.current = false
          for (const it of L) { seenRef.current.add(it.star.id); bornRef.current.set(it.star.id, -10) }
        }
        for (const it of L) {
          if (!seenRef.current.has(it.star.id)) {
            seenRef.current.add(it.star.id)
            bornRef.current.set(it.star.id, t)
          }
        }
        // 时间回放：滑入可见窗口的星重新触发点亮庆祝（边沿触发，避免每帧重燃）
        if (tc != null) {
          if (tc !== prevTcRef.current) {
            prevTcRef.current = tc
            let t0 = Infinity, t1 = -Infinity
            for (const it of Lraw) { const ts = it.ts; if (ts > 0) { if (ts < t0) t0 = ts; if (ts > t1) t1 = ts } }
            if (t1 > 0) {
              const win = Math.max(36e5, (t1 - t0) / 70)
              for (const it of L) {
                if (it.ts > tc - win && it.ts <= tc) bornRef.current.set(it.star.id, t)
              }
            }
          }
        } else prevTcRef.current = null

        // 预投影
        const P = L.map(l => ({ l, p: proj(l.pos), sf: proj(l.surf) }))
        const MP = MANSION_DIR.map((d, i) => ({
          i, m: MANSIONS[i], p: proj({ x: d.x * R_M, y: d.y * R_M, z: d.z * R_M }),
        }))

        // 每颗星的可见度（搜索未命中 / 分组隐藏 / 聚焦之外 → 压暗）
        const dimOf = (l) => {
          let d = 1
          if (match && !match.has(l.star.id)) d *= 0.12
          if (hidden.has(MANSIONS[l.mi].g)) d *= 0.08
          if (fs && !fs.has(l.star.id)) d *= 0.12
          return d
        }

        // 5) 收集绘制项（类型化，深度排序后一次遍历绘制）
        const items = []
        // 球面网络：地表点按创建顺序连线
        for (let i = 1; i < P.length; i++) {
          const A = P[i - 1], B = P[i]
          const dm = Math.min(dimOf(A.l), dimOf(B.l))
          if (dm < 0.05) continue
          items.push({
            z: (A.sf.z + B.sf.z) / 2, t: T_LINE,
            x1: A.sf.x, y1: A.sf.y, x2: B.sf.x, y2: B.sf.y,
            rgb: '120,170,255', a: 0.3 * depthAlpha((A.sf.z + B.sf.z) / 2) * dm, w: 1,
          })
        }
        // 象内宿间虚线
        for (let gI = 0; gI < 4; gI++) {
          const gname = MANSIONS[gI * 7].g
          const gd = hidden.has(gname) ? 0.15 : 1
          for (let j = 1; j < 7; j++) {
            const a = MP[gI * 7 + j - 1].p, b = MP[gI * 7 + j].p
            items.push({
              z: (a.z + b.z) / 2, t: T_DASH,
              x1: a.x, y1: a.y, x2: b.x, y2: b.y,
              rgb: MANSIONS[gI * 7].rgb, a: 0.18 * depthAlpha((a.z + b.z) / 2) * gd, w: 1, dash: [4, 4],
            })
          }
        }
        // 类内连接：同一大类的记忆按时间顺序链式相连（类色细线），表达「以此连接」
        {
          const byMi = new Map()
          for (const { l, p } of P) {
            if (hidden.has(MANSIONS[l.mi].g)) continue
            const arr = byMi.get(l.mi)
            if (arr) arr.push({ t: l.star.time || '', p })
            else byMi.set(l.mi, [{ t: l.star.time || '', p }])
          }
          for (const [mi, arr] of byMi) {
            if (arr.length < 2) continue
            arr.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
            for (let q = 1; q < arr.length; q++) {
              const a = arr[q - 1].p, b = arr[q].p
              items.push({
                z: (a.z + b.z) / 2, t: T_LINE,
                x1: a.x, y1: a.y, x2: b.x, y2: b.y,
                rgb: MANSIONS[mi].rgb, a: 0.13 * depthAlpha((a.z + b.z) / 2), w: 1,
              })
            }
          }
        }
        // 语义星座：共享标签的记忆两端异色渐变连线；hover/选中端流动虚线加亮
        if (constRef.current !== false && linksRef.current && linksRef.current.size) {
          const byId = new Map()
          for (const q of P) byId.set(q.l.star.id, q)
          const done = new Set()
          for (const q of P) {
            const ids = linksRef.current.get(q.l.star.id)
            if (!ids) continue
            for (const oid of ids) {
              const key = q.l.star.id < oid ? q.l.star.id + '|' + oid : oid + '|' + q.l.star.id
              if (done.has(key)) continue
              done.add(key)
              const o = byId.get(oid)
              if (!o) continue
              const dm = Math.min(dimOf(q.l), dimOf(o.l))
              if (dm < 0.05) continue
              const hot = q.l.star.id === hoverId || oid === hoverId ||
                q.l.star.id === selRef.current || oid === selRef.current
              const za = (q.p.z + o.p.z) / 2
              items.push({
                z: za, t: T_LINK,
                x1: q.p.x, y1: q.p.y, x2: o.p.x, y2: o.p.y,
                rgb1: MANSIONS[q.l.mi].rgb, rgb2: MANSIONS[o.l.mi].rgb,
                a: (hot ? 0.85 : 0.26) * depthAlpha(za) * dm, w: hot ? 1.6 : 0.85,
                hot, tsec: t,
              })
            }
          }
        }
        // 每颗记忆星：挂载线 / 分支线 / 地表点 / 星节点
        screenRef.current = []
        for (const { l, p, sf } of P) {
          const dm = dimOf(l)
          const mp = MP[l.mi].p
          const rgb = MANSIONS[l.mi].rgb
          const imp = clamp(Number(l.star.importance) || 3, 1, 5)
          const isSel = l.star.id === selRef.current
          const isHov = l.star.id === hoverId
          const isMatch = match && match.has(l.star.id)
          // 命中区域（隐藏的组不可点）
          if (!hidden.has(MANSIONS[l.mi].g)) {
            screenRef.current.push({ id: l.star.id, x: p.x, y: p.y, r: Math.max(9, (4 + imp * 1.6) * p.s * 2.1), z: p.z })
          }
          if (dm < 0.05 && !isSel) continue
          // 挂载线（宿→星，虚线）
          items.push({
            z: (mp.z + p.z) / 2, t: T_DASH,
            x1: mp.x, y1: mp.y, x2: p.x, y2: p.y,
            rgb, a: 0.16 * depthAlpha((mp.z + p.z) / 2) * dm, w: 1, dash: [2, 5],
          })
          // 分支线（地表点→星）：选中/悬停用渐变加亮，其余平涂
          if (isSel || isHov) {
            items.push({
              z: (sf.z + p.z) / 2, t: T_GRADLINE,
              x1: sf.x, y1: sf.y, x2: p.x, y2: p.y,
              rgb, a0: 0.12, a1: 0.9 * depthAlpha((sf.z + p.z) / 2), w: imp * 0.4 + 1.4,
            })
          } else {
            items.push({
              z: (sf.z + p.z) / 2, t: T_LINE,
              x1: sf.x, y1: sf.y, x2: p.x, y2: p.y,
              rgb, a: (0.2 + imp * 0.07) * depthAlpha((sf.z + p.z) / 2) * dm, w: imp * 0.36 + 0.5,
            })
          }
          // 地表点
          items.push({ z: sf.z, t: T_GLOW, x: sf.x, y: sf.y, rgb, a: 0.5 * depthAlpha(sf.z) * dm, r: 6 * sf.s })
          items.push({ z: sf.z, t: T_DOT, x: sf.x, y: sf.y, rgb: '255,255,255', a: 0.85 * depthAlpha(sf.z) * dm, r: 1.7 * sf.s })
          // 星节点
          const R = (4 + imp * 1.6) * p.s
          const da = depthAlpha(p.z)
          const birth = bornRef.current.get(l.star.id)
          const bt = birth != null && birth >= 0 ? (t - birth) / 1.2 : 1
          if (bt < 1) {
            // 诞生：扩散金环 + 冲向星点的流星（只触发一次由 bornRef 保证）
            const e = 1 - Math.pow(1 - clamp(bt, 0, 1), 3)
            items.push({ z: p.z - 0.01, t: T_RING, x: p.x, y: p.y, rgb: '255,214,140', a: (1 - bt) * 0.85, r: R * (0.6 + 3.2 * e), w: 1.8 * (1 - bt) + 0.4 })
            if (met && !l._celebrated) { l._celebrated = true; met.celebrate(W, H, p.x, p.y) }
          }
          const pulse = isMatch ? 0.75 + 0.25 * Math.sin(t * 4.2) : 1
          items.push({ z: p.z, t: T_GLOW, x: p.x, y: p.y, rgb, a: (0.5 + imp * 0.07) * da * dm * pulse * (isSel || isHov ? 1.35 : 1), r: R * 3 })
          items.push({ z: p.z, t: T_DOT, x: p.x, y: p.y, rgb: '255,244,214', a: 0.95 * da * dm * pulse, r: R * 0.52 })
          if (imp >= 4) {
            items.push({ z: p.z, t: T_RING, x: p.x, y: p.y, rgb: '255,224,160', a: 0.3 * da * dm, r: R * 0.95, w: 0.8 })
          }
          if (isSel) {
            items.push({ z: p.z - 0.02, t: T_RING, x: p.x, y: p.y, rgb: '255,255,255', a: 0.92, r: R * 1.55 + 4, w: 1.5 })
            items.push({ z: p.z - 0.02, t: T_GLOW, x: p.x, y: p.y, rgb: '255,214,140', a: 0.3, r: R * 4.4 })
          } else if (isHov) {
            items.push({ z: p.z - 0.02, t: T_RING, x: p.x, y: p.y, rgb: '190,215,255', a: 0.8, r: R * 1.4 + 3, w: 1.2 })
          }
        }
        // 星宿锚点
        for (const { m, p } of MP) {
          const gd = hidden.has(m.g) ? 0.12 : 1
          const a = depthAlpha(p.z) * gd
          items.push({ z: p.z, t: T_GLOW, x: p.x, y: p.y, rgb: m.rgb, a: 0.5 * a, r: 11 * p.s })
          items.push({ z: p.z, t: T_DOT, x: p.x, y: p.y, rgb: '234,242,255', a: 0.9 * a, r: 2.1 * p.s })
        }

        items.sort((A, B) => B.z - A.z)
        for (const it of items) {
          switch (it.t) {
            case T_LINE:
              ctx.strokeStyle = rgba(it.rgb, it.a); ctx.lineWidth = it.w
              ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke()
              break
            case T_DASH:
              ctx.strokeStyle = rgba(it.rgb, it.a); ctx.lineWidth = it.w
              ctx.setLineDash(it.dash)
              ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke()
              ctx.setLineDash([])
              break
            case T_GRADLINE: {
              const grad = ctx.createLinearGradient(it.x1, it.y1, it.x2, it.y2)
              grad.addColorStop(0, rgba(it.rgb, it.a0))
              grad.addColorStop(1, rgba(it.rgb, it.a1))
              ctx.strokeStyle = grad; ctx.lineWidth = it.w
              ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke()
              break
            }
            case T_LINK: {
              const grad = ctx.createLinearGradient(it.x1, it.y1, it.x2, it.y2)
              grad.addColorStop(0, rgba(it.rgb1, it.a))
              grad.addColorStop(1, rgba(it.rgb2, it.a))
              ctx.strokeStyle = grad; ctx.lineWidth = it.w
              if (it.hot) {
                ctx.setLineDash([6, 4])
                ctx.lineDashOffset = -(it.tsec || 0) * 22 // 能量流动
              }
              ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke()
              ctx.setLineDash([]); ctx.lineDashOffset = 0
              break
            }
            case T_GLOW: {
              const sp = glowSprite(it.rgb, it.r)
              ctx.save()
              ctx.globalCompositeOperation = 'lighter'
              ctx.globalAlpha = clamp(it.a, 0, 1)
              ctx.drawImage(sp.cv, it.x - it.r, it.y - it.r, it.r * 2, it.r * 2)
              ctx.restore()
              break
            }
            case T_DOT:
              ctx.fillStyle = rgba(it.rgb, it.a)
              ctx.beginPath(); ctx.arc(it.x, it.y, Math.max(0.4, it.r), 0, TAU); ctx.fill()
              break
            case T_RING:
              ctx.strokeStyle = rgba(it.rgb, it.a); ctx.lineWidth = it.w || 1
              ctx.beginPath(); ctx.arc(it.x, it.y, Math.max(0.5, it.r), 0, TAU); ctx.stroke()
              break
          }
        }

        // 6) 流星层（场景之上，天空前景）
        if (met) met.draw(ctx)

        // 7) 屏幕空间标签（碰撞避让：选中 > 悬停 > 命中 > 重要度 > 宿名；k<0.4 远景不画标签）
        const labels = []
        if (k >= 0.4) {
        for (const { m, p } of MP) {
          const a = depthAlpha(p.z) * (hidden.has(m.g) ? 0.15 : 1)
          if (a < 0.34) continue
          labels.push({ x: p.x + 7, y: p.y, text: m.n, rgb: m.rgb, a: 0.9 * a, pri: 1 + a, font: '600 11.5px "Palatino Linotype",Georgia,"Songti SC","SimSun",serif', force: false })
        }
        }
        if (k >= 0.62) {
          for (const { l, p } of P) {
            const dm = dimOf(l)
            if (dm < 0.5) continue
            const a = depthAlpha(p.z)
            const isSel = l.star.id === selRef.current
            const isHov = l.star.id === hoverId
            const isMatch = match && match.has(l.star.id)
            const onGlobe = Math.hypot(p.x - c0.x, p.y - c0.y) < gR * 0.94
            if (onGlobe && !isSel && !isHov) continue // 压在地球盘面上的标签不画，避免糊住星球
            const imp = clamp(Number(l.star.importance) || 3, 1, 5)
            if (!isSel && !isHov && !isMatch && (a < 0.45 || k < 0.75)) continue
            const title = String(l.star.title || '未命名')
            labels.push({
              x: p.x + 9, y: p.y - 9, text: title.length > 16 ? title.slice(0, 15) + '…' : title,
              rgb: isSel ? '255,255,255' : isMatch ? '255,224,160' : '216,228,252',
              a: isSel || isHov ? 1 : 0.82 * a,
              pri: (isSel ? 100 : 0) + (isHov ? 60 : 0) + (isMatch ? 25 : 0) + imp * 2 + a * 3,
              font: isSel ? 'bold 13px system-ui,"PingFang SC",sans-serif' : '12px system-ui,"PingFang SC",sans-serif',
              force: isSel || isHov,
            })
          }
        }
        labels.sort((A, B) => B.pri - A.pri)
        const placed = []
        ctx.textBaseline = 'middle'
        let drawn = 0
        for (const lb of labels) {
          if (drawn > 44) break
          ctx.font = lb.font
          const wpx = ctx.measureText(lb.text).width
          const rect = { x1: lb.x - 2, y1: lb.y - 8, x2: lb.x + wpx + 3, y2: lb.y + 8 }
          if (rect.x2 < 0 || rect.x1 > W || rect.y2 < 0 || rect.y1 > H) continue
          // 标签矩形压到地球盘面上则不画（节点在球缘外但文字横进球面的情况）
          if (!lb.force) {
            const nx = clamp(c0.x, rect.x1, rect.x2), ny = clamp(c0.y, rect.y1, rect.y2)
            if (Math.hypot(nx - c0.x, ny - c0.y) < gR * 0.92) continue
          }
          let clash = false
          for (const q of placed) {
            if (rect.x1 < q.x2 && rect.x2 > q.x1 && rect.y1 < q.y2 && rect.y2 > q.y1) { clash = true; break }
          }
          if (clash) continue
          placed.push(rect)
          ctx.fillStyle = 'rgba(4,6,15,0.8)'
          ctx.fillText(lb.text, lb.x + 1, lb.y + 1)
          ctx.fillStyle = rgba(lb.rgb, lb.a)
          ctx.fillText(lb.text, lb.x, lb.y)
          drawn++
        }
        ctx.textBaseline = 'alphabetic'
      }

      // ---------- 静态背景烘焙：深空三段渐变 + 银河带 + 星云 ----------
      function buildBackground(W, H) {
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const cv = document.createElement('canvas')
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr)
        const g = cv.getContext('2d')
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        const grad = g.createLinearGradient(0, 0, 0, H)
        grad.addColorStop(0, '#03050c')
        grad.addColorStop(0.55, '#070b19')
        grad.addColorStop(1, '#0f172a')
        g.fillStyle = grad
        g.fillRect(0, 0, W, H)
        const rnd = mulberry32(97)
        // 银河带：斜穿画面的密集微星 + 两条柔光
        g.save()
        g.translate(W * 0.5, H * 0.5)
        g.rotate(-0.46)
        const band = Math.max(W, H) * 1.5
        const bandH = Math.min(W, H) * 0.16
        for (let i = 0; i < 340; i++) {
          const gx = (rnd() - 0.5) * band
          const gy = ((rnd() + rnd() + rnd()) / 3 - 0.5) * bandH * 2
          const ga = 0.05 + rnd() * 0.3
          g.fillStyle = rnd() < 0.2 ? `rgba(255,233,201,${ga})` : `rgba(205,216,255,${ga})`
          g.beginPath(); g.arc(gx, gy, 0.3 + rnd() * 0.9, 0, TAU); g.fill()
        }
        const mg = g.createLinearGradient(0, -bandH, 0, bandH)
        mg.addColorStop(0, 'rgba(150,170,255,0)')
        mg.addColorStop(0.5, 'rgba(160,180,255,0.035)')
        mg.addColorStop(1, 'rgba(150,170,255,0)')
        g.fillStyle = mg
        g.fillRect(-band / 2, -bandH, band, bandH * 2)
        g.restore()
        // 星云：4 团 hsla 柔光（第三停靠点必须透明，避免硬边）
        const nebs = [
          { x: 0.22, y: 0.26, r: 0.5, h: 255, a: 0.05 },
          { x: 0.78, y: 0.2, r: 0.42, h: 198, a: 0.042 },
          { x: 0.68, y: 0.82, r: 0.46, h: 320, a: 0.034 },
          { x: 0.14, y: 0.78, r: 0.4, h: 168, a: 0.03 },
        ]
        const R0 = Math.min(W, H)
        for (const nb of nebs) {
          const rr = nb.r * R0 * (0.8 + rnd() * 0.4)
          const ng = g.createRadialGradient(nb.x * W, nb.y * H, 0, nb.x * W, nb.y * H, rr)
          ng.addColorStop(0, `hsla(${nb.h},55%,42%,${nb.a})`)
          ng.addColorStop(0.5, `hsla(${nb.h},45%,28%,${nb.a * 0.4})`)
          ng.addColorStop(1, `hsla(${nb.h},45%,25%,0)`)
          g.fillStyle = ng
          g.beginPath(); g.arc(nb.x * W, nb.y * H, rr, 0, TAU); g.fill()
        }
        return cv
      }

      // ---------- 命中测试 ----------
      const hitTest = useCallback((mx, my) => {
        let best = null
        for (const s of screenRef.current) {
          const dist = Math.hypot(mx - s.x, my - s.y)
          if (dist <= Math.max(10, s.r * 0.55)) {
            if (!best || s.z < best.z) best = s
          }
        }
        return best
      }, [])

      const updateTooltip = useCallback((hit, mx, my) => {
        const tip = tooltipRef.current
        const id = hit ? hit.id : null
        if (id !== hoverRef.current) {
          hoverRef.current = id
          if (id) {
            const l = layoutRef.current.find(x => x.star.id === id)
            if (l) {
              setHover({
                id, title: l.star.title,
                mansion: MANSIONS[l.mi].g + ' · ' + MANSIONS[l.mi].n,
                gcolor: MANSIONS[l.mi].c,
                imp: clamp(Number(l.star.importance) || 3, 1, 5),
                tags: (l.star.tags || []).slice(0, 3),
              })
            }
          } else setHover(null)
        }
        if (tip) {
          if (id) {
            const { w, h } = sizeRef.current
            tip.style.transform = `translate(${clamp(mx + 16, 0, Math.max(0, w - 260))}px,${clamp(my + 14, 0, Math.max(0, h - 110))}px)`
            tip.classList.add('show')
          } else tip.classList.remove('show')
        }
      }, [])

      // ---------- 原生事件绑定（滚轮必须 non-passive 才能 preventDefault） ----------
      useEffect(() => {
        const cv = canvasRef.current
        const wrap = wrapRef.current
        if (!cv || !wrap) return

        const localXY = (e) => {
          const r = cv.getBoundingClientRect()
          return { x: e.clientX - r.left, y: e.clientY - r.top }
        }

        const onWheel = (e) => {
          e.preventDefault()
          const v = viewRef.current
          v.targetK = clamp(v.targetK * Math.exp(-e.deltaY * 0.0012), 0.25, 4)
          v.resetting = false
          lastActRef.current = performance.now()
        }

        const onPointerDown = (e) => {
          cv.setPointerCapture(e.pointerId)
          pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (pointersRef.current.size === 2) {
            const pts = [...pointersRef.current.values()]
            pinchRef.current = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), k0: viewRef.current.targetK }
            dragRef.current = null
            return
          }
          const v = viewRef.current
          dragRef.current = {
            id: e.pointerId, sx: e.clientX, sy: e.clientY,
            yaw: v.yaw, pitch: v.pitch, moved: false,
            lastX: e.clientX, lastY: e.clientY, lastT: performance.now(),
            ivy: 0, ivp: 0,
          }
          v.resetting = false; v.vy = 0; v.vp = 0
          lastActRef.current = performance.now()
          wrap.classList.add('grabbing')
        }

        const onPointerMove = (e) => {
          if (pointersRef.current.has(e.pointerId)) {
            pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          }
          const pinch = pinchRef.current
          if (pinch && pointersRef.current.size >= 2) {
            const pts = [...pointersRef.current.values()]
            const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
            if (pinch.dist > 0) {
              viewRef.current.targetK = clamp(pinch.k0 * (dist / pinch.dist), 0.25, 4)
            }
            lastActRef.current = performance.now()
            return
          }
          const d = dragRef.current
          if (d && d.id === e.pointerId) {
            const dx = e.clientX - d.sx, dy = e.clientY - d.sy
            if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
            if (d.moved) {
              const v = viewRef.current
              const now = performance.now()
              const ddt = Math.max(1, now - d.lastT) / 1000
              const mx = e.clientX - d.lastX, my = e.clientY - d.lastY
              v.yaw = d.yaw + dx * 0.005
              v.pitch = clamp(d.pitch + dy * 0.005, -1.35, 1.35)
              // 平滑瞬时角速度，抬手后作为惯性初速
              d.ivy = d.ivy * 0.7 + (mx * 0.005 / ddt) * 0.3
              d.ivp = d.ivp * 0.7 + (my * 0.005 / ddt) * 0.3
              d.lastX = e.clientX; d.lastY = e.clientY; d.lastT = now
              lastActRef.current = now
              updateTooltip(null, 0, 0)
            }
            return
          }
          // 悬停
          if (!dragRef.current) {
            const { x, y } = localXY(e)
            const hit = hitTest(x, y)
            updateTooltip(hit, x, y)
            wrap.classList.toggle('pointing', !!hit)
          }
        }

        const endPointer = (e) => {
          pointersRef.current.delete(e.pointerId)
          if (pointersRef.current.size < 2) pinchRef.current = null
          const d = dragRef.current
          if (!d || d.id !== e.pointerId) return
          dragRef.current = null
          wrap.classList.remove('grabbing')
          lastActRef.current = performance.now()
          if (!d.moved) {
            // 点击选中
            const { x, y } = localXY(e)
            const hit = hitTest(x, y)
            setSelectedId(hit ? hit.id : null)
          } else {
            // 惯性
            const v = viewRef.current
            v.vy = clamp(d.ivy, -6, 6)
            v.vp = clamp(d.ivp, -6, 6)
          }
        }

        const onDblClick = (e) => {
          e.preventDefault()
          // 双击星点 → 聚焦其记忆网络；双击空处 → 复位视角
          const { x, y } = localXY(e)
          const hit = hitTest(x, y)
          if (hit && focusFnRef.current) focusFnRef.current(hit.id)
          else ctlRef.current.reset()
          lastActRef.current = performance.now()
        }
        const onLeave = () => {
          updateTooltip(null, 0, 0)
          wrap.classList.remove('pointing')
        }

        cv.addEventListener('wheel', onWheel, { passive: false })
        cv.addEventListener('pointerdown', onPointerDown)
        cv.addEventListener('pointermove', onPointerMove)
        cv.addEventListener('pointerup', endPointer)
        cv.addEventListener('pointercancel', endPointer)
        cv.addEventListener('dblclick', onDblClick)
        cv.addEventListener('pointerleave', onLeave)
        return () => {
          cv.removeEventListener('wheel', onWheel)
          cv.removeEventListener('pointerdown', onPointerDown)
          cv.removeEventListener('pointermove', onPointerMove)
          cv.removeEventListener('pointerup', endPointer)
          cv.removeEventListener('pointercancel', endPointer)
          cv.removeEventListener('dblclick', onDblClick)
          cv.removeEventListener('pointerleave', onLeave)
        }
      }, [hitTest, updateTooltip, setSelectedId, ctlRef])

      return h('div', { ref: wrapRef, className: 'msm-canvas-wrap' },
        h('canvas', { ref: canvasRef, style: { width: '100%', height: '100%', display: 'block' } }),
        h('div', { ref: tooltipRef, className: 'msm-tooltip' },
          hover && h('div', null,
            h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 3 } }, hover.title),
            h('div', { style: { color: hover.gcolor, fontSize: 11, marginBottom: 3 } }, '✦ ' + hover.mansion),
            h('div', { style: { color: '#ffd479', fontSize: 11, letterSpacing: 1 } }, '★'.repeat(hover.imp)),
            hover.tags.length > 0 && h('div', { style: { color: '#8fa2cf', fontSize: 11, marginTop: 3 } },
              hover.tags.map(x => '#' + x).join(' ')),
          )),
      )
    }

    // ---------- 详情面板 ----------
    function DetailPanel({ star, onEdit, onDelete, onClose, onTagClick, focusMode, onFocus, onExitFocus, relStars, onRelClick }) {
      const [confirming, setConfirming] = useState(false)
      const mi = mansionIndex(star)
      const m = MANSIONS[mi]
      const imp = clamp(Number(star.importance) || 3, 1, 5)
      return h('div', { className: 'msm-panel right' },
        h('div', { className: 'msm-panel-head' },
          h('span', { className: 'msm-panel-title' }, '⭐ ' + star.title),
          h('button', { className: 'msm-x', onClick: onClose, title: '关闭', 'aria-label': '关闭' }, '✕'),
        ),
        h('div', { className: 'msm-panel-body' },
          h('p', { className: 'msm-content' }, star.content || '(无内容)'),
          star.tags && star.tags.length > 0 && h('div', { style: { marginTop: 8 } },
            star.tags.map(tg => h('span', {
              key: tg, className: 'msm-tag', title: '按此标签搜索',
              onClick: () => onTagClick && onTagClick(tg),
            }, '#' + tg))),
          relStars && relStars.length > 0 && h('div', { className: 'msm-meta', style: { flexWrap: 'wrap' } },
            h('span', { style: { opacity: 0.6 } }, '✧ 语义相连'),
            relStars.map(rs => h('button', {
              key: rs.id, className: 'msm-relchip', title: '聚焦到「' + rs.title + '」',
              onClick: () => onRelClick && onRelClick(rs.id),
            },
              h('i', { style: { background: (MANSIONS[rs.mi] || {}).c || '#8fb2ff' } }),
              rs.title))),
          h('div', { className: 'msm-meta' },
            h('span', {
              className: 'msm-chip',
              style: { color: m.c, borderColor: m.c + '55', background: m.c + '14' },
            }, '✦ ' + m.g + ' · ' + m.n + '宿'),
          ),
          h('div', { className: 'msm-meta' },
            h('span', { style: { color: '#ffd479', letterSpacing: 1 } }, '★'.repeat(imp)),
            h('span', { style: { opacity: 0.4 } }, '☆'.repeat(5 - imp)),
            h('span', null, '重要度 ' + imp + '/5')),
          h('div', { className: 'msm-meta', title: fmtTime(star.time) },
            h('span', null, star.source === 'auto' ? '🤖 自动提炼' : '✍️ 手动记录'),
            h('span', { style: { opacity: 0.5 } }, '·'),
            h('span', null, relTime(star.time))),
          star.from && h('div', { className: 'msm-meta', style: { opacity: 0.75, wordBreak: 'break-all' } }, '来自：' + star.from),
        ),
        h('div', { className: 'msm-panel-foot' },
          focusMode
            ? h('button', { className: 'msm-btn ghost', onClick: onExitFocus, title: '退出聚焦（Esc）' }, '⛶ 退出聚焦')
            : h('button', { className: 'msm-btn ghost', onClick: onFocus, title: '聚焦这颗星的记忆网络' }, '⌖ 聚焦'),
          h('button', { className: 'msm-btn ghost', onClick: onEdit }, '编辑'),
          confirming
            ? h('button', { className: 'msm-btn danger', onClick: onDelete, autoFocus: true }, '确认删除？')
            : h('button', { className: 'msm-btn ghost', onClick: () => setConfirming(true) }, '删除'),
        ),
      )
    }

    // ---------- 新增/编辑表单 ----------
    function StarForm({ editing, onCancel, onSubmit }) {
      const [title, setTitle] = useState(editing ? editing.title : '')
      const [content, setContent] = useState(editing ? editing.content : '')
      const [tags, setTags] = useState(editing ? (editing.tags || []).join(', ') : '')
      const [importance, setImportance] = useState(editing ? (editing.importance || 3) : 3)
      const [mansion, setMansion] = useState(editing ? (editing.mansion || '') : '')

      const submit = () => {
        const star = {
          id: editing ? editing.id : genId(),
          title: title.trim() || '未命名记忆',
          content: content.trim(),
          tags: tags.split(/[,，]/).map(x => x.trim()).filter(Boolean),
          links: editing ? (editing.links || []) : [],
          source: editing ? editing.source : 'manual',
          time: editing ? editing.time : new Date().toISOString(),
          importance: clamp(Number(importance) || 3, 1, 5),
          mansion: mansion,
        }
        onSubmit(star)
      }

      return h('div', { className: 'msm-panel left' },
        h('div', { className: 'msm-panel-head' },
          h('b', null, editing ? '✏️ 编辑记忆' : '🌱 种下新记忆'),
          h('button', { className: 'msm-x', onClick: onCancel, title: '取消', 'aria-label': '取消' }, '✕'),
        ),
        h('div', { className: 'msm-panel-body' },
          h('label', { className: 'msm-field' }, '标题',
            h('input', {
              className: 'msm-input', value: title, autoFocus: true,
              onChange: e => setTitle(e.target.value), placeholder: '给这颗星起个名字',
              onKeyDown: e => { if (e.key === 'Enter') submit() },
            })),
          h('label', { className: 'msm-field' }, '内容',
            h('textarea', {
              className: 'msm-input', value: content,
              onChange: e => setContent(e.target.value), placeholder: '你想记住的是什么？',
            })),
          h('label', { className: 'msm-field' }, '标签（逗号分隔）',
            h('input', {
              className: 'msm-input', value: tags,
              onChange: e => setTags(e.target.value), placeholder: '工作, 灵感, 待办',
            })),
          h('div', { className: 'msm-field' }, '重要度',
            h('div', { className: 'msm-stars-pick' },
              [1, 2, 3, 4, 5].map(n => h('button', {
                key: n, type: 'button',
                className: 'msm-star-btn' + (n <= importance ? ' on' : ''),
                onClick: () => setImportance(n), title: n + ' 星',
              }, '★')))),
          h('label', { className: 'msm-field' }, '所属星宿（留空自动分配）',
            h('select', { className: 'msm-input', value: mansion, onChange: e => setMansion(e.target.value) },
              h('option', { value: '' }, '（自动分配）'),
              MANSIONS.map(m => h('option', { key: m.g + m.n, value: m.n }, m.g + ' · ' + m.n)))),
        ),
        h('div', { className: 'msm-panel-foot' },
          h('button', { className: 'msm-btn', onClick: submit }, '保存'),
          h('button', { className: 'msm-btn ghost', onClick: onCancel }, '取消'),
        ),
      )
    }

    // ---------- 提炼面板 + 待认领区 ----------
    function ExtractPanel({ pending, savePending, onAccept, onClose, onShower }) {
      const [sources, setSources] = useState(null) // null=加载中 | []=不可用 | [...]
      const [dir, setDir] = useState('')
      const [limit, setLimit] = useState(3)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const [checked, setChecked] = useState(() => new Set(pending.map((_, i) => i)))

      useEffect(() => {
        let alive = true
        ;(async () => {
          const j = await apiFetch('/sources')
          if (!alive) return
          if (!j) { setSources([]); setMsg('宿主提炼服务未就绪：请完全退出并重启 DSH 后再试'); return }
          setSources(j.sources || [])
          if (j.sources && j.sources.length) setDir(j.sources[0].dirName)
          else setMsg('没有找到任何 DSH 会话记录（~/.dsh/sessions 为空）')
        })()
        return () => { alive = false }
      }, [])

      const start = async () => {
        if (!dir || busy) return
        setBusy(true)
        setMsg(`正在读最近 ${limit} 个会话并让模型提炼…（最长约 3 分钟，请稍候）`)
        const j = await apiFetch('/extract', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dirName: dir, limit }),
        })
        setBusy(false)
        if (!j) { setMsg('提炼失败：宿主未响应。若刚更新插件，请完全退出并重启 DSH'); return }
        if (j.error) { setMsg('提炼出错：' + j.error); return }
        const cands = j.candidates || []
        if (cands.length === 0) { setMsg(j.note || '这几个会话里没有提炼出值得记的内容'); return }
        setMsg(`提炼出 ${cands.length} 条候选记忆（扫了 ${j.scanned || '?'} 个会话）。勾选后点「点亮入选」入星图`)
        const next = [...pending, ...cands]
        savePending(next)
        setChecked(new Set(next.map((_, i) => i)))
        if (onShower) onShower(3) // 候选抵达，先来一小波流星
      }

      const toggle = i => {
        const s = new Set(checked)
        if (s.has(i)) s.delete(i); else s.add(i)
        setChecked(s)
      }
      const chosen = pending.filter((_, i) => checked.has(i))

      return h('div', { className: 'msm-panel right', style: { width: 'min(380px,calc(100% - 28px))' } },
        h('div', { className: 'msm-panel-head' },
          h('b', null, '✨ 从会话提炼记忆'),
          h('button', { className: 'msm-x', onClick: onClose, title: '关闭', 'aria-label': '关闭' }, '✕'),
        ),
        h('div', { className: 'msm-panel-body' },
          sources === null && h('div', { className: 'msm-meta' }, h('span', { className: 'msm-spin' }), '正在加载来源列表…'),
          sources && sources.length > 0 && h('div', null,
            h('label', { className: 'msm-field' }, '来源工作区（默认最近活跃）',
              h('select', { className: 'msm-input', value: dir, onChange: e => setDir(e.target.value) },
                sources.map(s => h('option', { key: s.dirName, value: s.dirName },
                  `${s.cwd}${s.title ? ' · ' + s.title : ''}（${s.sessions} 个会话）`)))),
            h('label', { className: 'msm-field' }, '提炼最近几个会话',
              h('select', { className: 'msm-input', value: limit, onChange: e => setLimit(Number(e.target.value)) },
                [1, 3, 5, 10].map(n => h('option', { key: n, value: n }, `最近 ${n} 个`))))),
          sources && sources.length === 0 && !msg && h('div', { className: 'msm-meta' }, '暂无可用来源'),
          msg && h('div', { className: 'msm-meta', style: { color: '#a9c0ff', marginTop: 10 } },
            busy ? h('span', { className: 'msm-spin' }) : null, msg),
          pending.length > 0 && h('div', null,
            h('div', { className: 'msm-field', style: { marginTop: 14 } }, `待认领区（${pending.length} 条）`),
            h('div', { className: 'msm-candlist' },
              pending.map((c, i) => h('label', { key: i, className: 'msm-cand' },
                h('input', { type: 'checkbox', checked: checked.has(i), onChange: () => toggle(i) }),
                h('span', { style: { flex: 1, minWidth: 0 } },
                  h('b', { style: { wordBreak: 'break-all' } }, c.title || '(无标题)'), ' ',
                  h('span', { style: { color: '#ffd479', fontSize: 11 } }, '★'.repeat(clamp(c.importance || 3, 1, 5))),
                  ' ',
                  h('span', { className: 'msm-tag', style: { cursor: 'default' } },
                    '✦ ' + (typeof c.mansion === 'number' && MANSIONS[c.mansion] ? MANSIONS[c.mansion].n : (c.mansion || '自动分配'))),
                  c.content && h('div', { className: 'msm-meta', style: { wordBreak: 'break-all' } }, c.content),
                  h('div', { style: { marginTop: 4 } }, (c.tags || []).map(tg => h('span', { key: tg, className: 'msm-tag' }, '#' + tg)))))))),
        ),
        h('div', { className: 'msm-panel-foot' },
          h('button', { className: 'msm-btn', disabled: busy || !dir, onClick: start },
            busy ? '提炼中…' : '开始提炼'),
          pending.length > 0 && h('button', {
            className: 'msm-btn green', disabled: chosen.length === 0,
            onClick: () => onAccept(chosen),
          }, `⭐ 点亮入选（${chosen.length}）`),
          pending.length > 0 && h('button', {
            className: 'msm-btn danger',
            onClick: () => { savePending([]); setChecked(new Set()); setMsg('已丢弃全部候选') },
          }, '全部丢弃'),
        ),
      )
    }

    // ---------- 注册 settings.section（+ 可选导航图标） ----------
    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-memory-star-map',
        order: 45,
        label: '记忆星图',
      }, props => h(StarMapPage, props)))
      // 设置页导航图标（slot 若不存在则静默跳过，不影响主注册）
      try {
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'dsh-memory-star-map',
          order: 45,
        }, () => h(MiniIcon)))
      } catch { /* 旧版本 DSH 无此 slot */ }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-memory-star-map'
    return module.exports
  },
})
