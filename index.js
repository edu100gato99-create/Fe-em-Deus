import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { io } from "socket.io-client";

/* ========= ENV ========= */
const TOKEN  = process.env.TELEGRAM_TOKEN;
const CHAT_ID = Number(process.env.CHAT_ID || 0);
const PORT = process.env.PORT || 3000;
if (!TOKEN || !CHAT_ID) { console.error("Faltam TELEGRAM_TOKEN/CHAT_ID"); process.exit(1); }

/* ========= HTTP mínimo (Render Web Service) ========= */
const app = express();
app.get("/", (req,res)=>res.send("OK - bot rodando"));
app.listen(PORT, ()=>console.log("🌐 HTTP on", PORT));

/* ========= Telegram ========= */
const bot = new TelegramBot(TOKEN, { polling: true });
bot.on("polling_error", e => console.log("polling_error:", e?.message || e));

let running = false;
const sent = [];
const AUTODELETE_SEC = 3600;
const keyboard = {
  reply_markup: {
    keyboard: [[{text:"▶️ Iniciar"},{text:"⏹ Parar"}],[{text:"🧹 Limpar"}]],
    resize_keyboard: true
  }
};
async function send(text) {
  try {
    const m = await bot.sendMessage(CHAT_ID, text, keyboard);
    sent.push({ id: m.message_id, ts: Math.floor(Date.now()/1000) });
  } catch (e) { console.log("send err:", e?.message || e); }
}
setInterval(()=>{
  const now = Math.floor(Date.now()/1000);
  for (let i=sent.length-1;i>=0;i--) {
    if (now - sent[i].ts >= AUTODELETE_SEC) {
      bot.deleteMessage(CHAT_ID, sent[i].id).catch(()=>{});
      sent.splice(i,1);
    }
  }
}, 30000);

bot.on("message", async (msg)=>{
  const t = (msg.text||"").trim();
  if (t === "/start") return bot.sendMessage(CHAT_ID, "🤖 Pronto! Use os botões abaixo.", keyboard);
  if (t === "▶️ Iniciar") { running = true;  return send("✅ Sinais INICIADOS"); }
  if (t === "⏹ Parar")   { running = false; return send("🛑 Sinais PARADOS"); }
  if (t === "🧹 Limpar") {
    for (const s of [...sent]) await bot.deleteMessage(CHAT_ID, s.id).catch(()=>{});
    sent.length = 0; return send("🧽 Limpeza concluída.");
  }
});

/* ========= Estratégia ========= */
const fortesSet = new Set([5,7,8,9,12]);
const HISTORY_MAX = 400;
const history = [];       // [{roll,color,ts}]
const pendingWhites = []; // {id, idx, hour, minute, completed, predictions[]}
const minutePredMap = new Map(); // minute -> Set(whiteIds)
let whiteSeq = 0;
const pad2 = n => n.toString().padStart(2,"0");

function combosFromFour(minute, nums) {
  const vals = nums.filter(n => n !== 0 && Number.isFinite(n));
  const out = [];
  const push = arr => out.push({
    label: `${minute}+${arr.join("+")}`,
    minute: (minute + arr.reduce((a,b)=>a+b,0)) % 60
  });
  for (let i=0;i<vals.length;i++) push([vals[i]]);
  for (let i=0;i<vals.length;i++) for (let j=i+1;j<vals.length;j++) push([vals[i], vals[j]]);
  for (let i=0;i<vals.length;i++) for (let j=i+1;j<vals.length;j++) for (let k=j+1;k<vals.length;k++) push([vals[i], vals[j], vals[k]]);
  if (vals.length === 4) push(vals);
  const seen = new Set();
  return out.filter(c => !seen.has(`${c.minute}:${c.label}`) && (seen.add(`${c.minute}:${c.label}`), true));
}
function strength(distance, minute) {
  const base = fortesSet.has(distance) ? "🔥 Forte" : "Sinal";
  const set = minutePredMap.get(minute);
  if (set && set.size >= 2) return "⚡ Muito Forte";
  return base;
}
function onTick(roll, color, at) {
  const ts = new Date(at || Date.now());
  history.unshift({ roll, color, ts });
  if (history.length > HISTORY_MAX) history.pop();

  // Completar janelas dos brancos pendentes
  for (const w of pendingWhites) {
    if (!w.completed) {
      const after1 = history[w.idx - 1];
      const after2 = history[w.idx - 2];
      if (after1 && after2) {
        w.completed = true;
        const before1 = history[w.idx + 1]?.roll ?? null;
        const before2 = history[w.idx + 2]?.roll ?? null;
        const win = [before2, before1, after1.roll, after2.roll].filter(x=>x!==null);
        w.pred = combosFromFour(w.minute, win);
        for (const p of w.pred) {
          if (!minutePredMap.has(p.minute)) minutePredMap.set(p.minute, new Set());
          minutePredMap.get(p.minute).add(w.id);
        }
      }
    }
  }

  // Validar minuto atual
  const mNow = ts.getMinutes();
  for (const w of pendingWhites) {
    if (!w.completed || !w.pred) continue;
    const hits = w.pred.filter(p => p.minute === mNow);
    if (hits.length) {
      const dist = w.idx;
      const labels = hits.map(h=>h.label).slice(0,6).join(" | ");
      const text =
        `⚪ Sinal Detectado\n`+
        `🕐 Branco às ${pad2(w.hour)}:${pad2(w.minute)}\n`+
        `🔢 Combinações: ${labels}\n`+
        `🎯 Minuto alvo: ${pad2(mNow)}\n`+
        `📏 Distância: ${dist} casas\n`+
        `⭐ Força: ${strength(dist,mNow)}`;
      if (running) send(text);
    }
  }

  // Novo branco
  if (roll === 0) {
    const h = ts.getHours(), m = ts.getMinutes();
    pendingWhites.push({ id: ++whiteSeq, idx: 0, hour: h, minute: m, completed: false, pred: [] });
    if (running) send(`⚪ Branco detectado ${pad2(h)}:${pad2(m)}. Montando (2 antes + 2 depois)…`);
  }

  // Reindex e limpa antigos
  for (const w of pendingWhites) w.idx++;
  while (pendingWhites.length && pendingWhites[0].idx > 200) {
    const old = pendingWhites.shift();
    if (old?.pred) for (const p of old.pred) {
      const set = minutePredMap.get(p.minute);
      if (set) { set.delete(old.id); if (!set.size) minutePredMap.delete(p.minute); }
    }
  }
}

/* ========= Conexão Socket.IO (sem lib externa) =========
   Tentamos múltiplos hosts conhecidos da Blaze. */
const HOSTS = [
  "https://api-v2.blaze.com",
  "https://api2.blaze.com",
  "https://api.blaze.com"
];
let socket = null, hostIdx = 0, ticks = 0;

function connect() {
  const base = HOSTS[hostIdx % HOSTS.length];
  console.log("🔌 Conectando:", base, "…");

  // Path padrão do "replication" da Blaze
  socket = io(base, {
    path: "/replication/socket.io/",
    transports: ["websocket"],
    reconnection: false,          // a gente mesmo gerencia fallback
    timeout: 10000
  });

  socket.on("connect", () => {
    console.log("✅ Conectado em", base);
  });

  // Evento emitido pelo backend da Blaze (nome usado pelas libs públicas)
  socket.on("double.tick", (msg) => {
    // Alguns backends mandam { roll, color, created_at } – tratamos defensivamente:
    const roll = Number(msg?.roll);
    const color = Number(msg?.color);
    const at = msg?.created_at || msg?.rolled_at || undefined;
    ticks++;
    if (ticks % 30 === 0) console.log("ticks:", ticks);
    if (Number.isFinite(roll)) onTick(roll, color, at);
  });

  // Alguns ambientes usam nome plural
  socket.on("doubles:tick", (msg) => {
    const roll = Number(msg?.roll);
    const color = Number(msg?.color);
    const at = msg?.created_at || msg?.rolled_at || undefined;
    ticks++;
    if (ticks % 30 === 0) console.log("ticks:", ticks);
    if (Number.isFinite(roll)) onTick(roll, color, at);
  });

  socket.on("connect_error", (err) => {
    console.log("⚠️ connect_error", err?.message || err);
    fallback();
  });
  socket.on("disconnect", (reason) => {
    console.log("🔌 disconnect:", reason);
    fallback();
  });
}

function fallback() {
  try { socket && socket.close(); } catch {}
  hostIdx++;
  const wait = Math.min(15000, 2000 * hostIdx);
  console.log(`⏳ Tentando próximo host em ${wait/1000}s…`);
  setTimeout(connect, wait);
}

connect();
send("🤖 Bot pronto. Use ▶️ Iniciar / ⏹ Parar / 🧹 Limpar").catch(()=>{});
