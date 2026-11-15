// 撮影の手順。
// check(m, S) が true の状態が hold ミリ秒続くと自動で撮る。合わないまま timeout を過ぎたら、カウントダウンしてそのまま撮る。
// m: その瞬間の計測（face / hands / pose）。S: セッション（S.base に正面で測った基準値が入る）。
// 向きの符号は「+ = 本人から見て左」。
// 顔の大きさ（size）は、顔の幅を映像の短い辺で割った値（縦でも横でも同じ目安になる）。
// 画面用：picto = お手本の絵（pictos.js）、gauge = 角度メーター、meter = 表情などの強さのバー、guide = カメラ映像に重ねる枠。

const avg = (bs, k) => ((bs[k + "Left"] ?? 0) + (bs[k + "Right"] ?? 0)) / 2;
const one = (bs, k) => bs[k] ?? 0;
const F = (m) => (m.face && m.face.found ? m.face : null);
const P = (m) => (m.pose && m.pose.found ? m.pose : null);
const n2 = (v) => (Math.round(v * 100) / 100).toFixed(2);

export const dirDeg = (v) => (Math.abs(v) < 2 ? "正面" : `${v > 0 ? "左" : "右"} ${Math.round(Math.abs(v))}°`);

function noFace() { return "顔が見つかりません。カメラの方へ"; }

function yawHint(m, target, tol) {
  const f = F(m);
  if (!f) return noFace();
  const d = target - f.yaw;
  if (Math.abs(d) <= tol) return "そのまま…";
  return d > 0 ? "もう少し左へ" : "もう少し右へ";
}

const front = (f, tol = 7, ptol = 10) => Math.abs(f.yaw) < tol && Math.abs(f.pitch) < ptol;
const calm = (f) => avg(f.bs, "mouthSmile") < 0.3 && one(f.bs, "jawOpen") < 0.1 && avg(f.bs, "eyeBlink") < 0.4;

function frontHint(m) {
  const f = F(m);
  if (!f) return noFace();
  if (Math.abs(f.yaw) >= 7) return `顔を正面へ（いま ${dirDeg(f.yaw)}）`;
  if (Math.abs(f.pitch) >= 10) return f.pitch > 0 ? "あごを少し引いて" : "あごを少し上げて";
  return "";
}

// 表情のステップ：meter の値が lo〜hi に入り、顔がほぼ正面なら OK
function expr(id, title, say, picto, label, value, lo, hi, extra = {}) {
  const test = extra.test || ((bs, f, S) => { const v = value(bs, f, S); return v >= lo && v <= hi; });
  return {
    id, phase: "expr", need: ["face"], title, say, picto: `expr:${picto}`, prep: extra.prep ?? 1500, hold: extra.hold ?? 350, guide: "face",
    check: (m, S) => { const f = F(m); return !!f && Math.abs(f.yaw) < 15 && test(f.bs, f, S); },
    hint: (m, S) => {
      const f = F(m);
      if (!f) return noFace();
      if (Math.abs(f.yaw) >= 15) return "顔を正面へ";
      return extra.hintText || "";
    },
    meter: { label, value: (m, S) => (F(m) ? value(m.face.bs, m.face, S) : 0), lo, hi },
    ...extra.more,
  };
}

const handReady = (m) => m.hands.length === 1 && m.hands[0].inFrame;
const GESTURE_JA = { open: "パー", fist: "グー", peace: "ピース", point: "指さし" };

function handHint(m) {
  if (m.hands.length === 0) return "手が見つかりません。カメラの前に手を出して";
  if (m.hands.length > 1) return "片手だけ出してください";
  if (!m.hands[0].inFrame) return "手の全体が画面に入るように";
  return "";
}

function handStep(id, title, say, picto, gesture, extra = {}) {
  return {
    id, phase: "hands", need: ["hands"], title, say, picto: `hand:${picto}`, prep: extra.prep ?? 2000, hold: extra.hold ?? 500, guide: "hand",
    check: (m) => handReady(m) && m.hands[0].gesture === gesture,
    hint: handHint,
    gesture: { want: gesture, wantName: GESTURE_JA[gesture] },
  };
}

function bodyHint(m) {
  const p = P(m);
  if (!p) return "体が見つかりません。スマホから 2〜3m 離れて";
  if (!p.full) return p.missing ? `${p.missing}が画面に入っていません。少し下がって` : "全身が画面に入るように";
  return "";
}

function relWidth(p, S) { return S.base.bodyW ? p.width / S.base.bodyW : 1; }

export const PHASES = [
  {
    id: "face", name: "顔と髪", place: "座って、スマホを顔から 40〜60cm に", minutes: 3, picto: "face:front",
    tip: "スマホは机などに立てかけるか、腕をのばして持ちます。横や後ろを向くときは画面が見えないので、声の案内を聞いてください。",
    intro: "まずは顔と髪です。いすに座って、スマホを顔から 50 センチくらい離してください。画面の点線の楕円に顔を合わせます。",
  },
  {
    id: "expr", name: "表情", place: "座ったまま、正面", minutes: 3, picto: "expr:grin",
    tip: "メーターが目標の線を越えると撮れます。大げさなくらいがちょうどよいです。",
    intro: "次は表情です。正面を向いたまま、言われた表情をしてください。メーターが目標の線を越えると撮れます。",
  },
  {
    id: "hands", name: "手", place: "スマホを立てかけて、手をカメラの前に", minutes: 2, picto: "hand:back:R",
    tip: "両手を使うので、スマホは立てかけておくと楽です。",
    intro: "次は手です。スマホを立てかけて、手をカメラの前に出してください。点線の四角に、手の全体が入るようにします。",
  },
  {
    id: "body", name: "全身", place: "スマホを立てかけ、2〜3m 離れて立つ", minutes: 3, picto: "body:front",
    tip: "スマホを腰くらいの高さに縦のまま立てかけます。だれかに持ってもらっても大丈夫です。",
    intro: "最後は全身です。スマホを縦のまま腰くらいの高さに立てかけて、2〜3 メートル下がってください。頭からつま先まで、点線の枠に入るように立ちます。",
  },
];

export const STEPS = [
  // ---------------- 顔と髪
  {
    id: "face_front", phase: "face", need: ["face"], title: "正面・真顔", picto: "face:front", guide: "face",
    say: "正面をまっすぐ見てください。口は閉じて、真顔で。",
    prep: 1500, hold: 600,
    gauge: { type: "yaw", target: 0, tol: 8 },
    // まだ基準がないので、上下は少しゆるく見る。ここで撮った顔の向きが以降の「正面」になる
    check: (m) => { const f = F(m); return !!f && front(f, 8, 15) && calm(f); },
    hint: (m) => { const f = F(m); if (!f) return noFace(); if (Math.abs(f.yaw) >= 8) return "顔を正面へ"; if (Math.abs(f.pitch) >= 15) return "カメラをまっすぐ見て"; return calm(f) ? "" : "真顔で、口を閉じて"; },
    onCapture: (m, S) => { const f = F(m); if (f) { S.base.offX = f.offX; S.base.ratioY = f.ratioY; S.base.faceSize = f.size; S.base.rawYaw = f.rawYaw; S.base.rawPitch = f.rawPitch; } },
  },
  {
    id: "face_front_hairup", phase: "face", need: ["face"], title: "前髪を上げて正面", picto: "face:hairup", guide: "face",
    say: "ピンかカチューシャで前髪を上げて、おでこと眉が見えるようにしてください。準備ができたら、正面を見て真顔で。",
    prep: 9000, hold: 700,
    gauge: { type: "yaw", target: 0, tol: 7 },
    // 両手で髪を押さえていると口が開きがちなので、真顔の判定はゆるめにする
    check: (m) => { const f = F(m); return !!f && front(f, 8, 12) && one(f.bs, "jawOpen") < 0.35; },
    hint: frontHint,
  },
  {
    id: "face_left45", phase: "face", need: ["face"], title: "左ななめ 45°", picto: "face:yaw:45", guide: "face",
    say: "前髪は戻して、いつもの髪型で。顔だけゆっくり左に向けて、ななめ45度で止めてください。",
    prep: 4000, hold: 500,
    gauge: { type: "yaw", target: 45, tol: 12 },
    check: (m) => { const f = F(m); return !!f && f.yaw > 33 && f.yaw < 57; },
    hint: (m) => yawHint(m, 45, 12),
  },
  {
    id: "face_right45", phase: "face", need: ["face"], title: "右ななめ 45°", picto: "face:yaw:-45", guide: "face",
    say: "今度は右に、ななめ45度。",
    prep: 1500, hold: 500,
    gauge: { type: "yaw", target: -45, tol: 12 },
    check: (m) => { const f = F(m); return !!f && f.yaw < -33 && f.yaw > -57; },
    hint: (m) => yawHint(m, -45, 12),
  },
  {
    id: "face_left90", phase: "face", need: ["face"], title: "左の真横", picto: "face:yaw:90", guide: "face",
    say: "左の真横を向いてください。肩はカメラに向けたまま、顔だけ真横へ。",
    prep: 2000, hold: 400, timeout: 8000,
    gauge: { type: "yaw", target: 80, tol: 18 },
    // 真横では顔の検出が外れやすいので、左に大きく向いたまま見失ったら真横とみなす
    check: (m, S) => { const f = F(m); return f ? f.yaw > 62 : (S.lastYaw > 40 && m.t - S.lastYawT < 1500); },
    hint: (m) => yawHint(m, 80, 15),
  },
  {
    id: "face_right90", phase: "face", need: ["face"], title: "右の真横", picto: "face:yaw:-90", guide: "face",
    say: "右の真横を向いてください。",
    prep: 1500, hold: 400, timeout: 8000,
    gauge: { type: "yaw", target: -80, tol: 18 },
    check: (m, S) => { const f = F(m); return f ? f.yaw < -62 : (S.lastYaw < -40 && m.t - S.lastYawT < 1500); },
    hint: (m) => yawHint(m, -80, 15),
  },
  {
    id: "face_up", phase: "face", need: ["face"], title: "少し上を向く", picto: "face:pitch:20", guide: "face",
    say: "正面に戻って、あごを少し上げてください。",
    prep: 2000, hold: 500,
    gauge: { type: "pitch", target: 22, tol: 10 },
    check: (m) => { const f = F(m); return !!f && Math.abs(f.yaw) < 12 && f.pitch > 12 && f.pitch < 35; },
    hint: (m) => { const f = F(m); if (!f) return noFace(); return f.pitch > 12 ? "そのまま…" : "もう少しあごを上げて"; },
  },
  {
    id: "face_down", phase: "face", need: ["face"], title: "少し下を向く", picto: "face:pitch:-20", guide: "face",
    say: "今度は少し下を向いてください。",
    prep: 1500, hold: 500,
    gauge: { type: "pitch", target: -22, tol: 10 },
    check: (m) => { const f = F(m); return !!f && Math.abs(f.yaw) < 12 && f.pitch < -12 && f.pitch > -35; },
    hint: (m) => { const f = F(m); if (!f) return noFace(); return f.pitch < -12 ? "そのまま…" : "もう少し下を向いて"; },
  },
  {
    id: "face_sweep", phase: "face", need: ["face"], title: "首をゆっくり左右に（動画）", picto: "face:sweep", guide: "face",
    say: "動画を撮ります。合図のあと、正面から左の真横までゆっくり向いて、そのまま右の真横まで。これを2回くり返してください。",
    kind: "video", seconds: 14, prep: 1500, sweep: true,
    gauge: { type: "yaw", target: 0, tol: 90, sweep: true },
    record: (m) => (F(m) ? { t: m.t, yaw: m.face.yaw, pitch: m.face.pitch } : { t: m.t, lost: 1 }),
  },
  {
    id: "face_eyes", phase: "face", need: ["face"], title: "目のアップ", picto: "face:closeup", guide: "closeup",
    say: "スマホに顔を近づけて、画面いっぱいに顔が映るようにしてください。目をしっかり開けて正面。",
    prep: 3000, hold: 600,
    meter: { label: "顔の大きさ", value: (m) => (F(m) ? m.face.size : 0), lo: 0.6, hi: 1 },
    check: (m) => { const f = F(m); return !!f && f.size > 0.6 && front(f, 8) && avg(f.bs, "eyeBlink") < 0.3; },
    hint: (m) => { const f = F(m); if (!f) return noFace(); if (f.size <= 0.6) return "もっと近づいて"; return frontHint(m) || "目を開けて…"; },
  },
  {
    id: "hair_back", phase: "face", need: ["face"], title: "後ろ頭", picto: "face:back", guide: "face",
    say: "顔をスマホから50センチくらいに戻して、座ったまま後ろを向いてください。後ろ頭と襟足を見せます。",
    prep: 4000, hold: 900, timeout: 9000,
    check: (m) => !F(m),
    hint: (m) => (F(m) ? "後ろを向いてください" : "そのまま…"),
  },

  // ---------------- 表情
  expr("ex_smile_teeth", "いつもの笑顔（歯を見せる）", "正面を向いて、いつもの笑顔。歯を見せて、思いきり笑ってください。", "grin",
    "笑顔の強さ", (bs) => avg(bs, "mouthSmile"), 0.45, 1, { prep: 2500, hold: 400, test: (bs) => avg(bs, "mouthSmile") > 0.45 && (one(bs, "jawOpen") > 0.04 || avg(bs, "mouthUpperUp") > 0.15) }),
  expr("ex_smile_closed", "口を閉じて微笑む", "口を閉じて、にっこり微笑んでください。", "smile",
    "微笑み", (bs) => avg(bs, "mouthSmile"), 0.3, 1, { hold: 400, test: (bs) => avg(bs, "mouthSmile") > 0.3 && one(bs, "jawOpen") < 0.07, hintText: "口は閉じたまま" }),
  expr("ex_surprised", "驚き", "びっくりした顔。目を見開いて、口を開けて。", "surprised",
    "口の開き", (bs) => one(bs, "jawOpen"), 0.25, 1, { test: (bs) => one(bs, "jawOpen") > 0.25 && (avg(bs, "eyeWide") > 0.2 || one(bs, "browInnerUp") > 0.35), hintText: "目も見開いて" }),
  expr("ex_angry", "怒り", "怒った顔。眉をぎゅっと寄せてください。", "angry",
    "眉の寄せ", (bs) => avg(bs, "browDown"), 0.3, 1),
  expr("ex_troubled", "困り顔", "困った顔。眉を八の字にしてください。", "troubled",
    "八の字", (bs) => one(bs, "browInnerUp"), 0.35, 1, { test: (bs) => one(bs, "browInnerUp") > 0.35 && avg(bs, "mouthSmile") < 0.4 }),
  expr("ex_shy", "照れ", "照れた顔。少しうつむいて、はにかんでください。", "shy",
    "はにかみ", (bs) => avg(bs, "mouthSmile"), 0.15, 1, { hold: 400 }),
  expr("ex_jito", "ジト目", "ジト目。まぶたを半分くらい下ろして、じーっと見てください。", "jito",
    "まぶたの下がり", (bs) => avg(bs, "eyeBlink"), 0.3, 0.8, {
      hold: 400,
      test: (bs) => { const b = avg(bs, "eyeBlink"), d = Math.abs(one(bs, "eyeBlinkLeft") - one(bs, "eyeBlinkRight")); return ((b > 0.3 && b < 0.8) || avg(bs, "eyeSquint") > 0.35) && d < 0.3; },
    }),
  expr("ex_smug", "ドヤ顔", "ドヤ顔。あごを少し上げて、得意げに。", "smug",
    "口角", (bs) => avg(bs, "mouthSmile"), 0.2, 1, { hold: 400 }),
  expr("ex_wink1", "ウインク（得意な方）", "得意な方の目でウインクしてください。", "wink1",
    "片目の閉じ", (bs) => Math.abs(one(bs, "eyeBlinkLeft") - one(bs, "eyeBlinkRight")), 0.3, 1, {
      test: (bs) => Math.abs(one(bs, "eyeBlinkLeft") - one(bs, "eyeBlinkRight")) > 0.3 && Math.max(one(bs, "eyeBlinkLeft"), one(bs, "eyeBlinkRight")) > 0.45,
      more: { onCapture: (m, S) => { const f = F(m); if (f) S.ctx.winkSide = one(f.bs, "eyeBlinkLeft") > one(f.bs, "eyeBlinkRight") ? "L" : "R"; } },
    }),
  expr("ex_wink2", "ウインク（反対の目）", "今度は反対の目でウインク。", "wink2",
    "片目の閉じ", (bs) => Math.abs(one(bs, "eyeBlinkLeft") - one(bs, "eyeBlinkRight")), 0.3, 1, {
      hintText: "さっきと反対の目で",
      test: (bs, f, S) => {
        const l = one(bs, "eyeBlinkLeft"), r = one(bs, "eyeBlinkRight");
        if (Math.abs(l - r) < 0.3 || Math.max(l, r) < 0.45) return false;
        return !S.ctx.winkSide || (l > r ? "L" : "R") !== S.ctx.winkSide;
      },
    }),
  expr("ex_eyes_closed", "目を閉じる", "両目をやさしく閉じてください。「目を開けて」と声がするまでそのまま。", "closed",
    "目の閉じ", (bs) => Math.min(one(bs, "eyeBlinkLeft"), one(bs, "eyeBlinkRight")), 0.6, 1, { hold: 500, more: { doneSay: "撮れました。目を開けてください。" } }),
  expr("ex_a", "「あ」の口", "目を開けてください。口の形を撮ります。「あ」の口で止めてください。", "a",
    "口の開き", (bs) => one(bs, "jawOpen"), 0.38, 1, { prep: 2500, hold: 300 }),
  expr("ex_i", "「い」の口", "「い」の口。", "i",
    "口の横の広がり", (bs) => Math.max(avg(bs, "mouthStretch"), avg(bs, "mouthSmile")), 0.15, 1, {
      prep: 1000, hold: 300, test: (bs) => one(bs, "jawOpen") < 0.25 && (avg(bs, "mouthStretch") > 0.15 || avg(bs, "mouthSmile") > 0.25),
    }),
  expr("ex_u", "「う」の口", "「う」の口。", "u",
    "口のすぼめ", (bs) => Math.max(one(bs, "mouthPucker"), one(bs, "mouthFunnel")), 0.35, 1, {
      prep: 1000, hold: 300, test: (bs) => one(bs, "mouthPucker") > 0.35 || one(bs, "mouthFunnel") > 0.3,
    }),
  expr("ex_e", "「え」の口", "「え」の口。", "e",
    "口の開き", (bs) => one(bs, "jawOpen"), 0.12, 0.45, {
      prep: 1000, hold: 300, test: (bs) => one(bs, "jawOpen") > 0.12 && one(bs, "jawOpen") < 0.45 && (avg(bs, "mouthStretch") > 0.08 || avg(bs, "mouthSmile") > 0.12),
    }),
  expr("ex_o", "「お」の口", "「お」の口。", "o",
    "口の丸さ", (bs) => one(bs, "mouthFunnel"), 0.22, 1, {
      prep: 1000, hold: 300, test: (bs) => one(bs, "mouthFunnel") > 0.22 && one(bs, "jawOpen") > 0.15,
    }),
  {
    id: "talk", phase: "expr", need: ["face"], title: "しゃべっている顔（動画）", picto: "expr:talk", guide: "face",
    say: "動画を撮ります。合図のあと、20秒くらい自由にしゃべってください。自己紹介でも、今日あったことでも大丈夫です。声は録音しません。",
    kind: "video", seconds: 20, prep: 1500,
    record: (m) => (F(m) ? { t: m.t, bs: m.face.bsArr, yaw: m.face.yaw, pitch: m.face.pitch } : { t: m.t, lost: 1 }),
  },

  // ---------------- 手
  handStep("hand_right_back", "右手の甲", "右手をパーにして、手の甲をカメラに向けてください。", "back:R", "open", { prep: 2500, hold: 600 }),
  handStep("hand_right_palm", "右手のひら", "右手をひっくり返して、手のひらをカメラに向けてください。", "palm:R", "open", { prep: 2500, hold: 600 }),
  handStep("hand_left_back", "左手の甲", "左手に替えて、手の甲をカメラに向けてください。", "back:L", "open", { prep: 3000, hold: 600 }),
  handStep("hand_left_palm", "左手のひら", "左手をひっくり返して、手のひら。", "palm:L", "open", { prep: 2500, hold: 600 }),
  handStep("hand_peace", "ピース", "いつもの手で、ピース。", "peace", "peace", { hold: 400 }),
  handStep("hand_point", "指さし", "人差し指で指さし。", "point", "point", { prep: 1500, hold: 400 }),
  handStep("hand_fist", "グー", "グー。", "fist", "fist", { prep: 1200, hold: 400 }),
  {
    id: "hand_free", phase: "hands", need: ["hands"], title: "両手を自由に動かす（動画）", picto: "hand:free", guide: "hand",
    say: "動画を撮ります。合図のあと、両手を自由に動かしてください。グーとパー、ピース、手を振る、指を1本ずつ折る、など。",
    kind: "video", seconds: 14, prep: 1500,
    record: (m) => ({ t: m.t, hands: m.hands.map((h) => ({ label: h.label, gesture: h.gesture, lm: h.lmc })) }),
  },

  // ---------------- 全身
  {
    id: "body_front_a", phase: "body", need: ["pose"], title: "A ポーズ・正面", picto: "body:front", guide: "body",
    say: "腕を体から45度くらい開いて、つま先をそろえて、正面を向いて立ってください。",
    prep: 6000, hold: 800, timeout: 20000,
    body: true,
    check: (m) => { const p = P(m); return !!p && p.full && p.noseVis > 0.6 && p.armL > 22 && p.armL < 70 && p.armR > 22 && p.armR < 70; },
    hint: (m) => { const p = P(m); const h = bodyHint(m); if (h) return h; if (p.armL <= 22 || p.armR <= 22) return "腕をもう少し体から離して"; if (p.armL >= 70 || p.armR >= 70) return "腕を少し下げて（45°くらい）"; return "そのまま…"; },
    onCapture: (m, S) => { const p = P(m); if (p) S.base.bodyW = p.width; },
  },
  {
    id: "body_left45", phase: "body", need: ["pose"], title: "左ななめ 45°（全身）", picto: "body:q45", guide: "body",
    say: "そのままの姿勢で、体ごと左に45度回ってください。",
    prep: 2500, hold: 600, body: true,
    check: (m, S) => { const p = P(m); if (!p || !p.full || p.back) return false; const r = relWidth(p, S); return r > 0.5 && r < 0.85; },
    hint: (m, S) => bodyHint(m) || (relWidth(P(m), S) >= 0.85 ? "もう少し回って" : relWidth(P(m), S) <= 0.5 ? "回りすぎです。少し戻って" : "そのまま…"),
  },
  {
    id: "body_side", phase: "body", need: ["pose"], title: "真横（全身）", picto: "body:side", guide: "body",
    say: "さらに回って、真横を向いてください。",
    prep: 2000, hold: 600, body: true,
    check: (m, S) => { const p = P(m); return !!p && p.full && relWidth(p, S) < 0.5; },
    hint: (m, S) => bodyHint(m) || (relWidth(P(m), S) >= 0.5 ? "もう少し回って真横に" : "そのまま…"),
  },
  {
    id: "body_back", phase: "body", need: ["pose"], title: "後ろ（全身）", picto: "body:back", guide: "body",
    say: "さらに回って、カメラに背中を向けてください。",
    prep: 2500, hold: 600, timeout: 9000, body: true,
    // 判定モデルは後ろ向きでも鼻が「見える」と答えるので、左右の肩の並びが正面と逆になったかで見る
    check: (m, S) => { const p = P(m); return !!p && p.full && p.back && relWidth(p, S) > 0.6; },
    hint: (m) => bodyHint(m) || (P(m).back ? "そのまま…" : "背中をカメラに向けて"),
  },
  {
    id: "body_natural", phase: "body", need: ["pose"], title: "いつもの立ち方", picto: "body:natural", guide: "body",
    say: "正面に戻って、いつもの立ち方で、楽にしてください。",
    prep: 3500, hold: 800, body: true,
    check: (m) => { const p = P(m); return !!p && p.full && p.noseVis > 0.6; },
    hint: bodyHint,
  },
  {
    id: "body_peace", phase: "body", need: ["pose"], title: "全身でピース", picto: "body:peace", guide: "body",
    say: "全身でピース。好きなポーズで。",
    prep: 3500, hold: 800, body: true,
    check: (m) => { const p = P(m); return !!p && p.full && p.noseVis > 0.5; },
    hint: bodyHint,
  },
  {
    id: "body_turn", phase: "body", need: ["pose"], title: "その場で 1 周（動画）", picto: "body:turn", guide: "body",
    say: "動画を撮ります。合図のあと、その場でゆっくり1周回ってください。",
    kind: "video", seconds: 16, prep: 1500, body: true,
    record: (m) => (P(m) ? { t: m.t, lm: m.pose.lmc } : { t: m.t, lost: 1 }),
  },
];
