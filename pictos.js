// ステップごとの「お手本」の絵（SVG）。key は steps.js の picto。
// 画面は鏡のように表示するので、本人の「左」は画面の左に描く。
const W = 200;
const ACC = "var(--pink)";
const INK = "var(--picto-ink)";
const SKIN = "var(--picto-skin)";
const HAIR = "var(--picto-hair)";
const rad = (d) => (d * Math.PI) / 180;

const svg = (body, extra = "") =>
  `<svg viewBox="0 0 ${W} ${W}" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true" ${extra}>` +
  `<g fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;

function arrowHead(x, y, angDeg, size = 12, color = ACC) {
  const a = rad(angDeg);
  const p1 = [x - size * Math.cos(a - 0.5), y - size * Math.sin(a - 0.5)];
  const p2 = [x - size * Math.cos(a + 0.5), y - size * Math.sin(a + 0.5)];
  return `<path d="M${p1[0]},${p1[1]} L${x},${y} L${p2[0]},${p2[1]}" stroke="${color}" stroke-width="6"/>`;
}

function label(text, y = 192, size = 22) {
  return `<text x="100" y="${y}" text-anchor="middle" font-size="${size}" font-weight="700" fill="${ACC}" stroke="none" font-family="Hiragino Sans, sans-serif">${text}</text>`;
}

// ------------------------------------------------------------ 顔
// yaw: + = 本人の左（画面の左）、pitch: + = 上
function head({ yaw = 0, pitch = 0, hairup = false, back = false, big = false } = {}) {
  const cx = 100, cy = big ? 98 : 92, rx = big ? 60 : 50, ry = big ? 70 : 60;
  let s = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${back ? HAIR : SKIN}"/>`;
  if (back) {
    s += `<path d="M${cx - rx + 8},${cy + 10} Q${cx},${cy + ry + 14} ${cx + rx - 8},${cy + 10}" stroke="${SKIN}" stroke-width="4" opacity=".5"/>`;
    return s;
  }
  const sy = Math.sin(rad(yaw)), cyw = Math.cos(rad(yaw)), sp = Math.sin(rad(pitch));
  const dx = -sy * rx * 0.62, dy = -sp * ry * 0.45;
  // 髪
  if (hairup) {
    s += `<path d="M${cx - rx},${cy - 14} A${rx},${ry} 0 0 1 ${cx + rx},${cy - 14} C${cx + rx - 10},${cy - ry + 18} ${cx - rx + 10},${cy - ry + 18} ${cx - rx},${cy - 14} Z" fill="${HAIR}"/>`;
    s += `<path d="M${cx - rx + 6},${cy - ry + 22} Q${cx},${cy - ry + 8} ${cx + rx - 6},${cy - ry + 22}" stroke="${ACC}" stroke-width="7"/>`;
  } else {
    const hx = dx * 0.5;
    s += `<path d="M${cx - rx},${cy + 2} A${rx},${ry} 0 0 1 ${cx + rx},${cy + 2} C${cx + rx - 4},${cy - 14} ${cx + hx + 16},${cy - 30 + dy} ${cx + hx},${cy - 18 + dy} C${cx + hx - 16},${cy - 30 + dy} ${cx - rx + 4},${cy - 14} ${cx - rx},${cy + 2} Z" fill="${HAIR}"/>`;
  }
  // 目・鼻・口
  const ex = 20 * cyw;
  const ey = cy + 6 + dy;
  if (Math.abs(yaw) < 80) {
    s += `<circle cx="${cx + dx - ex}" cy="${ey}" r="5" fill="${INK}" stroke="none"/><circle cx="${cx + dx + ex}" cy="${ey}" r="5" fill="${INK}" stroke="none"/>`;
  } else {
    s += `<circle cx="${cx + dx * 1.05}" cy="${ey}" r="5" fill="${INK}" stroke="none"/>`;
  }
  const nx = cx + dx * 1.35;
  if (Math.abs(yaw) > 55) {
    const edge = cx - Math.sign(yaw) * rx;
    s += `<path d="M${edge + Math.sign(yaw) * 2},${ey + 6} L${edge - Math.sign(yaw) * 8},${ey + 20} L${edge + Math.sign(yaw) * 2},${ey + 24}" fill="${SKIN}"/>`;
  } else {
    s += `<path d="M${nx},${ey + 10} L${nx - 3 * Math.sign(-yaw || 1)},${ey + 20}"/>`;
  }
  s += `<path d="M${cx + dx * 1.1 - 12 * cyw},${ey + 34} Q${cx + dx * 1.1},${ey + 40} ${cx + dx * 1.1 + 12 * cyw},${ey + 34}"/>`;
  return s;
}

function turnArrow(dir, y = 18) {
  // dir: +1 = 左へ、-1 = 右へ
  const x0 = 100 + dir * 18, x1 = 100 - dir * 62;
  return `<path d="M${x0},${y + 4} Q100,${y - 10} ${x1},${y + 10}" stroke="${ACC}" stroke-width="6"/>` + arrowHead(x1, y + 10, dir > 0 ? 160 : 20);
}

const FACE = {
  front: () => svg(head() + label("正面・真顔")),
  hairup: () => svg(head({ hairup: true }) + `<path d="M100,40 L100,12" stroke="${ACC}" stroke-width="6"/>` + arrowHead(100, 12, -90) + label("前髪を上げる")),
  yaw: (deg) => svg(head({ yaw: deg }) + turnArrow(Math.sign(deg)) + label(`${deg > 0 ? "左" : "右"} ${Math.abs(deg)}°`)),
  pitch: (deg) => svg(head({ pitch: deg }) + `<path d="M172,${deg > 0 ? 120 : 60} L172,${deg > 0 ? 50 : 130}" stroke="${ACC}" stroke-width="6"/>` + arrowHead(172, deg > 0 ? 50 : 130, deg > 0 ? -90 : 90) + label(deg > 0 ? "少し上" : "少し下")),
  sweep: () => svg(head() + `<path d="M40,22 Q100,0 160,22" stroke="${ACC}" stroke-width="6"/>` + arrowHead(160, 22, 20) + arrowHead(40, 22, 160) + label("左右に 2 往復")),
  closeup: () => svg(`<circle cx="92" cy="92" r="62" fill="${SKIN}"/><path d="M58,92 Q72,78 86,92 Q72,104 58,92 Z" fill="#fff"/><circle cx="72" cy="91" r="7" fill="${INK}" stroke="none"/><path d="M100,92 Q114,78 128,92 Q114,104 100,92 Z" fill="#fff"/><circle cx="114" cy="91" r="7" fill="${INK}" stroke="none"/><circle cx="92" cy="92" r="62"/><path d="M138,138 L176,176" stroke-width="12"/>` + label("近づいて目を大きく", 196, 19)),
  back: () => svg(head({ back: true }) + `<path d="M30,150 Q100,182 170,150" stroke="${ACC}" stroke-width="6"/>` + arrowHead(170, 150, -25) + label("後ろを向く")),
};

// ------------------------------------------------------------ 表情
function eye(kind, x, y) {
  switch (kind) {
    case "smile": return `<path d="M${x - 12},${y + 3} Q${x},${y - 10} ${x + 12},${y + 3}" stroke-width="6"/>`;
    case "closed": return `<path d="M${x - 12},${y} Q${x},${y + 6} ${x + 12},${y}" stroke-width="6"/>`;
    case "half": return `<circle cx="${x}" cy="${y + 2}" r="8" fill="${INK}" stroke="none"/><rect x="${x - 13}" y="${y - 10}" width="26" height="11" fill="${SKIN}" stroke="none"/><path d="M${x - 13},${y + 1} L${x + 13},${y + 1}" stroke-width="5"/>`;
    case "wide": return `<circle cx="${x}" cy="${y}" r="11" fill="#fff"/><circle cx="${x}" cy="${y}" r="5" fill="${INK}" stroke="none"/>`;
    case "sharp": return `<path d="M${x - 12},${y - 2} L${x + 12},${y + 3}" stroke-width="5"/><circle cx="${x}" cy="${y + 5}" r="6" fill="${INK}" stroke="none"/>`;
    default: return `<circle cx="${x}" cy="${y}" r="7" fill="${INK}" stroke="none"/>`;
  }
}
function brow(kind, x, y, side) {
  // side: -1 = 画面左の眉、+1 = 画面右の眉
  const inner = x - side * 12, outer = x + side * 12;
  switch (kind) {
    case "angry": return `<path d="M${outer},${y - 6} L${inner},${y + 4}" stroke-width="6"/>`;
    case "troubled": return `<path d="M${outer},${y + 4} L${inner},${y - 6}" stroke-width="6"/>`;
    case "up": return `<path d="M${outer},${y - 6} Q${x},${y - 14} ${inner},${y - 6}" stroke-width="6"/>`;
    default: return `<path d="M${outer},${y} Q${x},${y - 6} ${inner},${y}" stroke-width="6"/>`;
  }
}
function mouth(kind, x, y) {
  switch (kind) {
    case "smile": return `<path d="M${x - 18},${y - 2} Q${x},${y + 14} ${x + 18},${y - 2}" stroke-width="6"/>`;
    case "grin": return `<path d="M${x - 24},${y - 6} L${x + 24},${y - 6} Q${x + 22},${y + 20} ${x},${y + 20} Q${x - 22},${y + 20} ${x - 24},${y - 6} Z" fill="#fff"/><path d="M${x - 22},${y + 2} L${x + 22},${y + 2}" stroke-width="3"/>`;
    case "o": return `<ellipse cx="${x}" cy="${y + 6}" rx="13" ry="16" fill="${ACC}" fill-opacity=".35"/>`;
    case "a": return `<path d="M${x - 20},${y - 4} Q${x},${y - 8} ${x + 20},${y - 4} Q${x + 18},${y + 28} ${x},${y + 28} Q${x - 18},${y + 28} ${x - 20},${y - 4} Z" fill="${ACC}" fill-opacity=".35"/>`;
    case "i": return `<rect x="${x - 22}" y="${y - 4}" width="44" height="12" rx="6" fill="#fff"/>`;
    case "u": return `<ellipse cx="${x}" cy="${y + 4}" rx="7" ry="8" fill="${ACC}" fill-opacity=".35"/>`;
    case "e": return `<ellipse cx="${x}" cy="${y + 4}" rx="18" ry="10" fill="${ACC}" fill-opacity=".35"/>`;
    case "oo": return `<ellipse cx="${x}" cy="${y + 6}" rx="12" ry="13" fill="${ACC}" fill-opacity=".35"/>`;
    case "frown": return `<path d="M${x - 16},${y + 8} Q${x},${y - 4} ${x + 16},${y + 8}" stroke-width="6"/>`;
    case "angry": return `<path d="M${x - 16},${y + 6} Q${x},${y} ${x + 16},${y + 6}" stroke-width="6"/>`;
    case "smirk": return `<path d="M${x - 16},${y + 4} Q${x + 4},${y + 8} ${x + 18},${y - 6}" stroke-width="6"/>`;
    case "wobble": return `<path d="M${x - 16},${y + 4} q5,-6 10,0 q5,6 10,0 q5,-6 10,0" stroke-width="5"/>`;
    default: return `<path d="M${x - 14},${y + 2} L${x + 14},${y + 2}" stroke-width="6"/>`;
  }
}
function faceExpr({ eyes = ["open", "open"], brows = "neutral", mouthKind = "line", blush = false, sweat = false, tilt = 0, text = "", extra = "" }) {
  const cx = 100, cy = 92;
  let s = `<g transform="rotate(${tilt} 100 100)">`;
  s += `<ellipse cx="${cx}" cy="${cy}" rx="58" ry="66" fill="${SKIN}"/>`;
  s += `<path d="M42,96 A58,66 0 0 1 158,96 C150,62 118,50 100,62 C82,50 50,62 42,96 Z" fill="${HAIR}"/>`;
  s += brow(brows === "smug" ? "neutral" : brows, 76, 76, -1) + brow(brows === "smug" ? "up" : brows, 124, 76, 1);
  s += eye(eyes[0], 76, 98) + eye(eyes[1], 124, 98);
  if (blush) s += `<ellipse cx="66" cy="120" rx="12" ry="6" fill="${ACC}" fill-opacity=".35" stroke="none"/><ellipse cx="134" cy="120" rx="12" ry="6" fill="${ACC}" fill-opacity=".35" stroke="none"/>`;
  if (sweat) s += `<path d="M160,62 Q168,78 160,84 Q152,78 160,62 Z" fill="#8fd0ff" stroke="#4aa3d8" stroke-width="3"/>`;
  s += mouth(mouthKind, 100, 128);
  s += `</g>` + extra;
  return svg(s + (text ? label(text) : ""));
}

const EXPR = {
  neutral: () => faceExpr({ text: "真顔" }),
  grin: () => faceExpr({ eyes: ["smile", "smile"], mouthKind: "grin", text: "歯を見せて笑う" }),
  smile: () => faceExpr({ eyes: ["smile", "smile"], mouthKind: "smile", text: "口を閉じて微笑む" }),
  surprised: () => faceExpr({ eyes: ["wide", "wide"], brows: "up", mouthKind: "o", text: "驚き" }),
  angry: () => faceExpr({ eyes: ["sharp", "sharp"], brows: "angry", mouthKind: "angry", text: "怒り（眉を寄せる）" }),
  troubled: () => faceExpr({ brows: "troubled", mouthKind: "wobble", sweat: true, text: "困り（眉を八の字）" }),
  shy: () => faceExpr({ eyes: ["smile", "smile"], mouthKind: "smile", blush: true, tilt: 8, text: "照れ" }),
  jito: () => faceExpr({ eyes: ["half", "half"], mouthKind: "line", text: "ジト目" }),
  smug: () => faceExpr({ eyes: ["half", "open"], brows: "smug", mouthKind: "smirk", tilt: -6, text: "ドヤ顔" }),
  wink1: () => faceExpr({ eyes: ["open", "smile"], mouthKind: "smile", text: "ウインク" }),
  wink2: () => faceExpr({ eyes: ["smile", "open"], mouthKind: "smile", text: "反対の目でウインク" }),
  closed: () => faceExpr({ eyes: ["closed", "closed"], mouthKind: "line", text: "目を閉じる" }),
  a: () => faceExpr({ mouthKind: "a", text: "「あ」" }),
  i: () => faceExpr({ mouthKind: "i", text: "「い」" }),
  u: () => faceExpr({ mouthKind: "u", text: "「う」" }),
  e: () => faceExpr({ mouthKind: "e", text: "「え」" }),
  o: () => faceExpr({ mouthKind: "oo", text: "「お」" }),
  talk: () => faceExpr({ mouthKind: "e", text: "20 秒しゃべる", extra: `<path d="M150,30 h40 a8,8 0 0 1 8,8 v18 a8,8 0 0 1 -8,8 h-24 l-10,10 v-10 h-6 a8,8 0 0 1 -8,-8 v-18 a8,8 0 0 1 8,-8 z" fill="#fff" stroke="${ACC}" stroke-width="4"/><path d="M158,46 h28 M158,54 h18" stroke="${ACC}" stroke-width="4"/>` }),
};

// ------------------------------------------------------------ 手
// ext: [親指, 人差し指, 中指, 薬指, 小指] が伸びているか
function hand(ext, { nails = false, palmLines = false, mirror = false, scale = 1, tx = 0, ty = 0 } = {}) {
  const xs = [78, 98, 118, 138];
  const lens = [58, 64, 58, 46];
  let s = "";
  if (ext[0]) s += `<rect x="50" y="104" width="20" height="58" rx="10" fill="${SKIN}" transform="rotate(-30 68 156)"/>`;
  s += `<rect x="66" y="98" width="84" height="74" rx="22" fill="${SKIN}"/>`;
  for (let i = 0; i < 4; i++) {
    const x = xs[i], up = ext[i + 1];
    const h = up ? lens[i] : 16;
    const y = 104 - h;
    s += `<rect x="${x - 9}" y="${y}" width="18" height="${h + 10}" rx="9" fill="${SKIN}"/>`;
    if (nails && up) s += `<rect x="${x - 6}" y="${y + 3}" width="12" height="13" rx="5" fill="${INK}" stroke="none"/>`;
    if (!up) s += `<path d="M${x - 8},${y + 12} Q${x},${y + 18} ${x + 8},${y + 12}" stroke-width="3"/>`;
  }
  if (!ext[0]) s += `<rect x="70" y="112" width="52" height="18" rx="9" fill="${SKIN}"/>`;
  if (palmLines) s += `<path d="M78,132 Q104,124 140,136 M80,148 Q102,142 124,156" stroke-width="3" opacity=".6"/>`;
  const tf = `translate(${tx} ${ty}) ${mirror ? "translate(200 0) scale(-1 1)" : ""} translate(100 100) scale(${scale}) translate(-100 -100)`;
  return `<g transform="${tf}">${s}</g>`;
}

const HAND = {
  back: (side) => svg(hand([1, 1, 1, 1, 1], { nails: true, mirror: side !== "L", ty: -6 })),
  palm: (side) => svg(hand([1, 1, 1, 1, 1], { palmLines: true, mirror: side === "L", ty: -6 })),
  peace: () => svg(hand([0, 1, 1, 0, 0], { nails: true, ty: -6 })),
  point: () => svg(hand([0, 1, 0, 0, 0], { nails: true, ty: -6 })),
  fist: () => svg(hand([0, 0, 0, 0, 0], { nails: true, ty: -6 })),
  free: () => svg(hand([1, 1, 1, 1, 1], { nails: true, scale: 0.62, tx: -44, ty: -6 }) + hand([0, 1, 1, 0, 0], { nails: true, scale: 0.62, tx: 44, ty: -6, mirror: true }) +
    `<path d="M20,40 q-8,14 0,28 M180,40 q8,14 0,28" stroke="${ACC}" stroke-width="5"/>`),
};

// ------------------------------------------------------------ 全身（ピクトグラムの人）
function person({ arms = [45, 45], width = 1, back = false, side = false, legs = 10, raise = null, turnArrow: ta = false } = {}) {
  const sw = 26 * width;
  let s = "";
  const hx = 100, hy = 34;
  s += `<circle cx="${hx}" cy="${hy}" r="17" fill="${back ? HAIR : SKIN}" stroke-width="5"/>`;
  if (side) s += `<path d="M${hx + 16},${hy - 2} l8,6 l-8,4" fill="${SKIN}"/>`;
  s += `<path d="M${100 - sw},64 L${100 + sw},64 L${100 + sw * 0.8},118 L${100 - sw * 0.8},118 Z" fill="${INK}" stroke-width="6"/>`;
  const limb = (x1, y1, x2, y2) => `<path d="M${x1},${y1} L${x2},${y2}" stroke-width="13"/>`;
  const arm = (sx, dir, angDeg, len = 52) => {
    const a = rad(angDeg);
    return limb(sx, 70, sx + dir * Math.sin(a) * len, 70 + Math.cos(a) * len);
  };
  if (!side) {
    s += raise === "L" ? limb(100 - sw, 70, 100 - sw - 14, 22) + `<path d="M${100 - sw - 20},10 l4,12 M${100 - sw - 10},8 l-2,13" stroke="${ACC}" stroke-width="5"/>` : arm(100 - sw, -1, arms[0]);
    s += arm(100 + sw, 1, arms[1]);
  } else {
    s += arm(100, 1, 8);
  }
  s += limb(100 - (side ? 2 : legs), 120, 100 - (side ? 4 : legs + 6), 186);
  s += limb(100 + (side ? 2 : legs), 120, 100 + (side ? 4 : legs + 6), 186);
  if (ta) s += `<ellipse cx="100" cy="186" rx="52" ry="10" stroke="${ACC}" stroke-width="5"/>` + arrowHead(150, 189, 200);
  return s;
}

const BODY = {
  front: () => svg(person()),
  q45: () => svg(person({ width: 0.7, arms: [30, 40] }) + `<path d="M50,196 Q100,176 150,196" stroke="${ACC}" stroke-width="5"/>` + arrowHead(50, 196, 160)),
  side: () => svg(person({ side: true })),
  back: () => svg(person({ back: true })),
  natural: () => svg(person({ arms: [12, 18], legs: 8 })),
  peace: () => svg(person({ raise: "L", arms: [45, 20] })),
  turn: () => svg(person({ arms: [20, 20], turnArrow: true })),
};

export function picto(key) {
  const [group, a, b] = (key || "").split(":");
  try {
    if (group === "face") {
      if (a === "yaw") return FACE.yaw(Number(b));
      if (a === "pitch") return FACE.pitch(Number(b));
      return (FACE[a] || FACE.front)();
    }
    if (group === "expr") return (EXPR[a] || EXPR.neutral)();
    if (group === "hand") return (HAND[a] || HAND.back)(b);
    if (group === "body") return (BODY[a] || BODY.front)();
  } catch (e) {
    console.warn("picto", key, e);
  }
  return svg("");
}
