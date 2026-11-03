// 기상청 단기예보·초단기예보·초단기실황을 받아 kma.json으로 저장한다.
// GitHub Actions가 1시간마다 실행하고, 인증키는 저장소 Secret(KMA_KEY)에서만 읽는다.
// 실패해도 멈추지 않는다: 직전에 배포된 kma.json을 그대로 다시 쓰고 errors에 이유를 남긴다.
import { writeFile } from 'node:fs/promises';

const NX = 60, NY = 121;   // 수원 장안구 천천동 격자 (위도 37.297, 경도 126.972)
const API = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const LIVE = 'https://chpilkuy.github.io/weather/kma.json';

let key = (process.env.KMA_KEY || '').trim();
if (key.includes('%')) key = decodeURIComponent(key);   // Encoding 키를 넣어도 동작하게

// 한국시간 기준 시각 (Date의 UTC 필드를 KST 값으로 쓴다)
const kstAgo = min => new Date(Date.now() + 9 * 3600e3 - min * 60e3);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const two = n => String(n).padStart(2, '0');

// 단기예보: 02·05·08·11·14·17·20·23시 발표, 10분쯤 뒤부터 제공
function vilageBase(){
  const t = kstAgo(15), h = t.getUTCHours();
  const s = [2, 5, 8, 11, 14, 17, 20, 23].filter(x => x <= h).pop();
  if (s === undefined) return [ymd(kstAgo(15 + 60 * (h + 1))), '2300'];
  return [ymd(t), `${two(s)}00`];
}
// 초단기실황: 매시 정각 자료, 40분쯤 뒤부터 제공
const ncstBase = () => { const t = kstAgo(45); return [ymd(t), `${two(t.getUTCHours())}00`]; };
// 초단기예보: 매시 30분 발표, 45분쯤 뒤부터 제공
const ultraBase = () => { const t = kstAgo(50); return [ymd(t), `${two(t.getUTCHours())}30`]; };

async function call(op, [date, time]){
  const url = `${API}/${op}?serviceKey=${encodeURIComponent(key)}&pageNo=1&numOfRows=2000&dataType=JSON&base_date=${date}&base_time=${time}&nx=${NX}&ny=${NY}`;
  const res = await fetch(url);
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`${op} ${res.status}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`); }
  const head = j.response && j.response.header;
  if (!head || head.resultCode !== '00') throw new Error(`${op}: ${head ? `${head.resultCode} ${head.resultMsg}` : '응답 형식 다름'}`);
  return j.response.body.items.item;
}

// "강수없음" → 0, "1mm 미만" → 0.5, "1.0mm" → 1, "30.0~50.0mm" → 30
function mm(v){
  if (v == null) return null;
  const s = String(v);
  if (s.includes('없음')) return 0;
  if (s.includes('미만')) return 0.5;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const slot = (d, t) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:00`;

const out = { updated: new Date().toISOString(), nx: NX, ny: NY, errors: [], hours: {}, days: {} };

if (!key) out.errors.push('KMA_KEY Secret이 비어 있어요');
else {
  // 1) 단기예보: 앞으로 며칠의 1시간 간격 예보
  try {
    const b = vilageBase();
    const items = await call('getVilageFcst', b);
    out.vilageBase = b.join(' ');
    for (const it of items){
      const k = slot(it.fcstDate, it.fcstTime), h = out.hours[k] ||= {};
      const v = it.fcstValue;
      switch (it.category){
        case 'TMP': h.tmp = num(v); break;
        case 'POP': h.pop = num(v); break;
        case 'PCP': h.pcp = mm(v); break;
        case 'SKY': h.sky = num(v); break;
        case 'PTY': h.pty = num(v); break;
        case 'REH': h.reh = num(v); break;
        case 'WSD': h.wsd = num(v); break;
        case 'TMN': (out.days[k.slice(0, 10)] ||= {}).tmn = num(v); break;
        case 'TMX': (out.days[k.slice(0, 10)] ||= {}).tmx = num(v); break;
      }
    }
  } catch (e){ out.errors.push(e.message); }

  // 2) 초단기예보: 앞으로 6시간은 더 촘촘한 예보로 덮어쓴다 (강수확률은 단기예보 값을 유지)
  try {
    const b = ultraBase();
    const items = await call('getUltraSrtFcst', b);
    out.ultraBase = b.join(' ');
    for (const it of items){
      const k = slot(it.fcstDate, it.fcstTime), h = out.hours[k] ||= {};
      const v = it.fcstValue;
      switch (it.category){
        case 'T1H': h.tmp = num(v); break;
        case 'RN1': h.pcp = mm(v); break;
        case 'SKY': h.sky = num(v); break;
        case 'PTY': h.pty = num(v); break;
        case 'REH': h.reh = num(v); break;
        case 'WSD': h.wsd = num(v); break;
      }
    }
  } catch (e){ out.errors.push(e.message); }

  // 3) 초단기실황: 지금 실제로 관측된 값
  try {
    const b = ncstBase();
    const items = await call('getUltraSrtNcst', b);
    out.now = { base: b.join(' ') };
    for (const it of items){
      const v = it.obsrValue;
      if (it.category === 'T1H') out.now.tmp = num(v);
      if (it.category === 'RN1') out.now.rn1 = mm(v);
      if (it.category === 'PTY') out.now.pty = num(v);
      if (it.category === 'REH') out.now.reh = num(v);
      if (it.category === 'WSD') out.now.wsd = num(v);
    }
  } catch (e){ out.errors.push(e.message); }
}

// 단기예보를 못 받았으면 직전에 배포된 값을 이어서 쓴다 (페이지가 오래된 정도를 보고 판단)
if (!out.vilageBase){
  try {
    const prev = await (await fetch(LIVE)).json();
    if (prev && prev.vilageBase){
      out.hours = prev.hours; out.days = prev.days; out.vilageBase = prev.vilageBase;
      out.fallbackFrom = prev.updated;
      if (!out.now && prev.now) out.now = prev.now;
    }
  } catch {}
}

await writeFile('kma.json', JSON.stringify(out));
console.log(`단기예보 ${out.vilageBase || '없음'} · 초단기예보 ${out.ultraBase || '없음'} · 실황 ${out.now ? out.now.base : '없음'} · 시간 ${Object.keys(out.hours).length}개`);
if (out.errors.length) console.log('오류:', out.errors.join(' | '));
