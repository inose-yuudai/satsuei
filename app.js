// 3D キャラ用の撮影：カメラの映像を MediaPipe で見て、手順どおりのポーズ・表情になった瞬間に自動で撮る。
// 撮った写真・動画はこの端末のブラウザの中（IndexedDB）にだけ置き、最後に 1 つの ZIP にまとめて端末に保存する。
// どこにも送らない（index.html の Content-Security-Policy で、つなぐ先もこのサイトだけに絞ってある）。
import { STEPS, PHASES, dirDeg } from "./steps.js";
import { picto } from "./pictos.js";
import { makeZip } from "./zip.js";

const Q = new URLSearchParams(location.search);
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const TEST = LOCAL && Q.has("test");          // 待ち時間を短く・声なし（手元の確かめ用）
const FAKE = LOCAL ? Q.get("fake") : null;    // カメラの代わりに流す動画（手元の確かめ用。同じサイトの中の物だけ）
const FREEZE = TEST && Q.has("freeze");
const T = (ms) => (TEST ? Math.min(ms, 1200) : ms);
const VENDOR = new URL("./vendor/mediapipe/", location.href).href;
const MODELS = {
  face: VENDOR + "models/face_landmarker.task",
  hands: VENDOR + "models/hand_landmarker.task",
  pose: VENDOR + "models/pose_landmarker_lite.task",
};
const STORE = "capture-kit-v1";
const DB_NAME = "capture-kit";
const SWEEP_BINS = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
const PHASE_WAIT = { face: 9000, expr: 7000, hands: 8000, body: 15000 };
const BURST = 4;

const $ = (s) => document.querySelector(s);
const video = $("#video");
const overlay = $("#overlay");
const octx = overlay.getContext("2d");
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;
const pad = (n, w = 2) => String(n).padStart(w, "0");
const OS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "ios" : /Android/.test(navigator.userAgent) ? "android" : "pc";

let stream = null;
let facing = "user";
let detectors = {};
let loading = {};
let faceReady = false;
let BS_NAMES = null;
let M = { t: 0, face: { found: false }, hands: [], pose: { found: false } };
let lastTs = 0;
let lastDetect = 0;
let S = null;          // 撮影の記録（localStorage に残す）
let pending = null;    // はじめの画面で入れた中身（撮影を始めるまで）
let st = null;         // 今のステップの進行
let runId = 0;
let paused = false;
let voiceOn = true;
let okNow = false;
let brightness = null;
let loopOn = false;
let wakeLock = null;
let afterCamera = null;
let zipBlob = null;
let zipName = "";
let memFiles = null;   // IndexedDB が使えない時だけ、メモリに置く

// ------------------------------------------------------------ 端末の中の置き場（IndexedDB）
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files", { keyPath: "name" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction("files", mode);
    const out = fn(t.objectStore("files"));
    t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
async function saveFile(name, blob, step) {
  const rec = { name, blob, step, size: blob.size };
  if (!memFiles) {
    try { await tx("readwrite", (s) => s.put(rec)); return true; }
    catch (e) {
      console.warn("IndexedDB に置けないので、メモリに置きます", e);
      memFiles = new Map();
      toast("この端末では途中の保存ができません。撮り終わるまでページを閉じないでください", 9000);
    }
  }
  memFiles.set(name, rec);
  return true;
}
async function allFiles() {
  let list = [];
  try { list = (await tx("readonly", (s) => s.getAll())) || []; } catch (e) { /* 置き場が無い */ }
  if (memFiles) for (const r of memFiles.values()) if (!list.find((x) => x.name === r.name)) list.push(r);
  return list.sort((a, b) => (a.name < b.name ? -1 : 1));
}
async function deleteStep(stepId) {
  if (memFiles) for (const [k, r] of memFiles) if (r.step === stepId) memFiles.delete(k);
  try {
    await tx("readwrite", (s) => {
      const r = s.openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) return; if (c.value.step === stepId) c.delete(); c.continue(); };
    });
  } catch (e) { /* 置き場が無い */ }
}
async function clearFiles() {
  memFiles = null;
  try { await tx("readwrite", (s) => s.clear()); } catch (e) { /* 置き場が無い */ }
}

function persist() {
  if (!S) return;
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* 残せなくても撮影は続ける */ }
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { return null; }
}

// ------------------------------------------------------------ 計測
function faceMetrics(r, W, H) {
  const lm = r.faceLandmarks && r.faceLandmarks[0];
  if (!lm) return { found: false };
  const cats = (r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories) || [];
  if (!BS_NAMES && cats.length) BS_NAMES = cats.map((c) => c.categoryName);
  const bs = {};
  for (const c of cats) bs[c.categoryName] = c.score;
  const L = lm[234], R = lm[454], nose = lm[1], fore = lm[10], chin = lm[152];
  const w = Math.abs(R.x - L.x) || 1e-6;
  const offX = (nose.x - (L.x + R.x) / 2) / w;
  const ratioY = (nose.y - fore.y) / (chin.y - fore.y || 1e-6);
  const base = (S && S.base) || {};
  const off0 = base.offX ?? 0;
  const r0 = base.ratioY ?? 0.5;
  // 角度の大きさは変換行列から（正面で撮った時との差）、向き（左右・上下）は鼻の位置から決める
  let rawYaw = null, rawPitch = null, yawMag, pitchMag;
  const mx = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0] && r.facialTransformationMatrixes[0].data;
  if (mx) {
    const n = Math.hypot(mx[8], mx[9], mx[10]) || 1;
    rawYaw = deg(Math.asin(clamp(mx[8] / n, -1, 1)));
    rawPitch = deg(Math.asin(clamp(-mx[9] / n, -1, 1)));
    yawMag = Math.abs(rawYaw - (base.rawYaw ?? 0));
    pitchMag = Math.abs(rawPitch - (base.rawPitch ?? 0));
  } else {
    yawMag = clamp(Math.abs(offX - off0) * 140, 0, 90);
    pitchMag = clamp(Math.abs(ratioY - r0) * 300, 0, 60);
  }
  // 生の映像（左右反転なし）では、本人が左を向くと鼻は画像の右へ動く
  const yaw = (offX - off0 >= 0 ? 1 : -1) * yawMag;
  const pitch = (ratioY - r0 <= 0 ? 1 : -1) * pitchMag;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of lm) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
  return {
    found: true, lm, bs, bsArr: BS_NAMES ? BS_NAMES.map((k) => rnd(bs[k] ?? 0, 3)) : [],
    // 顔の大きさは、顔の幅を映像の短い辺で割った値（縦の映像でも横の映像でも同じ目安）
    yaw, pitch, rawYaw, rawPitch, offX, ratioY, size: (w * W) / Math.min(W, H), box: [x0, y0, x1, y1],
  };
}

const FINGERS = { index: [6, 8], middle: [10, 12], ring: [14, 16], pinky: [18, 20] };
const GESTURE_NAMES = { open: "パー", fist: "グー", peace: "ピース", point: "指さし", other: "その他" };
function handMetrics(r) {
  const hd = r.handedness || r.handednesses || [];
  return (r.landmarks || []).map((lm, k) => {
    const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
    const ext = {};
    for (const [n, [pip, tip]] of Object.entries(FINGERS)) ext[n] = d(0, tip) > d(0, pip) * 1.12;
    ext.thumb = d(4, 17) > d(3, 17) * 1.05;
    const n4 = ["index", "middle", "ring", "pinky"].filter((n) => ext[n]).length;
    let gesture = "other";
    if (n4 === 4) gesture = "open";
    else if (n4 === 0) gesture = "fist";
    else if (ext.index && ext.middle && !ext.ring && !ext.pinky) gesture = "peace";
    else if (ext.index && !ext.middle && !ext.ring && !ext.pinky) gesture = "point";
    const inFrame = lm.every((p) => p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98);
    const label = hd[k] && hd[k][0] ? hd[k][0].categoryName : "?";
    return { lm, lmc: lm.map((p) => [rnd(p.x), rnd(p.y), rnd(p.z)]), ext, gesture, gestureName: GESTURE_NAMES[gesture], inFrame, label };
  });
}

const POSE_PARTS = [[0, "頭"], [11, "肩"], [12, "肩"], [23, "腰"], [24, "腰"], [27, "足首"], [28, "足首"]];
function poseMetrics(r, W, H) {
  const lm = r.landmarks && r.landmarks[0];
  if (!lm) return { found: false };
  const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H, v: lm[i].visibility ?? 1 });
  const ls = P(11), rs = P(12), lh = P(23), rh = P(24), lw = P(15), rw = P(16), nose = P(0);
  const shoulderW = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  const torsoH = Math.abs((ls.y + rs.y) / 2 - (lh.y + rh.y) / 2) || 1;
  const arm = (s, w) => deg(Math.acos(clamp((w.y - s.y) / (Math.hypot(w.x - s.x, w.y - s.y) || 1), -1, 1)));
  const inside = (p) => p.x > W * 0.01 && p.x < W * 0.99 && p.y > H * 0.01 && p.y < H * 0.99;
  const seen = {};
  let missing = "";
  for (const [i, name] of POSE_PARTS) {
    const p = P(i);
    const okp = i === 0 ? inside(p) : i >= 27 ? p.v > 0.05 && inside(p) : p.v > 0.5 && inside(p);
    seen[name] = (seen[name] ?? true) && okp;
    if (!okp && !missing) missing = name;
  }
  return {
    found: true, lm, lmc: lm.map((p) => [rnd(p.x), rnd(p.y), rnd(p.z), rnd(p.visibility ?? 1, 2)]),
    width: shoulderW / torsoH, armL: arm(ls, lw), armR: arm(rs, rw), noseVis: nose.v, full: !missing, missing, seen,
    back: lm[11].x < lm[12].x,
  };
}

function detect() {
  const need = (st && st.step.need) || ["face"];
  const ts = Math.max(performance.now(), lastTs + 1);
  lastTs = ts;
  const W = video.videoWidth, H = video.videoHeight;
  const m = { t: ts, W, H, face: { found: false }, hands: [], pose: { found: false } };
  try {
    if (need.includes("face") && detectors.face) m.face = faceMetrics(detectors.face.detectForVideo(video, ts), W, H);
    if (need.includes("hands") && detectors.hands) m.hands = handMetrics(detectors.hands.detectForVideo(video, ts));
    if (need.includes("pose") && detectors.pose) m.pose = poseMetrics(detectors.pose.detectForVideo(video, ts), W, H);
  } catch (e) {
    console.warn("detect failed", e);
  }
  if (S && m.face.found) { S.lastYaw = m.face.yaw; S.lastYawT = m.t; }
  return m;
}

// ------------------------------------------------------------ 映像の上の線とガイド枠（縦の映像にも合わせる）
const HAND_EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const POSE_EDGES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,31],[28,32]];
const GUIDE_TEXT = { face: "点線の楕円に顔を合わせる", closeup: "顔を大きく、楕円いっぱいに", hand: "点線の四角に手の全体を入れる", body: "頭からつま先まで枠に入る" };

function roundRect(x, y, w, h, r) {
  octx.beginPath();
  octx.moveTo(x + r, y); octx.arcTo(x + w, y, x + w, y + h, r); octx.arcTo(x + w, y + h, x, y + h, r);
  octx.arcTo(x, y + h, x, y, r); octx.arcTo(x, y, x + w, y, r); octx.closePath();
}

function drawGuide(kind, W, H, ok) {
  const m = Math.min(W, H), s = m / 720, port = H > W;
  octx.save();
  octx.lineWidth = (ok ? 6 : 4) * s;
  octx.strokeStyle = ok ? "rgba(95,211,154,0.95)" : "rgba(255,255,255,0.8)";
  octx.setLineDash(ok ? [] : [16 * s, 12 * s]);
  if (kind === "face" || kind === "closeup") {
    const big = kind === "closeup";
    octx.beginPath();
    octx.ellipse(W / 2, H * (big ? 0.5 : port ? 0.42 : 0.45), m * (big ? 0.36 : port ? 0.23 : 0.19), m * (big ? 0.44 : port ? 0.3 : 0.255), 0, 0, Math.PI * 2);
    octx.stroke();
  } else if (kind === "hand") {
    if (port) roundRect(W * 0.14, H * 0.2, W * 0.72, H * 0.6, 30 * s);
    else roundRect(W * 0.3, H * 0.1, W * 0.4, H * 0.8, 30 * s);
    octx.stroke();
  } else if (kind === "body") {
    if (port) roundRect(W * 0.12, H * 0.03, W * 0.76, H * 0.94, 40 * s);
    else roundRect(W * 0.32, H * 0.03, W * 0.36, H * 0.94, 40 * s);
    octx.stroke();
  }
  octx.restore();
}

function drawOverlay(m) {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  const s = Math.min(W, H) / 720;
  if (st && st.step.guide) drawGuide(st.step.guide, W, H, okNow);
  else if (!S || S.finished) drawGuide("face", W, H, m.face.found);
  octx.lineWidth = 3 * s;
  octx.strokeStyle = "rgba(240,87,155,0.9)";
  octx.fillStyle = "rgba(240,87,155,0.85)";
  if (m.face.found) {
    for (let i = 0; i < m.face.lm.length; i += 6) {
      const p = m.face.lm[i];
      octx.fillRect(p.x * W - 1.5 * s, p.y * H - 1.5 * s, 3 * s, 3 * s);
    }
  }
  for (const h of m.hands) {
    octx.beginPath();
    for (const [a, b] of HAND_EDGES) { octx.moveTo(h.lm[a].x * W, h.lm[a].y * H); octx.lineTo(h.lm[b].x * W, h.lm[b].y * H); }
    octx.stroke();
  }
  if (m.pose.found) {
    octx.beginPath();
    for (const [a, b] of POSE_EDGES) {
      const pa = m.pose.lm[a], pb = m.pose.lm[b];
      if ((pa.visibility ?? 1) < 0.4 || (pb.visibility ?? 1) < 0.4) continue;
      octx.moveTo(pa.x * W, pa.y * H); octx.lineTo(pb.x * W, pb.y * H);
    }
    octx.stroke();
  }
}

// ------------------------------------------------------------ 表示の小物
const mirrored = () => facing === "user";
function setMirror() { document.body.classList.toggle("mirror", mirrored()); }
function setPill(kind, text) { const el = $("#pill"); el.className = "pill " + (kind || ""); el.textContent = text; }
function hold(p) { $("#holdfill").style.width = `${clamp(p, 0, 1) * 100}%`; }
function setHint(text) { $("#hint").textContent = text || ""; $("#farhint").textContent = text || ""; }
function big(text, rec = false) {
  const el = $("#bigcount");
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("rec", rec);
}
function toast(text, ms = 3500) {
  const el = $("#toast"); el.textContent = text; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), ms);
}
function flash() { const el = $("#flash"); el.classList.remove("on"); void el.offsetWidth; el.classList.add("on"); }
function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* 震えなくてよい */ } }
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function showPage(id) {
  for (const p of ["intro", "perm", "studio", "finish"]) $("#" + p).hidden = p !== id;
  window.scrollTo(0, 0);
}
function showPanel(id) { $("#ready").hidden = id !== "ready"; $("#now").hidden = id !== "now"; }

// 角度メーター（半円）。自撮りは鏡の表示なので、本人の左を画面の左に描く
function yawGauge(g, m) {
  const f = m.face.found ? m.face : null;
  const sg = mirrored() ? 1 : -1;
  const cx = 160, cy = 128, r = 100;
  const pt = (yaw, rr = r) => { const t = ((90 + clamp(yaw * sg, -90, 90)) * Math.PI) / 180; return [cx + rr * Math.cos(t), cy - rr * Math.sin(t)]; };
  const arc = (a, b, rr = r) => {
    let [from, to] = [a * sg, b * sg];
    if (from < to) [from, to] = [to, from];
    const P = (y) => { const t = ((90 + clamp(y, -90, 90)) * Math.PI) / 180; return [cx + rr * Math.cos(t), cy - rr * Math.sin(t)]; };
    const [x0, y0] = P(from), [x1, y1] = P(to);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${rr},${rr} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  let s = `<svg viewBox="0 0 320 160"><path d="${arc(90, -90)}" stroke="#2f2c39" stroke-width="16" fill="none" stroke-linecap="round"/>`;
  if (!g.sweep) {
    s += `<path d="${arc(clamp(g.target + g.tol, -90, 90), clamp(g.target - g.tol, -90, 90))}" stroke="var(--pink)" stroke-width="16" fill="none" stroke-linecap="round" opacity=".85"/>`;
  } else {
    for (const b of SWEEP_BINS) {
      const [x, y] = pt(b);
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${st && st.bins && st.bins[b] ? "var(--ok)" : "#4a4656"}"/>`;
    }
  }
  if (f) {
    const [x, y] = pt(f.yaw, r - 8);
    s += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${okNow ? "var(--ok)" : "#fff"}" stroke-width="5" stroke-linecap="round"/>`;
  }
  const [lt, rt] = mirrored() ? ["左", "右"] : ["右", "左"];
  s += `<circle cx="${cx}" cy="${cy}" r="8" fill="#fff"/>`;
  s += `<text x="${cx - r}" y="${cy + 26}" fill="#a7a4b3" font-size="14" text-anchor="middle">${lt}</text><text x="${cx}" y="16" fill="#a7a4b3" font-size="14" text-anchor="middle">正面</text><text x="${cx + r}" y="${cy + 26}" fill="#a7a4b3" font-size="14" text-anchor="middle">${rt}</text>`;
  const now = f ? `いま ${dirDeg(f.yaw)}` : "顔が見つかりません";
  s += `<text x="${cx}" y="${cy + 26}" fill="#fff" font-size="15" font-weight="700" text-anchor="middle">${now}${g.sweep ? "" : "／目標 " + dirDeg(g.target)}</text></svg>`;
  return s;
}

function pitchGauge(g, m) {
  const f = m.face.found ? m.face : null;
  const y = (v) => 75 - clamp(v, -40, 40) * 1.6;
  let s = `<svg viewBox="0 0 320 150"><rect x="140" y="${y(40)}" width="40" height="${y(-40) - y(40)}" rx="12" fill="#2f2c39"/>`;
  s += `<rect x="140" y="${y(g.target + g.tol)}" width="40" height="${y(g.target - g.tol) - y(g.target + g.tol)}" rx="8" fill="var(--pink)" opacity=".85"/>`;
  if (f) s += `<rect x="128" y="${y(f.pitch) - 3}" width="64" height="6" rx="3" fill="${okNow ? "var(--ok)" : "#fff"}"/>`;
  s += `<text x="200" y="${y(30)}" fill="#a7a4b3" font-size="14">上</text><text x="200" y="${y(-30) + 6}" fill="#a7a4b3" font-size="14">下</text>`;
  s += `<text x="20" y="80" fill="#fff" font-size="16" font-weight="700">${f ? (Math.abs(f.pitch) < 3 ? "まっすぐ" : (f.pitch > 0 ? "上 " : "下 ") + Math.round(Math.abs(f.pitch)) + "°") : "顔が見つかりません"}</text></svg>`;
  return s;
}

function barMeter(me, m) {
  const v = clamp(me.value(m, S), 0, 1);
  const x = (t) => 10 + clamp(t, 0, 1) * 300;
  let s = `<svg viewBox="0 0 320 70"><text x="10" y="18" fill="#a7a4b3" font-size="14">${me.label}</text>`;
  s += `<rect x="10" y="28" width="300" height="22" rx="11" fill="#2f2c39"/>`;
  s += `<rect x="${x(me.lo)}" y="28" width="${x(me.hi) - x(me.lo)}" height="22" rx="8" fill="var(--pink)" opacity=".28"/>`;
  s += `<rect x="10" y="28" width="${x(v) - 10}" height="22" rx="11" fill="${okNow ? "var(--ok)" : "#fff"}"/>`;
  s += `<line x1="${x(me.lo)}" y1="22" x2="${x(me.lo)}" y2="56" stroke="var(--pink)" stroke-width="3"/>`;
  s += `<text x="${x(me.lo)}" y="68" fill="var(--pink)" font-size="12" text-anchor="middle">目標</text></svg>`;
  return s;
}

function renderMeter(step, m) {
  const box = $("#meter");
  if (!step) { box.innerHTML = ""; return; }
  if (step.gauge && step.gauge.type === "yaw") box.innerHTML = yawGauge(step.gauge, m);
  else if (step.gauge && step.gauge.type === "pitch") box.innerHTML = pitchGauge(step.gauge, m);
  else if (step.meter) box.innerHTML = barMeter(step.meter, m);
  else if (step.gesture) {
    const now = m.hands.length === 1 ? m.hands[0].gestureName : m.hands.length ? "手が 2 つ" : "見つかりません";
    box.innerHTML = `<div class="chips"><span class="${okNow ? "ok" : ""}">いま：${now}</span><span>目標：${step.gesture.wantName}</span></div>`;
  } else if (step.phase === "body") {
    const p = m.pose.found ? m.pose : null;
    const parts = ["頭", "肩", "腰", "足首"].map((n) => `<span class="${p && p.seen[n] ? "ok" : "ng"}">${n} ${p && p.seen[n] ? "✓" : "✕"}</span>`);
    box.innerHTML = `<div class="chips">${parts.join("")}</div>`;
  } else box.innerHTML = "";
}

function phaseOf(step) { return PHASES.find((p) => p.id === step.phase); }

function renderStepCard(step) {
  const ph = phaseOf(step);
  $("#phasename").textContent = `${ph.name}・${ph.place}`;
  $("#stepno").textContent = `${S.pos + 1} / ${S.order.length}`;
  $("#phasechip").textContent = ph.name;
  $("#picto").innerHTML = picto(step.picto);
  $("#title").textContent = step.title;
  $("#say").textContent = step.say;
  $("#farpicto").innerHTML = picto(step.picto);
  $("#fartitle").textContent = step.title;
  const far = step.phase === "body";
  $("#farbox").hidden = !far;
  $("#studio").classList.toggle("far", far);
  const tag = $("#guidetag");
  tag.hidden = !step.guide || far;
  tag.textContent = GUIDE_TEXT[step.guide] || "";
  setHint("");
  hold(0);
  updateStepList();
}

function renderStepList() {
  const box = $("#steplist");
  box.innerHTML = "";
  let last = null;
  S.order.forEach((si, k) => {
    const step = STEPS[si];
    if (step.phase !== last) {
      last = step.phase;
      const h = document.createElement("h4");
      h.textContent = phaseOf(step).name;
      box.append(h);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.k = k;
    b.innerHTML = `<span class="ic"></span><span>${esc(step.title)}</span>`;
    b.addEventListener("click", () => jumpTo(k));
    box.append(b);
  });
  updateStepList();
}

function updateStepList() {
  if (!S) return;
  for (const b of document.querySelectorAll("#steplist button")) {
    const k = Number(b.dataset.k);
    const step = STEPS[S.order[k]];
    const t = S.thumbs.find((x) => x.id === step.id);
    const cur = k === S.pos;
    b.className = cur ? "cur" : t ? (t.ok ? "auto" : "timer") : "";
    b.querySelector(".ic").textContent = cur ? "●" : t ? (t.ok ? "✓" : "⏱") : S.skipped.includes(step.id) ? "–" : "○";
  }
}

// ------------------------------------------------------------ 声（効果音は使わない。合図も声で出す）
let speechReady = false;
function unlockSpeech() {
  // iPhone は、ボタンを押した時に一度しゃべらせておかないと、あとで声が出ない
  if (speechReady || !("speechSynthesis" in window)) return;
  try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); speechReady = true; } catch (e) { /* 声なしで続ける */ }
}
function jaVoice() { return speechSynthesis.getVoices().find((x) => x.lang && x.lang.replace("_", "-").startsWith("ja")); }
function speak(text) {
  return new Promise((resolve) => {
    if (!voiceOn || TEST || !("speechSynthesis" in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP"; u.rate = 1.05;
    const v = jaVoice();
    if (v) u.voice = v;
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    u.onend = fin; u.onerror = fin;
    setTimeout(fin, 4000 + text.length * 180);
    speechSynthesis.speak(u);
  });
}
function cue(text) { speak(text); } // 待たずに言う（カウントダウンなど）
function hush() { if (window.speechSynthesis) window.speechSynthesis.cancel(); }
function setVoice(on) {
  voiceOn = on;
  $("#voice").checked = on;
  $("#voicebtn").textContent = `声：${on ? "オン" : "オフ"}`;
  if (!on) hush();
}

// ------------------------------------------------------------ 撮る
const small = document.createElement("canvas");
const sctx = small.getContext("2d", { willReadFrequently: true });

// 画像のくっきり度（ラプラシアンの分散）。crop は 0〜1 の [x0, y0, x1, y1]
function sharpness(src, crop) {
  const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
  if (!sw || !sh) return 0;
  let [x0, y0, x1, y1] = crop || [0, 0, 1, 1];
  x0 = clamp(x0, 0, 1); y0 = clamp(y0, 0, 1); x1 = clamp(x1, 0, 1); y1 = clamp(y1, 0, 1);
  const cw = Math.max(8, (x1 - x0) * sw), ch = Math.max(8, (y1 - y0) * sh);
  const w = 160, h = Math.max(8, Math.round((w * ch) / cw));
  small.width = w; small.height = h;
  sctx.drawImage(src, x0 * sw, y0 * sh, cw, ch, 0, 0, w, h);
  const d = sctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    sum += l; sum2 += l * l; n++;
  }
  return n ? sum2 / n - (sum / n) ** 2 : 0;
}

function measureBrightness() {
  if (!video.videoWidth) return null;
  small.width = 48; small.height = 48;
  sctx.drawImage(video, 0, 0, 48, 48);
  const d = sctx.getImageData(0, 0, 48, 48).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return s / (d.length / 4);
}

function cropFor(m) {
  if (m.face.found) { const [x0, y0, x1, y1] = m.face.box; return [x0 - 0.05, y0 - 0.1, x1 + 0.05, y1 + 0.05]; }
  if (m.hands.length) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const h of m.hands) for (const p of h.lm) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return [x0 - 0.03, y0 - 0.03, x1 + 0.03, y1 + 0.03];
  }
  return null;
}

// その瞬間の映像を、そのままの大きさで写す（ImageBitmap が使えない端末もあるので canvas に）
function grab() {
  const c = document.createElement("canvas");
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  return c;
}
const toJpeg = (c, q = 0.92) => new Promise((r) => c.toBlob(r, "image/jpeg", q));
function thumbOf(c) {
  const t = document.createElement("canvas");
  const w = 200, h = Math.round((w * c.height) / c.width);
  t.width = w; t.height = h;
  t.getContext("2d").drawImage(c, 0, 0, w, h);
  return t.toDataURL("image/jpeg", 0.7);
}

function metaOf(m, step, verified) {
  const o = { step: step.id, title: step.title, verified, time: new Date().toISOString(), camera: { w: m.W, h: m.H, facing } };
  if (m.face.found) o.face = { yaw: rnd(m.face.yaw, 1), pitch: rnd(m.face.pitch, 1), size: rnd(m.face.size, 3), bs: Object.fromEntries(Object.entries(m.face.bs).map(([k, v]) => [k, rnd(v, 3)])), lm: m.face.lm.map((p) => [rnd(p.x), rnd(p.y), rnd(p.z)]) };
  if (m.hands.length) o.hands = m.hands.map((h) => ({ label: h.label, gesture: h.gesture, ext: h.ext, lm: h.lmc }));
  if (m.pose.found) o.pose = { width: rnd(m.pose.width, 3), armL: rnd(m.pose.armL, 1), armR: rnd(m.pose.armR, 1), lm: m.pose.lmc };
  return o;
}
const jsonBlob = (o) => new Blob([JSON.stringify(o)], { type: "application/json" });
const fileBase = (step) => `${pad(STEPS.indexOf(step) + 1)}_${step.id}`;

async function capturePhoto(verified) {
  const step = st.step;
  const my = runId;
  st.state = "capturing";
  hold(1);
  setPill("shot", "撮影！");
  const shots = [];
  for (let k = 0; k < BURST; k++) {
    const m = M;
    const ok = !step.check || !verified || step.check(m, S);
    const sharp = sharpness(video, cropFor(m));
    shots.push({ m, ok, sharp, c: grab() });
    await sleep(90);
  }
  shots.sort((a, b) => (b.ok - a.ok) || (b.sharp - a.sharp));
  const best = shots[0];
  buzz(40);
  flash();
  const base = fileBase(step);
  const jpg = await toJpeg(best.c);
  const thumb = thumbOf(best.c);
  if (step.onCapture) step.onCapture(best.m, S);
  await deleteStep(step.id);
  await saveFile(`${base}.jpg`, jpg, step.id);
  await saveFile(`${base}.json`, jsonBlob(metaOf(best.m, step, verified && best.ok)), step.id);
  addThumb(step, thumb, verified && best.ok);
  if (my === runId) finishStep(verified && best.ok ? "auto" : "timer");
}

function pickRecorderType() {
  const types = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  for (const t of types) if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

// 録画。まずカメラの映像を直接録り、1.5 秒たってもデータが来なければ canvas に描いた映像から録る方式に切り替える
let recCanvas = null;
function canvasStream() {
  recCanvas = recCanvas || document.createElement("canvas");
  recCanvas.width = video.videoWidth;
  recCanvas.height = video.videoHeight;
  const g = recCanvas.getContext("2d");
  const mine = st;
  const draw = () => {
    if (st !== mine || !st || st.state !== "recording") return;
    g.drawImage(video, 0, 0, recCanvas.width, recCanvas.height);
    requestAnimationFrame(draw);
  };
  draw();
  return recCanvas.captureStream(30);
}

function makeRecorder(src) {
  const type = pickRecorderType();
  const rec = new MediaRecorder(src, type ? { mimeType: type, videoBitsPerSecond: 2_500_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) { chunks.push(e.data); if (st && st.rec === rec) st.recBytes += e.data.size; } };
  rec.onerror = (e) => console.warn("REC error", e.error && e.error.name);
  st.rec = rec; st.chunks = chunks; st.recBytes = 0;
  st.recType = rec.mimeType || type || "video/webm";
  rec.start(500);
  return rec;
}

function startRecording() {
  const step = st.step;
  st.timeline = []; st.bins = {};
  st.state = "recording";
  st.recStart = performance.now();
  st.recUntil = st.recStart + (TEST ? 3000 : step.seconds * 1000);
  makeRecorder(stream);
  cue("スタート");
  buzz(60);
  const mine = st;
  setTimeout(() => {
    if (st !== mine || st.state !== "recording" || st.recBytes > 0) return;
    console.warn("カメラから直接の録画にデータが来ないので、canvas 経由に切り替えます");
    const old = st.rec;
    old.ondataavailable = null;
    try { old.stop(); } catch (e) { /* もう止まっていてもよい */ }
    const keep = st.recUntil - performance.now();
    makeRecorder(canvasStream());
    st.recUntil = performance.now() + Math.max(keep, 1000) + 1500;
  }, 1500);
}

// 首振り動画の途中で、角度ごとに一番くっきりした 1 枚を取っておく
function sweepCandidate(m) {
  if (!m.face.found) return;
  const bin = SWEEP_BINS.find((b) => Math.abs(b - m.face.yaw) <= 5);
  if (bin === undefined) return;
  const sharp = sharpness(video, cropFor(m));
  const cur = st.bins[bin];
  if (cur && cur.sharp >= sharp) return;
  st.bins[bin] = { sharp, m, c: grab() };
}

async function stopRecording() {
  const step = st.step;
  const my = runId;
  st.state = "capturing";
  setPill("", "保存しています…");
  const rec = st.rec;
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  cue("ストップ");
  buzz(60);
  const ext = st.recType.includes("mp4") ? "mp4" : "webm";
  const base = fileBase(step);
  const blob = new Blob(st.chunks, { type: st.recType.split(";")[0] });
  await deleteStep(step.id);
  if (blob.size > 0) await saveFile(`${base}.${ext}`, blob, step.id);
  else toast("動画が録れていませんでした。角度ごとの写真とデータは残します", 6000);
  await saveFile(`${base}_timeline.json`, jsonBlob({ step: step.id, blendshapeNames: step.id === "talk" ? BS_NAMES : undefined, frames: st.timeline }), step.id);
  let thumb = null;
  for (const [bin, c] of Object.entries(st.bins)) {
    const sign = Number(bin) > 0 ? "L" : Number(bin) < 0 ? "R" : "";
    const name = `${base}_yaw${sign}${pad(Math.abs(Number(bin)))}`;
    await saveFile(`${name}.jpg`, await toJpeg(c.c), step.id);
    await saveFile(`${name}.json`, jsonBlob(metaOf(c.m, step, true)), step.id);
    if (Number(bin) === 0 || !thumb) thumb = thumbOf(c.c);
  }
  if (!thumb) thumb = thumbOf(grab());
  addThumb(step, thumb, true, `動画 ${Math.round((performance.now() - st.recStart) / 1000)}秒`);
  if (my === runId) finishStep("video");
}

function addThumb(step, url, ok, note) {
  const i = S.thumbs.findIndex((t) => t.id === step.id);
  const t = { id: step.id, title: step.title, url, ok, note: note || (ok ? "" : "タイマー撮影") };
  if (i >= 0) S.thumbs[i] = t; else S.thumbs.push(t);
  updateStepList();
}

// ------------------------------------------------------------ 進行
function phaseCard(phaseId, my) {
  const ph = PHASES.find((p) => p.id === phaseId);
  const k = S.phases.indexOf(phaseId);
  $("#pc_picto").innerHTML = picto(ph.picto);
  $("#pc_no").textContent = `${k + 1} / ${S.phases.length}　${k === 0 ? "はじめは" : "次は"}`;
  $("#pc_name").textContent = ph.name;
  $("#pc_place").textContent = ph.place;
  $("#pc_intro").textContent = ph.intro;
  $("#pc_tip").textContent = ph.tip || "";
  $("#phaseoverlay").hidden = false;
  $("#farbox").hidden = true;
  $("#studio").classList.remove("far");
  $("#guidetag").hidden = true;
  $("#picto").innerHTML = picto(ph.picto);
  $("#title").textContent = `${k === 0 ? "はじめは" : "次は"}「${ph.name}」`;
  $("#say").textContent = ph.place;
  $("#meter").innerHTML = "";
  $("#phasename").textContent = "";
  $("#phasechip").textContent = ph.name;
  hold(0);
  setPill("", "案内中");
  setHint("");
  return new Promise((resolve) => {
    const until = performance.now() + T(PHASE_WAIT[phaseId] || 8000);
    let done = false;
    const end = () => { if (done) return; done = true; clearInterval(iv); $("#phaseoverlay").hidden = true; resolve(); };
    const iv = setInterval(() => {
      if (my !== runId) return end();
      const left = Math.ceil((until - performance.now()) / 1000);
      $("#pc_left").textContent = `あと ${Math.max(0, left)} 秒で始まります`;
      if (left <= 0 && !paused) end();
    }, 200);
    $("#pc_go").onclick = () => { unlockSpeech(); end(); };
    speak(ph.intro);
  });
}

async function needDetectors(step) {
  for (const n of step.need || []) {
    if (detectors[n] || !loading[n]) continue;
    setPill("", "判定の準備中…");
    setHint("顔や体を見分ける準備をしています。少し待ってください");
    try { await loading[n]; } catch (e) { /* 失敗はタイマー撮影で続ける */ }
  }
}

async function startStep() {
  const my = ++runId;
  if (S.pos >= S.order.length) return finishSession();
  const step = STEPS[S.order[S.pos]];
  st = null;
  okNow = false;
  big("");
  showPanel("now");
  if (step.phase !== S.lastPhase && !S.redo) {
    S.lastPhase = step.phase;
    await phaseCard(step.phase, my);
    if (my !== runId) return;
  }
  S.lastPhase = step.phase;
  await needDetectors(step);
  if (my !== runId) return;
  st = { step, state: "intro", t0: performance.now(), holdSince: null, verified: true };
  renderStepCard(step);
  setPill("", "説明中…");
  await speak(step.say);
  if (my !== runId || !st || st.step !== step) return;
  st.prepUntil = performance.now() + T(step.prep ?? 2000);
}

function finishStep(how) {
  const step = st.step;
  if (!S.done.includes(step.id)) S.done.push(step.id);
  S.skipped = S.skipped.filter((x) => x !== step.id);
  S.pos = S.redo ? S.order.length : S.pos + 1;
  persist();
  st = null;
  okNow = false;
  const my = runId;
  setTimeout(() => { if (!paused && my === runId) startStep(); }, how === "video" ? 600 : 900);
}

function startCountdown(now, verified = true) {
  st.state = "countdown"; st.countUntil = now + T(3000); st.lastCue = null; st.verified = verified;
}

function tick(now) {
  if (!st || (paused && st.state !== "recording")) return;
  const step = st.step;
  renderMeter(step, M);
  if (st.state === "intro") {
    if (!st.prepUntil) return;
    const left = st.prepUntil - now;
    if (left > 0) {
      setPill("", `準備　あと ${Math.ceil(left / 1000)} 秒`);
      if (step.hint) setHint(step.hint(M, S));
      return;
    }
    if (step.kind === "video") return startCountdown(now);
    if (step.check) { st.state = "seek"; st.seekStart = now; return; }
    return startCountdown(now, false);
  }
  if (st.state === "seek") {
    const ok = step.check(M, S);
    okNow = ok;
    setHint(step.hint ? step.hint(M, S) : "");
    if (ok) {
      setPill("ok", "そのまま…");
      st.holdSince = st.holdSince ?? now;
      const p = (now - st.holdSince) / T(step.hold ?? 500);
      hold(p);
      if (p >= 1 && !FREEZE) capturePhoto(true);
    } else {
      setPill("seek", "お手本に合わせてください");
      st.holdSince = null;
      hold(0);
      if (!FREEZE && now - st.seekStart > T(step.timeout ?? 14000)) {
        startCountdown(now, false);
        setHint("自動では合わなかったので、このまま撮ります");
      }
    }
    return;
  }
  if (st.state === "countdown") {
    const left = Math.ceil((st.countUntil - now) / 1000);
    if (left > 0) {
      big(String(left));
      setPill("", step.kind === "video" ? `${left} 秒後に録画` : `${left} 秒後に撮影`);
      if (st.lastCue !== left) { st.lastCue = left; cue(String(left)); }
      return;
    }
    big("");
    if (step.kind === "video") startRecording(); else capturePhoto(st.verified);
    return;
  }
  if (st.state === "recording") {
    const left = Math.ceil((st.recUntil - now) / 1000);
    big(`● 録画中 ${left}`, true);
    setPill("rec", `● 録画中　あと ${left} 秒`);
    hold(1 - (st.recUntil - now) / (st.recUntil - st.recStart));
    if (step.record) st.timeline.push(step.record(M, S));
    if (step.sweep) sweepCandidate(M);
    if (now >= st.recUntil) { big(""); stopRecording(); }
  }
}

function updateChecks(m) {
  const rows = [];
  const s = stream && stream.getVideoTracks()[0] ? stream.getVideoTracks()[0].getSettings() : null;
  const w = video.videoWidth, h = video.videoHeight;
  rows.push(!s || !w ? ["wait", "カメラ", "準備中…"] : Math.min(w, h) >= 720 ? ["ok", "カメラ", `${w}×${h}`] : ["ng", "カメラ", `${w}×${h}。少し粗いですが撮れます`]);
  rows.push(faceReady ? ["ok", "判定", "準備できました"] : ["wait", "判定", "準備中…（はじめは 30 秒ほどかかることがあります）"]);
  rows.push(!faceReady ? ["wait", "顔", "判定の準備を待っています"] : m.face.found ? ["ok", "顔", "見えています"] : ["ng", "顔", "楕円に顔を合わせてください"]);
  if (brightness != null) rows.push(brightness < 70 ? ["ng", "明るさ", "暗めです。正面から明るくしてください"] : brightness > 215 ? ["ng", "明るさ", "明るすぎます。窓や照明を背にしないで"] : ["ok", "明るさ", "ちょうどよい"]);
  const icon = { ok: "✓", ng: "!", wait: "…" };
  $("#checks").innerHTML = rows.map(([k, a, b]) => `<div class="check ${k}"><span class="ic">${icon[k]}</span><span><b>${a}</b>　${b}</span></div>`).join("");
}

let lastCheck = 0;
function loop() {
  const now = performance.now();
  if (video.readyState >= 2 && now - lastDetect >= 50 && !$("#studio").hidden) {
    lastDetect = now;
    if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) { overlay.width = video.videoWidth; overlay.height = video.videoHeight; }
    if (detectors.face) {
      M = detect();
      drawOverlay(M);
      tick(now);
    }
    if (!$("#ready").hidden && now - lastCheck > 500) {
      lastCheck = now;
      brightness = measureBrightness();
      updateChecks(M);
    }
  }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------ 操作
function canControl() { return !st || st.state === "intro" || st.state === "seek" || st.state === "countdown"; }
function shootNow() {
  if (!st || !canControl()) return;
  if (st.step.kind === "video") { st.state = "countdown"; st.countUntil = performance.now() + 1000; st.lastCue = null; return; }
  capturePhoto(false);
}
function skip() {
  if (!S || !canControl()) return;
  hush();
  const id = STEPS[S.order[S.pos]] && STEPS[S.order[S.pos]].id;
  if (id && !S.skipped.includes(id) && !S.done.includes(id)) S.skipped.push(id);
  S.pos = S.redo ? S.order.length : S.pos + 1;
  persist();
  startStep();
}
function back() {
  if (!S || !canControl()) return;
  hush();
  S.redo = false;
  S.pos = Math.max(0, S.pos - 1);
  startStep();
}
function jumpTo(k) {
  if (!S || !canControl()) return;
  hush();
  S.redo = false;
  S.pos = k;
  paused = false;
  $("#pause").textContent = "一時停止";
  $(".steps").open = false;
  startStep();
}
function togglePause() {
  if (!S) return;
  paused = !paused;
  $("#pause").textContent = paused ? "再開" : "一時停止";
  if (paused) {
    hush();
    if (st && st.state === "recording") return; // 動画は最後まで撮る
    runId++;
    st = null; big("");
    setPill("", "一時停止中");
    setHint("「再開」でこのステップからやり直します");
  } else {
    startStep();
  }
}

document.addEventListener("keydown", (e) => {
  if (!S || S.finished || $("#studio").hidden || !$("#ready").hidden) return;
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
  if (e.code === "Space") { e.preventDefault(); if (!$("#phaseoverlay").hidden) $("#pc_go").click(); else shootNow(); }
  else if (e.key === "s" || e.key === "S") skip();
  else if (e.key === "b" || e.key === "B" || e.key === "ArrowLeft") back();
  else if (e.key === "p" || e.key === "P") togglePause();
});

// ------------------------------------------------------------ カメラ
async function fakeStream() {
  // 手元の確かめ用：動画をスマホの縦（720×1280）に切り抜いて、カメラの代わりに流す
  const v = document.createElement("video");
  v.src = FAKE; v.muted = true; v.loop = true; v.playsInline = true;
  await v.play();
  const land = Q.get("shape") === "land";
  const c = document.createElement("canvas");
  c.width = land ? 1280 : 720; c.height = land ? 720 : 1280;
  const g = c.getContext("2d");
  const draw = () => {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (vw) {
      const s = Math.max(c.width / vw, c.height / vh);
      g.drawImage(v, (c.width - vw * s) / 2, (c.height - vh * s) / 2, vw * s, vh * s);
    }
    requestAnimationFrame(draw);
  };
  draw();
  return c.captureStream(30);
}

async function openCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (FAKE) stream = await fakeStream();
  else {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const e = new Error("no media"); e.name = "NoMedia"; throw e; }
    const v = { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadedmetadata", r, { once: true }));
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  setMirror();
}
const cameraLive = () => stream && stream.getVideoTracks().some((t) => t.readyState === "live");

function permHelp(err) {
  const box = $("#perm_help");
  const n = err && err.name;
  let html;
  if (n === "NotAllowedError" || n === "SecurityError") {
    const how = OS === "ios"
      ? "<ol><li>アドレス欄の左の「ぁあ」（または「AA」）を押す</li><li>「Web サイトの設定」→「カメラ」を「許可」にする</li><li>このページを読み込み直す</li></ol><p>出てこない時は、iPhone の「設定」→「アプリ」→「Safari」→「カメラ」を「確認」か「許可」にします。</p>"
      : OS === "android"
        ? "<ol><li>アドレス欄の左のマーク（鍵や設定の形）を押す</li><li>「権限」または「サイトの設定」で「カメラ」を「許可」にする</li><li>このページを読み込み直す</li></ol>"
        : "<ol><li>アドレス欄の左のマークを押す</li><li>「カメラ」を「許可」にする</li><li>このページを読み込み直す</li></ol>";
    html = `<b>カメラが「許可しない」になっています</b>${how}`;
  } else if (n === "NotFoundError" || n === "OverconstrainedError") {
    html = "<b>カメラが見つかりません</b><p>カメラのある端末（スマホなど）で開いてください。</p>";
  } else if (n === "NotReadableError" || n === "AbortError") {
    html = "<b>カメラを使えませんでした</b><p>ほかのアプリ（ビデオ通話など）がカメラを使っていないか確かめて、閉じてからもう一度押してください。</p>";
  } else if (n === "NoMedia") {
    html = "<b>このブラウザではカメラを使えません</b><p>iPhone は Safari、Android は Chrome で開いてください。LINE などのアプリの中で開いている時は、メニューから「ブラウザで開く」を選びます。</p>";
  } else {
    html = `<b>カメラを開けませんでした</b><p>ページを読み込み直して、もう一度試してください。（${esc(n || "不明")}）</p>`;
  }
  box.innerHTML = html;
  box.hidden = false;
}

async function requestCamera() {
  $("#perm_go").disabled = true;
  try {
    await openCamera();
  } catch (e) {
    console.error(e);
    $("#perm_title").textContent = "カメラが使えません";
    $("#perm_text").textContent = "次の手順で、カメラを許可してください。";
    $("#perm_go").textContent = "もう一度ためす";
    $("#perm_go").disabled = false;
    permHelp(e);
    return;
  }
  $("#perm_go").disabled = false;
  $("#perm_help").hidden = true;
  showPage("studio");
  if (!loopOn) { loopOn = true; requestAnimationFrame(loop); }
  loadModels();
  const next = afterCamera; afterCamera = null;
  if (next) next();
}

// カメラが要る所へ進む。もう許可されていれば、許可の案内を飛ばす
async function withCamera(next) {
  if (cameraLive()) { showPage("studio"); return next(); }
  afterCamera = next;
  let granted = !!FAKE;
  try { if (!granted && navigator.permissions) granted = (await navigator.permissions.query({ name: "camera" })).state === "granted"; } catch (e) { /* 聞けない端末もある */ }
  if (granted) return requestCamera();
  $("#perm_title").textContent = "カメラを使います";
  $("#perm_text").innerHTML = "このあと「カメラへのアクセスを許可しますか？」と出たら、<b>「許可」</b>を押してください。映像はこの端末の中だけで使います。";
  $("#perm_go").textContent = "カメラをオンにする";
  $("#perm_help").hidden = true;
  showPage("perm");
}

async function switchFacing(f) {
  if (facing === f) return;
  facing = f;
  $("#cam_user").classList.toggle("on", f === "user");
  $("#cam_env").classList.toggle("on", f === "environment");
  try { await openCamera(); } catch (e) { toast("そのカメラを開けませんでした"); facing = f === "user" ? "environment" : "user"; await openCamera().catch(() => {}); }
}

async function loadModels() {
  if (loading.face) return;
  const vision = (async () => {
    const mod = await import(VENDOR + "vision_bundle.mjs");
    const V = mod.FaceLandmarker ? mod : mod.default;
    const fs = await V.FilesetResolver.forVisionTasks(VENDOR + "wasm");
    return { V, fs };
  })();
  const make = async (name, opts) => {
    const { V, fs } = await vision;
    const Cls = { face: V.FaceLandmarker, hands: V.HandLandmarker, pose: V.PoseLandmarker }[name];
    try { return await Cls.createFromOptions(fs, { ...opts, baseOptions: { ...opts.baseOptions, delegate: "GPU" } }); }
    catch (e) {
      console.warn("GPU が使えないので CPU で動かします", e);
      return await Cls.createFromOptions(fs, { ...opts, baseOptions: { ...opts.baseOptions, delegate: "CPU" } });
    }
  };
  loading.face = make("face", { baseOptions: { modelAssetPath: MODELS.face }, runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true });
  try {
    detectors.face = await loading.face;
  } catch (e) {
    console.error(e);
    toast("判定の準備に失敗しました。電波のよい所でページを読み込み直してください。", 15000);
    return;
  }
  faceReady = true;
  $("#go").disabled = false;
  console.log("FACE_READY");
  // 手と体は、顔の撮影をしている間に用意する
  loading.hands = make("hands", { baseOptions: { modelAssetPath: MODELS.hands }, runningMode: "VIDEO", numHands: 2 });
  detectors.hands = await loading.hands.catch((e) => console.error(e));
  loading.pose = make("pose", { baseOptions: { modelAssetPath: MODELS.pose }, runningMode: "VIDEO", numPoses: 1 });
  detectors.pose = await loading.pose.catch((e) => console.error(e));
  console.log("MODELS_READY");
}

// 画面が消えないようにする（スマホを立てかけている間に暗くならないように）
async function keepAwake() {
  try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch (e) { /* できない端末もある */ }
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") { hush(); return; }
  if (!S || S.finished || $("#studio").hidden) return;
  keepAwake();
  if (!cameraLive()) {
    // ほかのアプリに切り替えると、カメラが止まることがある。開き直して、今のステップからやり直す
    try { await openCamera(); } catch (e) { return withCamera(() => startStep()); }
    if (!$("#now").hidden) { runId++; st = null; if (!paused) startStep(); }
  }
});

// ------------------------------------------------------------ 始める・終わる
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function jaDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${pad(d.getMinutes())}`;
}
function safeName(t) {
  return (t || "").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 30) || "名前なし";
}

function begin() {
  unlockSpeech();
  keepAwake();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* なくてもよい */ }
  if (pending.resume) {
    S = { ...pending.resume, lastYaw: 0, lastYawT: 0, lastPhase: null, redo: false, facing };
  } else {
    const order = STEPS.map((s, i) => [s, i]).filter(([s]) => pending.phases.includes(s.phase)).map(([, i]) => i);
    const start = TEST && Q.get("start") ? Math.max(0, order.findIndex((i) => STEPS[i].id === Q.get("start"))) : 0;
    S = {
      v: 1, name: pending.name, height: pending.height, startedAt: new Date().toISOString(), facing,
      order, pos: start, done: [], skipped: [], base: {}, ctx: {}, thumbs: [], phases: pending.phases, finished: false,
      lastYaw: 0, lastYawT: 0, lastPhase: null, redo: false,
    };
  }
  persist();
  renderStepList();
  paused = false;
  startStep();
}

async function contactSheet() {
  if (!S.thumbs.length) return null;
  const imgs = await Promise.all(S.thumbs.map((t) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = t.url; })));
  const cols = 6, cw = 200, ch = 260, lab = 26;
  const rows = Math.ceil(imgs.length / cols);
  const c = document.createElement("canvas");
  c.width = cols * cw; c.height = rows * (ch + lab);
  const g = c.getContext("2d");
  g.fillStyle = "#141318"; g.fillRect(0, 0, c.width, c.height);
  g.font = "14px 'Hiragino Sans', 'Noto Sans JP', sans-serif"; g.textBaseline = "middle";
  imgs.forEach((im, i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * (ch + lab);
    if (im) {
      const s = Math.min(cw / im.width, ch / im.height);
      g.drawImage(im, x + (cw - im.width * s) / 2, y + (ch - im.height * s) / 2, im.width * s, im.height * s);
    }
    const t = S.thumbs[i];
    g.fillStyle = t.ok ? "#ecebf0" : "#f0579b";
    g.fillText(`${t.title}${t.ok ? "" : "（タイマー）"}`.slice(0, 14), x + 6, y + ch + lab / 2);
  });
  return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
}

async function finishSession() {
  runId++;
  st = null;
  S.redo = false;
  S.finished = true;
  S.finishedAt = new Date().toISOString();
  big("");
  $("#farbox").hidden = true;
  $("#studio").classList.remove("far");
  setPill("", "まとめています…");
  const sheet = await contactSheet();
  if (sheet) await saveFile("00_contact_sheet.jpg", sheet, "_session");
  persist();
  zipBlob = null;
  speak("撮影はこれで終わりです。おつかれさまでした。");
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  renderFinish();
  console.log("SESSION_DONE", S.thumbs.length);
}

function zipBaseName() { return `撮影_${safeName(S.name)}_${stamp(new Date(S.startedAt))}`; }

async function renderFinish() {
  showPage("finish");
  const timer = S.thumbs.filter((t) => !t.ok).length;
  $("#fin_lead").textContent = `${S.thumbs.length} / ${S.order.length} 件を撮りました。` +
    (timer ? `うち ${timer} 件は、自動で合わずタイマーで撮りました。` : "") +
    "下の「ZIP を作る」から、まとめて送ってください。";
  $("#save_note").textContent = OS === "ios" ? "iPhone では「ファイル」アプリの「ダウンロード」に入ります。「送る」なら LINE やメールにそのまま渡せます。"
    : OS === "android" ? "「ダウンロード」フォルダに入ります。「送る」なら LINE やメールにそのまま渡せます。"
      : "ダウンロードのフォルダに入ります。";
  const files = await allFiles();
  const bytes = files.reduce((a, f) => a + f.size, 0);
  const photos = files.filter((f) => f.name.endsWith(".jpg")).length;
  const videos = files.filter((f) => /\.(mp4|webm)$/.test(f.name)).length;
  $("#zipinfo").innerHTML = `ファイル名：<code>${esc(zipBaseName())}.zip</code><br>写真 ${photos} 枚・動画 ${videos} 本・合わせて約 ${Math.max(1, Math.round(bytes / 1048576))} MB`;
  $("#zipbtns").hidden = !zipBlob;
  $("#makezip").hidden = !!zipBlob;
  const grid = $("#fin_grid");
  grid.innerHTML = "";
  S.order.forEach((si, k) => {
    const step = STEPS[si];
    const t = S.thumbs.find((x) => x.id === step.id);
    const tag = t ? (t.ok ? ["auto", "自動"] : ["timer", "タイマー"]) : S.skipped.includes(step.id) ? ["", "飛ばした"] : ["", "まだ"];
    const card = document.createElement("div");
    card.className = "shot";
    card.innerHTML = `<div class="img">${t ? "" : "まだありません"}</div>` +
      `<div class="body"><b>${esc(step.title)}</b><span class="tag ${tag[0]}">${tag[1]}${t && t.note && t.ok ? "・" + esc(t.note) : ""}</span><button type="button">${t ? "撮り直す" : "撮る"}</button></div>`;
    if (t) card.querySelector(".img").style.backgroundImage = `url("${t.url}")`;
    card.querySelector("button").addEventListener("click", () => redo(k));
    grid.append(card);
  });
}

function redo(k) {
  withCamera(() => {
    S.finished = false;
    S.redo = true;
    S.pos = k;
    paused = false;
    zipBlob = null;
    keepAwake();
    showPanel("now");
    renderStepList();
    startStep();
  });
}

function memoText(files) {
  const timer = S.thumbs.filter((t) => !t.ok).map((t) => t.title);
  const skipped = S.skipped.map((id) => (STEPS.find((s) => s.id === id) || {}).title || id);
  const lines = [
    "3D キャラ用の撮影",
    "========================",
    `お名前　　：${S.name}`,
    `撮影日　　：${jaDate(S.startedAt)}`,
    `身長　　　：${S.height ? S.height + " cm" : "未入力"}`,
    `カメラ　　：${S.facing === "environment" ? "後ろのカメラ（だれかが撮った）" : "前のカメラ（自撮り）"}`,
    `撮れた数　：${S.thumbs.length} / ${S.order.length}`,
    `タイマー　：${timer.length ? timer.join("、") : "なし"}`,
    `飛ばした物：${skipped.length ? skipped.join("、") : "なし"}`,
    `端末　　　：${navigator.userAgent}`,
    "",
    "ファイルの見方",
    "- NN_名前.jpg ……… 写真",
    "- NN_名前.json ……… その写真の顔・手・体の点の位置など",
    "- NN_名前.mp4 / .webm …… 動画（声は入っていません）",
    "- NN_名前_timeline.json …… 動画の間の点の動き",
    "- NN_face_sweep_yawL45.jpg など …… 首振り動画から角度ごとに切り出した写真",
    "- 00_contact_sheet.jpg …… 撮った写真の一覧",
    "- 00_manifest.json …… 撮影の記録（プログラムで読む用）",
    "",
    "手順の一覧",
    ...S.order.map((i) => {
      const st2 = STEPS[i];
      const mark = S.done.includes(st2.id) ? "○" : S.skipped.includes(st2.id) ? "－" : "　";
      return `${mark} ${fileBase(st2)}　${st2.title}`;
    }),
    "",
    `ファイルの数：${files.length}`,
  ];
  return lines.join("\r\n") + "\r\n";
}

async function buildZip() {
  const btn = $("#makezip");
  btn.disabled = true;
  btn.textContent = "まとめています…";
  const prog = $("#zipprog");
  prog.hidden = false;
  try {
    const files = await allFiles();
    const base = zipBaseName();
    const track = stream && stream.getVideoTracks()[0];
    const manifest = {
      kind: "3d-character-capture", version: 1, name: S.name, height_cm: S.height ? Number(S.height) : null,
      started: S.startedAt, finished: S.finishedAt || null, facing: S.facing, phases: S.phases,
      done: S.done, skipped: S.skipped, timer_shots: S.thumbs.filter((t) => !t.ok).map((t) => t.id), base: S.base,
      camera: track ? { settings: track.getSettings() } : null, userAgent: navigator.userAgent,
      steps: S.order.map((i) => ({ file: fileBase(STEPS[i]), id: STEPS[i].id, title: STEPS[i].title })),
      files: files.map((f) => f.name),
    };
    const entries = [
      { name: `${base}/00_はじめに読む.txt`, blob: new Blob(["﻿" + memoText(files)], { type: "text/plain" }) },
      { name: `${base}/00_manifest.json`, blob: jsonBlob(manifest) },
      ...files.map((f) => ({ name: `${base}/${f.name}`, blob: f.blob })),
    ];
    zipBlob = await makeZip(entries, (i, n) => { prog.firstElementChild.style.width = `${(i / n) * 100}%`; });
    zipName = `${base}.zip`;
    $("#zipinfo").innerHTML = `できました：<code>${esc(zipName)}</code>（約 ${Math.max(1, Math.round(zipBlob.size / 1048576))} MB）`;
    $("#zipbtns").hidden = false;
    btn.hidden = true;
    const f = new File([zipBlob], zipName, { type: "application/zip" });
    $("#sharezip").hidden = !(navigator.canShare && navigator.canShare({ files: [f] }));
    if (TEST) window.__zip = zipBlob;
    console.log("ZIP_READY", zipName, zipBlob.size);
  } catch (e) {
    console.error(e);
    toast("ZIP を作れませんでした。もう一度押してください。何度もだめな時は、端末の空き容量を確かめてください。", 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = "ZIP を作る";
    prog.hidden = true;
  }
}

function saveZip() {
  if (!zipBlob) return;
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url; a.download = zipName; a.rel = "noopener";
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  toast("保存しました。保存した ZIP を、撮影を頼まれた人に送ってください", 6000);
}

async function shareZip() {
  if (!zipBlob) return;
  const f = new File([zipBlob], zipName, { type: "application/zip" });
  try { await navigator.share({ files: [f], title: zipName }); }
  catch (e) { if (e.name !== "AbortError") { console.warn(e); toast("送る画面を開けませんでした。「保存する」を使ってください", 6000); } }
}

async function wipe() {
  if (!confirm("撮った写真と動画を、この端末から消します。ZIP は送りましたか？\n（保存した ZIP ファイルは消えません）")) return;
  runId++;
  st = null;
  await clearFiles();
  try { localStorage.removeItem(STORE); } catch (e) { /* なくてもよい */ }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  location.replace(location.pathname);
}

// ------------------------------------------------------------ はじめの画面
function renderIntro() {
  const total = PHASES.reduce((a, p) => a + p.minutes, 0);
  $("#total_time").textContent = `全部で約 ${total} 分`;
  $("#phase_list").innerHTML = PHASES.map((p) => {
    const steps = STEPS.filter((s) => s.phase === p.id);
    const names = steps.map((s) => s.title.replace(/（.*?）/g, "")).slice(0, 6).join("・") + (steps.length > 6 ? " など" : "");
    return `<li><span class="picto">${picto(p.picto)}</span><span><b>${p.name}（${steps.length}）</b><small>${names}</small></span></li>`;
  }).join("");
  $("#phasepick").innerHTML = PHASES.map((p) => {
    const n = STEPS.filter((s) => s.phase === p.id).length;
    return `<label><input type="checkbox" id="ph_${p.id}" checked><span class="picto">${picto(p.picto)}</span><span><b>${p.name}</b><small>${n} 項目・約 ${p.minutes} 分・${p.place}</small></span></label>`;
  }).join("");

  const ua = navigator.userAgent;
  const inapp = /\bLine\//i.test(ua) ? "line" : /Instagram|FBAN|FBAV|Twitter|TikTok|BytedanceWebview|KAKAOTALK|YJApp/i.test(ua) ? "other" : "";
  if (inapp) {
    $("#inapp").hidden = false;
    if (inapp === "line") { $("#inapp_link").hidden = false; $("#inapp_how").textContent = "下のボタンで、いつものブラウザで開き直せます。"; }
    else $("#inapp_how").textContent = OS === "ios" ? "右上（または右下）のメニューから「Safari で開く」を選んでください。" : "右上のメニューから「ブラウザで開く」を選んでください。";
  }

  const check = () => { $("#to_camera").disabled = !($("#name").value.trim() && $("#agree").checked); };
  $("#name").addEventListener("input", check);
  $("#agree").addEventListener("change", check);
  $("#voice").addEventListener("change", (e) => setVoice(e.target.checked));
  $("#to_camera").addEventListener("click", () => {
    const phases = PHASES.map((p) => p.id).filter((id) => $(`#ph_${id}`).checked);
    if (!phases.length) { toast("撮る範囲を 1 つ以上選んでください"); return; }
    unlockSpeech();
    pending = { name: safeName($("#name").value), height: $("#height").value || "", phases };
    $("#go").textContent = "撮影をはじめる";
    withCamera(() => showPanel("ready"));
  });

  const saved = loadSaved();
  if (saved && saved.order && saved.order.length) {
    const r = $("#resume");
    r.hidden = false;
    if (!saved.finished) {
      r.textContent = `続きから撮る（${saved.name} さん・${saved.pos} / ${saved.order.length}）`;
      r.addEventListener("click", () => {
        unlockSpeech();
        pending = { resume: saved };
        if (saved.facing) facing = saved.facing;
        $("#go").textContent = "続きから撮る";
        withCamera(() => showPanel("ready"));
      });
    } else {
      r.textContent = `前回の撮影を開く（${saved.name} さん・ZIP を作る・撮り直す）`;
      r.addEventListener("click", () => {
        S = { ...saved, lastYaw: 0, lastYawT: 0, lastPhase: null, redo: false };
        if (saved.facing) facing = saved.facing;
        renderFinish();
      });
    }
  }
}

$("#perm_go").addEventListener("click", requestCamera);
$("#perm_back").addEventListener("click", () => showPage("intro"));
$("#ready_back").addEventListener("click", () => showPage("intro"));
$("#cam_user").addEventListener("click", () => switchFacing("user"));
$("#cam_env").addEventListener("click", () => switchFacing("environment"));
$("#go").addEventListener("click", begin);
$("#shoot").addEventListener("click", shootNow);
$("#skip").addEventListener("click", skip);
$("#back").addEventListener("click", back);
$("#pause").addEventListener("click", togglePause);
$("#voicebtn").addEventListener("click", () => setVoice(!voiceOn));
$("#makezip").addEventListener("click", buildZip);
$("#savezip").addEventListener("click", saveZip);
$("#sharezip").addEventListener("click", shareZip);
$("#wipe").addEventListener("click", wipe);

renderIntro();
if (TEST) {
  window.__cap = { get S() { return S; }, allFiles, buildZip };
  if (Q.get("name")) { $("#name").value = Q.get("name"); $("#agree").checked = true; $("#name").dispatchEvent(new Event("input")); }
  if (Q.get("phases")) for (const p of PHASES) $(`#ph_${p.id}`).checked = Q.get("phases").split(",").includes(p.id);
}
