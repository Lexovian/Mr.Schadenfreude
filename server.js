const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Enable proxy support for Render / Cloudflare / Heroku

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6, // 1MB payload cap to prevent socket buffer exhaustion
});

// Health check endpoints for Cloud & Render keep-alive
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/ping', (req, res) => res.status(200).send('pong'));

// Security & Hardening Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// SECURITY & RATE LIMITING
// ─────────────────────────────────────────────
const MAX_ACTIVE_ROOMS = 200;
const ALLOWED_LANGUAGES = ['tr', 'en', 'ja', 'de', 'es', 'fr'];

const createRoomLimits = new Map(); // socket/IP -> timestamps[]
const chatLimits = new Map();       // socketId -> timestamps[]
const voteLimits = new Map();       // socketId -> timestamps[]
const cluePublishLimits = new Map();// socketId -> timestamps[]
const nightActionLimits = new Map();// socketId -> timestamps[]

function isRateLimited(map, key, maxEvents, windowMs) {
  const now = Date.now();
  const timestamps = map.get(key) || [];
  const validTimestamps = timestamps.filter(t => now - t < windowMs);
  if (validTimestamps.length >= maxEvents) {
    map.set(key, validTimestamps);
    return true;
  }
  validTimestamps.push(now);
  map.set(key, validTimestamps);
  return false;
}

// Abandoned & Idle Room Garbage Collector (Runs every 5 minutes)
setInterval(() => {
  const now = Date.now();

  // 1) Clean up abandoned rooms
  Object.keys(rooms).forEach(code => {
    const room = rooms[code];
    if (!room) return;
    const humanPlayers = room.players.filter(p => !p.isBot);
    const connectedHumans = humanPlayers.filter(p => !p.disconnected);

    // If room is completely empty of connected humans for > 10 minutes
    if (connectedHumans.length === 0) {
      if (!room.emptySince) {
        room.emptySince = now;
      } else if (now - room.emptySince > 10 * 60 * 1000) {
        clearTimer(room);
        delete rooms[code];
        console.log(`[GC] Cleaned abandoned room: ${code}`);
      }
    } else {
      delete room.emptySince;
    }
  });

  // 2) Purge stale rate limiter entries
  [createRoomLimits, chatLimits, voteLimits, cluePublishLimits, nightActionLimits].forEach(map => {
    for (const [key, timestamps] of map.entries()) {
      const active = timestamps.filter(t => now - t < 60000);
      if (active.length === 0) {
        map.delete(key);
      } else {
        map.set(key, active);
      }
    }
  });
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const PHASES = {
  LOBBY: 'lobby',
  NIGHT0: 'night0',
  NIGHT: 'night',
  DAWN: 'dawn',
  DAY: 'day',
  VOTE: 'vote',
  RESULT: 'result',
  ENDED: 'ended',
};

const ROLES = {
  SF: 'sf',
  KUKLA: 'kukla',
  MORTISYEN: 'mortisyen',
  RAHIBE: 'rahibe',
  SOVALYE: 'sovalye',
  MADMAN: 'madman',
  KOYLU: 'koylu',
};

const PHASE_DURATIONS = {
  night0: 45,
  night: 30,
  dawn: 8,
  day: 90,
  vote: 30,
  result: 6,
};

// MORTISYEN CLUE SYSTEM
// ─────────────────────────────────────────────
const CLUE_TEMPLATES = {
  tr: {
    night_two: [
      'Son nefesinde birinin adını mırıldandı — {A} mıydı, {B} miydi, bilinmiyor.',
      'Olay yerinde bulunan iplik lifi, {A} veya {B}’nin kıyafetini andırıyor.',
      'O gece {A} ile {B}’nin garip davrandığını fark eden biri var.',
      'Kurbanın bakışları sanki {A} ya da {B}’ye yönelmiş gibi donmuş kaldı.',
      '{A} veya {B}’ye ait olduğu düşünülen bir iz var — ama kesin söylemek güç.',
    ],
    night_one: [
      'Cesette {A}’ya işaret eden bir iz var — şüphe kesin değil.',
      'O gece {A}’yı olay yeri yakınında gören biri olduğu söyleniyor.',
    ],
    night_unknown: [
      'Ölüm belirsiz bir güç tarafından gerçekleşti. Net bir iz bulunamadı.',
      'Ceset incelendi — somut bir şüpheli bağlantısı kurulamadı.',
    ],
    lynch_innocent_two: [
      'Yanlış idam... {name} masumdu. Kukla hâlâ aramızda — belki {A}, belki {B}.',
      '{name}’in üzerinde gölge izi yok. {A} mı kukla, {B} mi? Mortisyen gözünü ayırmıyor.',
      'Bu idam hataydı. {name} masumdu. {A} veya {B} öyle görünmese de...',
    ],
    lynch_innocent_one: [
      '{name} masumdu. Kukla hâlâ serbest — Mortisyen notlarını güncelledi.',
      'Otopsi: {name} saf bir köylüydü. Gölge başkasının üzerine sinmiş.',
    ],
    lynch_kukla: [
      'Doğru idam! {name} gerçekten kuklaydı — ipuçları doğrulandı.',
      'İyi sezgi! {name} Mr. Schadenfreude’nin kuklasıydı. Gölge zinciri kırıldı.',
    ],
    madman_curse: [
      'Lanet izi: {name} Deli’nin gücüne maruz kaldı. Bu gece kukla aktifti.',
      'Otopsi: lanet bu geceye aitti. Kukla öldürdü.',
    ],
  },
  en: {
    night_two: [
      'In their last breath, they murmured a name — {A} or {B}, it\'s hard to tell.',
      'A fiber at the scene resembles fabric from {A}\'s or {B}\'s clothing.',
      'Someone noticed {A} or {B} acting oddly that night.',
      'The victim\'s gaze seemed frozen toward where {A} or {B} was standing.',
      'A trace possibly belonging to {A} or {B} was found — certainty is elusive.',
    ],
    night_one: [
      'A trace pointing toward {A} was found — though suspicion isn\'t certain.',
      'Someone claims to have seen {A} near the scene that night.',
    ],
    night_unknown: [
      'Death was caused by an unidentifiable force. No clear trace was found.',
      'Corpse examined — no definitive suspect link could be established.',
    ],
    lynch_innocent_two: [
      'Wrong execution... {name} was innocent. The puppet still walks — maybe {A}, maybe {B}.',
      'No shadow trace on {name}. Is it {A}? Is it {B}? The Undertaker watches closely.',
      'This execution was a mistake. {name} was innocent. {A} or {B}, perhaps...',
    ],
    lynch_innocent_one: [
      '{name} was innocent. The puppet is still free — Undertaker updated their notes.',
      'Autopsy: {name} was a pure villager. The shadow has moved on to another.',
    ],
    lynch_kukla: [
      'Correct execution! {name} was indeed the puppet — clues confirmed.',
      'Good instinct! {name} was Mr. Schadenfreude\'s puppet. The shadow chain is broken.',
    ],
    madman_curse: [
      'Curse trace: {name} was exposed to the Madman\'s power. The puppet was active tonight.',
      'Autopsy: the curse belongs to this night. The puppet killed.',
    ],
  },
  ja: {
    night_two: [
      '息絶える間際に名を呟いた — {A}か、それとも{B}か、定かではない。',
      '現場に残された繊維は、{A}か{B}の衣服と一致する。',
      'その夜、{A}または{B}が不審な動きをしていたとの証言がある。',
    ],
    night_one: [
      '死体には{A}を示唆する痕跡が残されていた。',
    ],
    night_unknown: [
      '死因は特定不能の闇の力。明確な痕跡は見つからなかった。',
    ],
    lynch_innocent_two: [
      '誤った処刑... {name}は無実だった。人形は潜んでいる — {A}か、{B}か。',
    ],
    lynch_innocent_one: [
      '{name}は無実だった。人形は依然として自由の身だ。',
    ],
    lynch_kukla: [
      '正しい処刑！ {name}はMr.シャーデンフロイデの人形だった。',
    ],
    madman_curse: [
      '呪いの痕跡：{name}は狂人の道連れとなった。',
    ],
  },
  de: {
    night_two: [
      'Mit letzter Kraft wurde ein Name gehaucht — {A} oder {B}, schwer zu sagen.',
      'Eine Faser am Tatort ähnelt dem Gewand von {A} oder {B}.',
    ],
    night_one: [
      'Eine Spur deutet auf {A} hin — Verdacht unbestätigt.',
    ],
    night_unknown: [
      'Todesursache unbekannt. Keine eindeutigen Spuren gefunden.',
    ],
    lynch_innocent_two: [
      'Fehlurteil... {name} war unschuldig. Die Puppe weilt noch unter uns — {A} oder {B}?',
    ],
    lynch_innocent_one: [
      '{name} war unschuldig. Die Puppe ist noch frei.',
    ],
    lynch_kukla: [
      'Gerechtes Urteil! {name} war die Marionette von Mr. Schadenfreude.',
    ],
    madman_curse: [
      'Fluchspur: {name} wurde vom Verrückten in den Tod gerissen.',
    ],
  },
  es: {
    night_two: [
      'En su último aliento murmuró un nombre — {A} o {B}, imposible saberlo.',
      'Una fibra en la escena coincide con las ropas de {A} o {B}.',
    ],
    night_one: [
      'Un rastro apunta hacia {A} — la sospecha no es definitiva.',
    ],
    night_unknown: [
      'Muerte causada por una fuerza sombría. Sin rastros concluyentes.',
    ],
    lynch_innocent_two: [
      '¡Ejecución errónea! {name} era inocente. La marioneta sigue libre — ¿{A} o {B}?',
    ],
    lynch_innocent_one: [
      '{name} era inocente. La marioneta aún camina entre nosotros.',
    ],
    lynch_kukla: [
      '¡Juicio certero! {name} era la marioneta de Mr. Schadenfreude.',
    ],
    madman_curse: [
      'Marca de maldición: {name} cayó presa del Demente.',
    ],
  },
  fr: {
    night_two: [
      'Dans un dernier souffle, un nom fut murmuré — {A} ou {B}, nul ne sait.',
      'Une fibre retrouvée rappelle les vêtements de {A} ou {B}.',
    ],
    night_one: [
      'Une trace suspecte pointe vers {A}.',
    ],
    night_unknown: [
      'Mort causée par une ombre mystérieuse. Aucun indice probant.',
    ],
    lynch_innocent_two: [
      'Erreur judiciaire... {name} était innocent. La marionnette rôde — {A} ou {B} ?',
    ],
    lynch_innocent_one: [
      '{name} était innocent. La marionnette est toujours parmi nous.',
    ],
    lynch_kukla: [
      'Justice est faite ! {name} était bien la marionnette de Mr. Schadenfreude.',
    ],
    madman_curse: [
      'Trace de malédiction : {name} a été emporté par le Fou.',
    ],
  },
};

const FORENSIC_TRACES = {
  tr: {
    fabrics: [
      'Ceset üzerinde ince ipek lifleri ve kül tozu tespit edildi.',
      'Kurbanın giysisinde paslı demir tozu ve kılıç kını sürtünme izi bulundu.',
      'Olay yerinde tapınak mumu isi ve solgun bir koku saptandı.',
      'Kurbanın tırnaklarında siyah kadife kumaş kalıntıları var.',
    ],
    behaviors: [
      'Kurban son anlarında soğukkanlı ve acele etmeyen adımlarla yaklaşan bir siluet hissetti.',
      'Olay yerinde tereddüt, ani bir geri çekilme ve fısıltılı mırıldanma izleri var.',
      'Katilin saldırı anında son derece sakin ve planlı hareket ettiği belirlendi.',
      'Kurbanın direnmeye fırsat bulamadığı, tanıdık birine güvenir gibi yaklaştığı sezildi.',
      'Gece boyunca katilin etrafta sinsi ve gölgeli hareketlerle dolaştığı saptandı.',
    ],
  },
  en: {
    fabrics: [
      'Fine silk fibers and ash powder were detected on the corpse.',
      'Rust-tinged iron dust and scabbard rub marks were found on clothing.',
      'Temple candle soot and a faint mystic fragrance were detected.',
      'Black velvet fabric residues were found under victim\'s fingernails.',
    ],
    behaviors: [
      'The victim sensed a silhouette approaching with cold, unhurried steps in their final moments.',
      'Traces of hesitation, a sudden recoil, and faint whispered murmurs linger at the scene.',
      'The killer acted with calculated stillness and methodical precision.',
      'The victim did not resist, suggesting they trusted the approaching figure.',
      'Stealthy, shadow-cloaked movements were traced through the area that night.',
    ],
  },
  ja: {
    fabrics: [
      '遺体から絹の繊維と微細な灰が検出された。',
      '衣服に錆びた鉄粉と鞘の擦れ跡が見つかった。',
      '現場から蝋燭の煤と微かな香煙が感知された。',
    ],
    behaviors: [
      '被害者は最期の瞬間、冷徹で躊躇のない足音を感じ取っていた。',
      '現場には一瞬の躊躇いと、微かな囁き声の残響が漂っている。',
      '犯人は極めて冷静沈着に、計画的な動作で行動していた。',
      '被害者に抵抗の痕跡はなく、知人を信じ切っていたかのように接近を許していた。',
    ],
  },
  de: {
    fabrics: [
      'Seidenfasern und Aschestaub auf der Leiche festgestellt.',
      'Rostiger Eisenstaub und Scheidenspuren an der Kleidung.',
      'Kerzenruß und ein feiner Duft am Tatort wahrgenommen.',
    ],
    behaviors: [
      'Das Opfer spürte in den letzten Momenten eine Gestalt mit kalten, ruhigen Schritten.',
      'Spuren von Zögern und leises Flüstern verbleiben am Tatort.',
      'Der Täter handelte mit kalkulierter Ruhe und methodischer Präzision.',
      'Keine Abwehrspuren — das Opfer schien der herantretenden Person vertraut zu haben.',
    ],
  },
  es: {
    fabrics: [
      'Se hallaron fibras de seda y polvo de ceniza en el cadáver.',
      'Polvo de hierro y marcas de vaina detectados en la ropa.',
      'Hollín de vela del templo y aroma sutil detectados en la escena.',
    ],
    behaviors: [
      'La víctima sintió una silueta acercándose con pasos fríos y sin prisa en sus últimos instantes.',
      'Quedan en la escena rastros de vacilación y susurros apagados.',
      'El asesino actuó con calma calculada y precisión metódica.',
      'La víctima no opuso resistencia, como si confiara plenamente en la figura que se acercaba.',
    ],
  },
  fr: {
    fabrics: [
      'Fibres de soie et poussière de cendre détectées sur le cadavre.',
      'Poussière de fer rouillé et traces de fourreau sur les vêtements.',
      'Suie de bougie du temple et léger parfum détectés sur place.',
    ],
    behaviors: [
      'La victime a perçu une silhouette approchant d\'un pas froid et mesuré dans ses derniers instants.',
      'Des traces d\'hésitation et de légers murmures flottent encore sur les lieux.',
      'Le meurtrier a agi avec un calme calculé et une précision méthodique.',
      'Aucune trace de lutte — la victime semblait faire confiance à la silhouette qui approchait.',
    ],
  },
};

const ROLE_ARCHETYPE_ITEMS = {
  tr: {
    sovalye: ['Kılıç Çeliği ve Zırh Parçası', 'Deri Eldiven Kalıntısı', 'Kılıç Yağı ve Demir Tozu'],
    rahibe: ['Kutsal Balmumu Damlası', 'Tütsü Külü', 'Tespih Tanesi'],
    mortisyen: ['Neşter Çiziği', 'Formalin Kokusu', 'Cam Flakon Kırığı'],
    madman: ['Tebeşir Tozu', 'Lanet Külü', 'Kırık Ayna Parçası'],
    koylu: ['Keten Kumaş Lifi', 'Ahşap Toka', 'Pirinç Düğme', 'Tarla Toprağı İzi', 'İşlemeli Mendil'],
    sf: ['Mor Kadife Tüyü', 'Kukla İpliği', 'Gümüş Cep Saati Zinciri'],
  },
  en: {
    sovalye: ['Sword Steel & Armor Shard', 'Leather Glove Fragment', 'Sword Oil & Iron Dust'],
    rahibe: ['Holy Candle Wax', 'Incense Ash', 'Rosary Bead'],
    mortisyen: ['Scalpel Mark', 'Formalin Scent', 'Glass Vial Shard'],
    madman: ['Chalk Powder', 'Curse Ash', 'Broken Mirror Shard'],
    koylu: ['Linen Cloth Fiber', 'Wooden Hairpin', 'Brass Button', 'Field Soil Trace', 'Embroidered Handkerchief'],
    sf: ['Purple Velvet Fiber', 'Puppet String', 'Silver Pocket Watch Chain'],
  },
  ja: {
    sovalye: ['剣の鋼片と鎧の破片', '革手袋の切れ端', '刃油と鉄粉'],
    rahibe: ['聖なる蝋涙', '香灰', '数珠の玉'],
    mortisyen: ['メスの傷跡', 'ホルマリンの臭い', 'ガラス小瓶の破片'],
    madman: ['白墨の粉', '呪いの灰', '割れた鏡の破片'],
    koylu: ['麻布の繊維', '木製の留め具', '真鍮ボタン', '畑の土の痕跡', '刺繍入りハンカチ'],
    sf: ['紫のベルベット繊維', '人形の糸', '銀の懐中時計の鎖'],
  },
  de: {
    sovalye: ['Schwertstahl & Rüstungssplitter', 'Lederhandschuh-Fragment', 'Schwertöl & Eisenstaub'],
    rahibe: ['Heiliges Kerzenwachs', 'Weihrauchasche', 'Rosenkranzperle'],
    mortisyen: ['Skalpellspur', 'Formalingeruch', 'Glasscherbe'],
    madman: ['Kreidestaub', 'Fluchasche', 'Zerbrochene Spiegelscherbe'],
    koylu: ['Leinenfaser', 'Holzspange', 'Messingknopf', 'Ackerbodenspur', 'Besticktes Taschentuch'],
    sf: ['Lila Samtfaser', 'Puppenschnur', 'Silberne Taschenuhrkette'],
  },
  es: {
    sovalye: ['Acero de espada y fragmento de armadura', 'Resto de guante de cuero', 'Aceite de espada y polvo de hierro'],
    rahibe: ['Cera de vela sagrada', 'Ceniza de incienso', 'Cuenta de rosario'],
    mortisyen: ['Marca de bisturí', 'Olor a formol', 'Fragmento de frasco de vidrio'],
    madman: ['Polvo de tiza', 'Ceniza de maldición', 'Fragmento de espejo roto'],
    koylu: ['Fibra de lino', 'Horquilla de madera', 'Botón de latón', 'Rastro de tierra de cultivo', 'Pañuelo bordado'],
    sf: ['Fibra de terciopelo morado', 'Hilo de marioneta', 'Cadena de reloj de bolsillo de plata'],
  },
  fr: {
    sovalye: ['Acier d\'épée et éclat d\'armure', 'Fragment de gant de cuir', 'Huile d\'épée et poussière de fer'],
    rahibe: ['Cire de bougie sacrée', 'Cendre d\'encens', 'Grain de chapelet'],
    mortisyen: ['Trace de scalpel', 'Odeur de formol', 'Éclat de fiole en verre'],
    madman: ['Poussière de craie', 'Cendre de malédiction', 'Éclat de miroir brisé'],
    koylu: ['Fibre de lin', 'Épingle en bois', 'Bouton en laiton', 'Trace de terre agricole', 'Mouchoir brodé'],
    sf: ['Fibre de velours violet', 'Ficelle de marionnette', 'Chaîne de montre de poche en argent'],
  },
};

function pickTpl(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function fillTpl(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : '?');
}

function generateVotingBehaviorTrace(room, focalPlayer) {
  const voteHistory = room.voteHistory || [];
  if (!voteHistory.length) {
    return {
      tr: 'Henüz mahkeme kurulmadığı için oy davranışı izi saptanamadı.',
      en: 'No voting behavioral trace found as no court trial has taken place yet.',
      ja: 'まだ裁判が行われていないため、投票行動の痕跡はありません。',
      de: 'Keine Stimmverhaltensspur vorhanden, da noch kein Gericht stattfand.',
      es: 'No hay rastro de votación ya que aún no se ha celebrado ningún juicio.',
      fr: 'Aucune trace de vote car aucun procès n\'a encore eu lieu.',
    };
  }

  // 30% chance that the trace is obscured / inconclusive (not 100% deterministic)
  if (Math.random() < 0.30) {
    return {
      tr: 'Mahkemedeki oy verme davranışına dair net bir iz elde edilemedi.',
      en: 'No decisive voting behavioral trace could be gathered from the trial.',
      ja: '前回の裁判における投票行動の明確な痕跡は得られなかった。',
      de: 'Keine eindeutige Stimmverhaltensspur aus dem Gericht feststellbar.',
      es: 'No se pudo obtener un rastro concluyente del comportamiento de votación.',
      fr: 'Aucune trace concluante concernant le vote au tribunal n\'a pu être relevée.',
    };
  }

  const lastVote = voteHistory[voteHistory.length - 1];
  const killerTargetId = focalPlayer ? lastVote?.votes?.[focalPlayer.id] : null;

  if (!killerTargetId || killerTargetId === 'skip') {
    return {
      tr: 'Katilin son mahkemede çekimser kaldığı veya oy kullanmaktan kaçındığı belirlendi.',
      en: 'Traces indicate the killer abstained or avoided casting a decisive vote in the last trial.',
      ja: '殺人者は前回の裁判で棄権したか、投票を避けていたことが判明した。',
      de: 'Spuren weisen darauf hin, dass der Mörder sich im letzten Gericht der Stimme enthalten hat.',
      es: 'Se determinó que el asesino se abstuvo o evitó votar en el último juicio.',
      fr: 'Il apparaît que le tueur s\'est abstenu ou a évité de voter lors du dernier procès.',
    };
  }

  if (lastVote.lynchId && killerTargetId === lastVote.lynchId) {
    return {
      tr: 'Katilin son mahkemede idama giden çoğunluk oyuyla aynı yönde oy kullandığı belirlendi.',
      en: 'Traces reveal the killer voted in favor of the majority execution in the last trial.',
      ja: '前回の裁判で、殺人者は処刑された多数派に同調して投票した痕跡がある。',
      de: 'Spuren deuten darauf hin, dass der Mörder im letzten Gericht für die Hinrichtung stimmte.',
      es: 'Los indicios señalan que el asesino votó a favor del linchamiento en el último juicio.',
      fr: 'Les indices indiquent que le tueur a voté en faveur de l\'exécution lors du dernier procès.',
    };
  }

  const votedTarget = getPlayer(room, killerTargetId);
  if (votedTarget) {
    return {
      tr: `Katilin son mahkemede "${votedTarget.name}" aleyhine oy verdiği tespit edildi.`,
      en: `Traces indicate the killer cast their vote against "${votedTarget.name}" in the last trial.`,
      ja: `前回の裁判で、殺人者は「${votedTarget.name}」に投票していた痕跡が検出された。`,
      de: `Spuren zeigen, dass der Mörder im letzten Gericht gegen "${votedTarget.name}" gestimmt hat.`,
      es: `Se detectó que el asesino emitió su voto en contra de "${votedTarget.name}" en el último juicio.`,
      fr: `Il a été relevé que le tueur a voté contre "${votedTarget.name}" lors du dernier procès.`,
    };
  }

  return {
    tr: 'Mahkemedeki oy verme davranışına dair net bir iz elde edilemedi.',
    en: 'No decisive voting behavioral trace could be gathered from the trial.',
    ja: '前回の裁判における投票行動の明確な痕跡は得られなかった。',
    de: 'Keine eindeutige Stimmverhaltensspur aus dem Gericht feststellbar.',
    es: 'No se pudo obtener un rastro concluyente del comportamiento de votación.',
    fr: 'Aucune trace concluante concernant le vote au tribunal n\'a pu être relevée.',
  };
}

function generateMortisianClue(room, player, isDeep = true) {
  const lang = room.language || 'en';
  const alive = getAlive(room);
  let evidenceType = 'info';
  let suspects = [];
  const translations = {};
  const fabricTranslations = {};
  const behaviorTranslations = {};

  if (!room.mortisyenClueHistory) room.mortisyenClueHistory = [];

  if (player.deathCause === 'night') {
    const isSecretSF = room.settings?.gameMode === 'secretKiller';
    const kuklaPlayer = room.kuklaId ? getPlayer(room, room.kuklaId) : null;
    const killerPlayer = isSecretSF ? getPlayer(room, room.sfId) : kuklaPlayer;
    const framedPlayer = room.nightActions?.sf_frame ? getPlayer(room, room.nightActions.sf_frame) : null;
    const focalPlayer = (framedPlayer && framedPlayer.alive) ? framedPlayer : killerPlayer;

    if (focalPlayer) {
      const distractors = alive.filter(p =>
        p.id !== focalPlayer.id &&
        (!isSecretSF ? p.id !== room.sfId : true) &&
        p.id !== player.id &&
        p.id !== room.mortisyen
      );
      shuffle(distractors);

      const chosenDistractors = distractors.slice(0, 2);
      const triad = [focalPlayer.name, ...chosenDistractors.map(d => d.name)].sort(() => Math.random() - 0.5);
      const roleKey = focalPlayer.role || 'koylu';

      // Always pick an item belonging to the focal player's role/archetype
      const itemIdx = Math.floor(Math.random() * (ROLE_ARCHETYPE_ITEMS.tr[roleKey]?.length || 3));
      const itemTR = ROLE_ARCHETYPE_ITEMS.tr[roleKey]?.[itemIdx] || ROLE_ARCHETYPE_ITEMS.tr.koylu[0];
      const itemEN = ROLE_ARCHETYPE_ITEMS.en[roleKey]?.[itemIdx] || ROLE_ARCHETYPE_ITEMS.en.koylu[0];
      const itemJA = ROLE_ARCHETYPE_ITEMS.ja[roleKey]?.[itemIdx] || ROLE_ARCHETYPE_ITEMS.ja.koylu[0];
      const itemDE = ROLE_ARCHETYPE_ITEMS.de[roleKey]?.[itemIdx] || ROLE_ARCHETYPE_ITEMS.de.koylu[0];
      const itemES = ROLE_ARCHETYPE_ITEMS.es[roleKey]?.[itemIdx] || ROLE_ARCHETYPE_ITEMS.es.koylu[0];
      const itemFR = ROLE_ARCHETYPE_ITEMS.fr[roleKey]?.[itemIdx] || ROLE_ARCHETYPE_ITEMS.fr.koylu[0];

      // Behavioral trace of the killer only based on voting behavior in trial
      const behTranslations = generateVotingBehaviorTrace(room, focalPlayer);

      const suspectsJoined = triad.join(', ');
      const isFramed = !!framedPlayer;

      translations.tr = `🔍 Olay yerinde bulunan delil: "${itemTR}"! Bu ize uyan şüpheliler: ${suspectsJoined}.`;
      translations.en = `🔍 Evidence found at the crime scene: "${itemEN}"! Matching suspects: ${suspectsJoined}.`;
      translations.ja = `🔍 現場から発見された証拠：「${itemJA}」！該当する容疑者：${suspectsJoined}。`;
      translations.de = `🔍 Gefundener Beweis am Tatort: "${itemDE}"! Passende Verdächtige: ${suspectsJoined}.`;
      translations.es = `🔍 ¡Evidencia hallada en la escena: "${itemES}"! Sospechosos coincidentes: ${suspectsJoined}.`;
      translations.fr = `🔍 Indice retrouvé sur les lieux : "${itemFR}" ! Suspects correspondants : ${suspectsJoined}.`;

      fabricTranslations.tr = `${itemTR} (${isFramed ? 'Olay Yerine Bırakılan Eşya' : 'Kişisel Zanaat & Rol İzi'})`;
      fabricTranslations.en = `${itemEN} (${isFramed ? 'Planted Item' : 'Role & Craft Trace'})`;
      fabricTranslations.ja = `${itemJA} (${isFramed ? '残された遺留品' : '役職の痕跡'})`;
      fabricTranslations.de = `${itemDE} (${isFramed ? 'Platzierter Gegenstand' : 'Rollen-Spur'})`;
      fabricTranslations.es = `${itemES} (${isFramed ? 'Objeto Plantado' : 'Rastro de Rol'})`;
      fabricTranslations.fr = `${itemFR} (${isFramed ? 'Objet Déposé' : 'Trace de Rôle'})`;

      behaviorTranslations.tr = behTranslations.tr;
      behaviorTranslations.en = behTranslations.en;
      behaviorTranslations.ja = behTranslations.ja;
      behaviorTranslations.de = behTranslations.de;
      behaviorTranslations.es = behTranslations.es;
      behaviorTranslations.fr = behTranslations.fr;

      evidenceType = 'suspects';
      suspects = triad;
    } else {
      translations.tr = 'Karanlık bir gölge tarafından katledildi. Belirgin bir şüpheli grubu saptanamadı.';
      translations.en = 'Slain by an obscure shadow. No clear suspect group identified.';
      translations.ja = '謎の影により殺害された。明確な容疑者は特定できず。';
      translations.de = 'Von einem dunklen Schatten getötet. Keine eindeutige Gruppe ermittelt.';
      translations.es = 'Asesinado por una sombra oscura. Sin sospechosos claros.';
      translations.fr = 'Tué par une ombre mystérieuse. Aucun suspect clair identifié.';
      evidenceType = 'info';
    }

  } else if (player.deathCause === 'lynch') {
    const isKukla = player.role === ROLES.KUKLA || player.id === room.kuklaId;
    if (isKukla) {
      translations.tr = `Adalet yerini buldu! İdam edilen kişi Mr. Schadenfreude'nin Kuklası (${roleLabel(player.role, 'tr')}) idi!`;
      translations.en = `Justice served! The executed person was indeed Mr. Schadenfreude's Puppet (${roleLabel(player.role, 'en')})!`;
      translations.ja = `正義が執行された！処刑された者はMr.シャーデンフロイデの人形（${roleLabel(player.role, 'ja')}）だった！`;
      translations.de = `Gerechtigkeit siegt! Die hingerichtete Person war Mr. Schadenfreudes Puppe (${roleLabel(player.role, 'de')})!`;
      translations.es = `¡Justicia cumplida! ¡La persona ejecutada era la Marioneta de Mr. Schadenfreude (${roleLabel(player.role, 'es')})!`;
      translations.fr = `Justice est faite ! La persona ejecutada était la Marionnette de Mr. Schadenfreude (${roleLabel(player.role, 'fr')}) !`;
      evidenceType = 'confirm';
      suspects = [];
    } else {
      translations.tr = `Yargı hatası... İdam edilen kişi masum bir ${roleLabel(player.role, 'tr')} idi.`;
      translations.en = `Judicial mistake... The executed person was an innocent ${roleLabel(player.role, 'en')}.`;
      translations.ja = `誤審… 処刑された者は無実の${roleLabel(player.role, 'ja')}だった。`;
      translations.de = `Justizirrtum... Die hingerichtete Person war ein unschuldiger ${roleLabel(player.role, 'de')}.`;
      translations.es = `Error judicial... La persona ejecutada era un inocente ${roleLabel(player.role, 'es')}.`;
      translations.fr = `Erreur judiciaire... La personne exécutée était un innocent ${roleLabel(player.role, 'fr')}.`;
      evidenceType = 'warning';
      suspects = [];
    }

  } else if (player.deathCause === 'madman_curse') {
    translations.tr = `Lanet izi: ${player.name} Deli'nin laneti tarafından mezara çekildi.`;
    translations.en = `Curse trace: ${player.name} was dragged to the grave by the Madman's curse.`;
    translations.ja = `呪いの痕跡：${player.name}は狂人の呪いによって墓場へ引きずり込まれた。`;
    translations.de = `Fluchspur: ${player.name} wurde vom Fluch des Verrückten ins Grab gezogen.`;
    translations.es = `Rastro de maldición: ${player.name} fue arrastrado a la tumba por la maldición del Demente.`;
    translations.fr = `Trace de malédiction : ${player.name} a été emporté dans la tombe par le Fou.`;
    evidenceType = 'warning';

  } else {
    translations.tr = `Otopsi raporu: ${player.name}'in ölümü etrafında belirsiz izler tespit edildi.`;
    translations.en = `Autopsy report: Unclear traces detected around ${player.name}'s death.`;
    translations.ja = `検死報告：${player.name}の死因に不明瞭な痕跡が検出された。`;
    translations.de = `Autopsiebericht: Unklare Spuren um den Tod von ${player.name}.`;
    translations.es = `Informe de autopsia: Rastros no concluyentes sobre la muerte de ${player.name}.`;
    translations.fr = `Rapport d'autopsie : Traces incertaines autour de la mort de ${player.name}.`;
    evidenceType = 'info';
  }

  return {
    id: 'clue-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    name: player.name,
    role: roleLabel(player.role, lang),
    victimRoleKey: player.role,
    clue: translations[lang] || translations.tr,
    evidenceType: evidenceType,
    suspects: suspects,
    fabricTrace: fabricTranslations[lang] || fabricTranslations.tr || '',
    behaviorTrace: behaviorTranslations[lang] || behaviorTranslations.tr || '',
    translations,
    roleTranslations: {
      tr: roleLabel(player.role, 'tr'),
      en: roleLabel(player.role, 'en'),
      ja: roleLabel(player.role, 'ja'),
      de: roleLabel(player.role, 'de'),
      es: roleLabel(player.role, 'es'),
      fr: roleLabel(player.role, 'fr'),
    },
    fabricTranslations,
    behaviorTranslations,
  };
}

// ─────────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────────
const rooms = {}; // roomCode → gameState

function createRoom(hostId, hostName, language) {
  const code = generateRoomCode();
  rooms[code] = {
    code,
    host: hostId,
    language: language || 'en',
    phase: PHASES.LOBBY,
    round: 0,
    players: [],
    sfId: null,
    kuklaId: null,
    previousKuklaId: null,
    kuklaHistory: [],
    consecutiveInnocentLynches: 0,
    readyPlayers: {},
    newKuklaJustSet: false,
    firstDeathAnnounced: false,   // Rahibe: first night death
    firstLynchAnnounced: false,   // Rahibe: first lynch
    rahibe: null,
    mortisyen: null,
    sovalye: null,
    nightActions: {},
    votes: {},
    pendingDeaths: [],
    announcements: [],
    chat: [],
    timer: null,
    timerEndsAt: null,
    sovalyeChallengesUsed: 0,
    bannedNames: [],
    settings: {
      gameMode: 'puppetMaster', // 'puppetMaster' | 'secretKiller'
      nightDuration: PHASE_DURATIONS.night,
      dayDuration: PHASE_DURATIONS.day,
      voteDuration: PHASE_DURATIONS.vote,
      showVotes: true,          // Oyları Açık Göster
      puppetCanSkip: true,      // Kukla Pas Geçebilir
      debugRole: 'auto',        // Test için rol seçimi ('auto' | 'sf' | 'kukla' | 'mortisyen' | ...)
    },
  };
  addPlayer(code, hostId, hostName);
  return code;
}

function handlePlayerLeave(room, socketId) {
  if (!room) return;
  const code = room.code;
  const leavingPlayer = getPlayer(room, socketId);
  if (!leavingPlayer) return;

  if (room.phase === PHASES.LOBBY) {
    // In lobby, immediately remove player
    room.players = room.players.filter(p => p.id !== socketId);
    if (room.assignedRoles) delete room.assignedRoles[socketId];

    // Check if any human players left
    const humanPlayers = room.players.filter(p => !p.isBot);
    if (humanPlayers.length === 0) {
      // No human players left in lobby -> destroy room
      delete rooms[code];
      return;
    }

    // If leaving player was the host, migrate host randomly to another player
    if (room.host === socketId) {
      const newHost = humanPlayers[Math.floor(Math.random() * humanPlayers.length)];
      room.host = newHost.id;
      addAnnouncement(room, room.language === 'tr'
        ? `👑 ${newHost.name} yeni oda yöneticisi (Host) oldu.`
        : `👑 ${newHost.name} is now the room host.`);
    }

    broadcastState(code);
  } else {
    // In active game: mark disconnected (60s grace period for rejoining)
    leavingPlayer.disconnected = true;
  }
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'SCH-' + Array.from({ length: 3 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function addPlayer(code, socketId, name) {
  const room = rooms[code];
  if (!room) return false;
  const existing = room.players.find(p => p.name === name);
  if (existing) {
    const oldId = existing.id;
    existing.id = socketId;
    existing.disconnected = false;

    // Rol ve Host ID referanslarını yeni soketle senkronize et
    if (room.host === oldId) room.host = socketId;
    if (room.sfId === oldId) room.sfId = socketId;
    if (room.kuklaId === oldId) room.kuklaId = socketId;
    if (room.previousKuklaId === oldId) room.previousKuklaId = socketId;
    if (room.rahibe === oldId) room.rahibe = socketId;
    if (room.mortisyen === oldId) room.mortisyen = socketId;
    if (room.sovalye === oldId) room.sovalye = socketId;

    if (room.assignedRoles && room.assignedRoles[oldId] !== undefined) {
      room.assignedRoles[socketId] = room.assignedRoles[oldId];
      delete room.assignedRoles[oldId];
    }
    if (room.votes && room.votes[oldId] !== undefined) {
      room.votes[socketId] = room.votes[oldId];
      delete room.votes[oldId];
    }
    if (room.readyPlayers && room.readyPlayers[oldId] !== undefined) {
      room.readyPlayers[socketId] = room.readyPlayers[oldId];
      delete room.readyPlayers[oldId];
    }
    return true;
  }
  room.players.push({
    id: socketId,
    name,
    role: null,
    alive: true,
    disconnected: false,
    deathRound: null,
    deathCause: null,
  });
  return true;
}

function getPlayer(room, id) {
  return room.players.find(p => p.id === id);
}

function getAlive(room) {
  return room.players.filter(p => p.alive);
}

// ─────────────────────────────────────────────
// ROLE ASSIGNMENT
// ─────────────────────────────────────────────
function assignRoles(room) {
  const count = room.players.length;
  const roleList = buildRoleList(count);
  const assigned = room.assignedRoles || {};

  const unassignedPlayers = [];
  let sfAssigned = false;
  let kuklaAssigned = false;

  // 1) First, apply per-player assigned roles from lobby
  room.players.forEach(p => {
    let customRole = assigned[p.id];
    // Fallback to host debugRole setting if not set specifically
    if ((!customRole || customRole === 'auto') && p.id === room.host && room.settings?.debugRole && room.settings.debugRole !== 'auto') {
      customRole = room.settings.debugRole;
    }

    if (customRole && customRole !== 'auto') {
      if (customRole === ROLES.KUKLA) {
        kuklaAssigned = true;
        room.kuklaId = p.id;
        p.isKukla = true;
        if (!room.kuklaHistory) room.kuklaHistory = [];
        if (!room.kuklaHistory.includes(p.id)) room.kuklaHistory.push(p.id);
        p.role = ROLES.KOYLU; // Default base role for Kukla if not specified
      } else {
        p.role = customRole;
      }
      p.alive = true;
      p.deathRound = null;
      p.deathCause = null;

      if (customRole === ROLES.SF) sfAssigned = true;

      // Remove role from roleList if present
      const rIdx = roleList.indexOf(p.role);
      if (rIdx !== -1) {
        roleList.splice(rIdx, 1);
      } else {
        const koyluIdx = roleList.indexOf(ROLES.KOYLU);
        if (koyluIdx !== -1) roleList.splice(koyluIdx, 1);
      }
    } else {
      unassignedPlayers.push(p);
    }
  });

  // 2) Ensure Mr. Schadenfreude is present if no one was manually assigned SF
  if (!sfAssigned && !roleList.includes(ROLES.SF)) {
    roleList.unshift(ROLES.SF);
    const koyluIdx = roleList.lastIndexOf(ROLES.KOYLU);
    if (koyluIdx !== -1) roleList.splice(koyluIdx, 1);
  }

  // 3) Shuffle and assign remaining roles to unassigned players
  shuffle(roleList);
  unassignedPlayers.forEach((p, i) => {
    p.role = roleList[i] || ROLES.KOYLU;
    p.alive = true;
    p.deathRound = null;
    p.deathCause = null;
  });

  // 4) Map special pointers
  room.sfId = room.players.find(p => p.role === ROLES.SF)?.id || null;
  if (!kuklaAssigned) room.kuklaId = null;
  room.previousKuklaId = null;
  room.rahibe = room.players.find(p => p.role === ROLES.RAHIBE)?.id || null;
  room.mortisyen = room.players.find(p => p.role === ROLES.MORTISYEN)?.id || null;
  room.sovalye = room.players.find(p => p.role === ROLES.SOVALYE)?.id || null;
  room.newKuklaJustSet = false;
  room.consecutiveInnocentLynches = 0;
  room.firstDeathAnnounced = false;
  room.firstLynchAnnounced = false;
  room.sovalyeChallengesUsed = 0;
  room.rahibeTarotAvailable = true;
  room.rahibeLastTarotRound = null;
  room.round = 0;
  room.announcements = [];
  room.chat = [];
  initBotMemory(room);
}

function shuffleAndAssignAll(room, roleList) {
  shuffle(roleList);
  room.players.forEach((p, i) => {
    p.role = roleList[i];
    p.alive = true;
    p.deathRound = null;
    p.deathCause = null;
  });
  initBotMemory(room);
}

function buildRoleList(count) {
  const roles = [ROLES.SF, ROLES.MORTISYEN];
  if (count >= 6) roles.push(ROLES.RAHIBE);
  if (count >= 7) roles.push(ROLES.SOVALYE);
  if (count >= 9) roles.push(ROLES.MADMAN);
  while (roles.length < count) roles.push(ROLES.KOYLU);
  return roles;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─────────────────────────────────────────────
// WIN CONDITION CHECK
// ─────────────────────────────────────────────
function checkWin(room) {
  if (!room || room.phase === PHASES.LOBBY || room.phase === PHASES.ENDED || room.phase === PHASES.NIGHT0) {
    return null;
  }
  const alive = getAlive(room);
  const sfAlive = alive.find(p => p.id === room.sfId);
  const kuklaAlive = room.kuklaId && alive.find(p => p.id === room.kuklaId);
  const isSecretSF = room.settings?.gameMode === 'secretKiller';

  // 1) Secret Killer Mode Win Conditions
  if (isSecretSF) {
    if (!sfAlive) {
      return {
        winner: 'villagers',
        reason: room.language === 'tr'
          ? 'Mr. Schadenfreude yok edildi. Köylüler kazandı!'
          : 'Mr. Schadenfreude was eliminated. Villagers win!'
      };
    }
    const villagerCount = alive.filter(p => p.id !== room.sfId).length;
    if (villagerCount <= 1) {
      return {
        winner: 'sf',
        reason: room.language === 'tr'
          ? 'Köy tamamen gölgeye teslim oldu. Mr. Schadenfreude kazandı!'
          : 'The village fell to shadow. Mr. Schadenfreude wins!'
      };
    }
    return null;
  }

  // 2) Classic Puppet Master Mode Win Conditions
  if (!sfAlive) {
    return { winner: 'villagers', reason: room.language === 'tr' ? 'SF bir şekilde yok oldu!' : 'SF somehow vanished!' };
  }

  const villagerCount = alive.filter(p => p.id !== room.sfId && p.id !== room.kuklaId).length;
  const evilCount = (sfAlive ? 1 : 0) + (kuklaAlive ? 1 : 0);

  // All villagers dead -> SF wins
  if (villagerCount === 0) {
    return { winner: 'sf', reason: room.language === 'tr' ? 'Köy yok edildi. Mr. Schadenfreude kazandı.' : 'The village is destroyed. Mr. Schadenfreude wins.' };
  }

  // SF + Kukla alive: SF wins when evilCount > villagerCount
  if (kuklaAlive && evilCount > villagerCount) {
    return { winner: 'sf', reason: room.language === 'tr' ? 'Köy, gölgede kaldı. Mr. Schadenfreude kazandı.' : 'The village fell to shadow. Mr. Schadenfreude wins.' };
  }

  // Kukla is dead: If SF does NOT have the right to pick a new puppet, villagers win immediately!
  if (!kuklaAlive) {
    const canPick = (room.consecutiveInnocentLynches || 0) >= 2;
    if (!canPick) {
      return {
        winner: 'villagers',
        reason: room.language === 'tr'
          ? 'Kukla yok edildi ve Mr. Schadenfreude yeni bir kukla seçme hakkına sahip değil. Köylüler kazandı!'
          : 'The puppet was eliminated and Mr. Schadenfreude has no right to choose another. Villagers win!'
      };
    }
  }

  return null;
}


// ─────────────────────────────────────────────
// BOT SYSTEM
// ─────────────────────────────────────────────
const BOT_NAMES = ['Rin', 'Len', 'Miku', 'Luka', 'Kaito', 'Meiko', 'Gumi'];

function addBots(room, count) {
  if (room.phase !== PHASES.LOBBY) return 0;
  const maxAdd = Math.max(0, 15 - room.players.length);
  const toAdd = Math.min(count, maxAdd);
  for (let i = 0; i < toAdd; i++) {
    const existingBots = room.players.filter(p => p.isBot).length;
    const nameBase = BOT_NAMES[existingBots % BOT_NAMES.length];
    const suffix = existingBots >= BOT_NAMES.length ? ` ${Math.floor(existingBots / BOT_NAMES.length) + 1}` : '';
    const botId = 'bot-' + Math.random().toString(36).slice(2, 11);
    room.players.push({
      id: botId, name: nameBase + suffix, role: null,
      alive: true, disconnected: false, isBot: true,
      deathRound: null, deathCause: null,
    });
  }
  return toAdd;
}

// ─────────────────────────────────────────────
// BOT AI SUBSYSTEM (4-Pillar Deductive Engine)
// ─────────────────────────────────────────────

function initBotMemory(room) {
  if (!room) return;
  if (!room.botMemory) {
    room.botMemory = {
      publicSuspects: {}, // { playerId: count } from Mortisyen clues
      knownInnocents: {}, // { playerId: true } e.g. Knight shield save
      tarotSightings: {}, // { playerId: round } spotted active at night by Rahibe
      lynchVotesOnInnocents: {}, // { voterId: count } bad lynch participation
    };
  }
}

function recordMorticianClueForBots(room, clueObj) {
  if (!room || !clueObj) return;
  initBotMemory(room);
  if (Array.isArray(clueObj.suspects)) {
    clueObj.suspects.forEach(suspectName => {
      const p = room.players.find(x => x.name === suspectName);
      if (p) {
        room.botMemory.publicSuspects[p.id] = (room.botMemory.publicSuspects[p.id] || 0) + 1;
      }
    });
  }
}

function recordRahibeTarotForBots(room, targetPlayer, targetActed) {
  if (!room || !targetPlayer) return;
  initBotMemory(room);
  if (targetActed) {
    room.botMemory.tarotSightings[targetPlayer.id] = room.round;
  }
}

function recordLynchResultForBots(room, lynchedPlayer, voteMap) {
  if (!room || !lynchedPlayer) return;
  initBotMemory(room);
  const isEvil = lynchedPlayer.role === ROLES.KUKLA || lynchedPlayer.id === room.sfId;
  if (!isEvil) {
    // Lynched player was innocent! Voters who targeted this innocent gain suspicion
    for (const [voterId, targetId] of Object.entries(voteMap || {})) {
      if (targetId === lynchedPlayer.id && voterId !== lynchedPlayer.id) {
        room.botMemory.lynchVotesOnInnocents[voterId] = (room.botMemory.lynchVotesOnInnocents[voterId] || 0) + 1;
      }
    }
  } else {
    // Lynched player was evil! Voters who helped convict gain innocence credit
    for (const [voterId, targetId] of Object.entries(voteMap || {})) {
      if (targetId === lynchedPlayer.id) {
        room.botMemory.knownInnocents[voterId] = true;
      }
    }
  }
}

function recordKnightShieldSaveForBots(room, targetPlayer) {
  if (!room || !targetPlayer) return;
  initBotMemory(room);
  room.botMemory.knownInnocents[targetPlayer.id] = true;
}

function getBotSuspicion(room, botPlayer, targetPlayer) {
  if (!room || !botPlayer || !targetPlayer) return 50;
  if (botPlayer.id === targetPlayer.id) return 0;
  
  const isSecretSF = room.settings?.gameMode === 'secretKiller';
  const mem = room.botMemory || {};
  
  // 1) Kukla Bot
  if (botPlayer.id === room.kuklaId) {
    if (targetPlayer.id === room.sfId) return 0; // Allies with SF
    if (targetPlayer.role === ROLES.MORTISYEN) return 95;
    if (targetPlayer.role === ROLES.SOVALYE) return 90;
    if (targetPlayer.role === ROLES.RAHIBE) return 85;
    return 40;
  }

  // 2) Mr. Schadenfreude Bot
  if (botPlayer.id === room.sfId) {
    if (!isSecretSF && targetPlayer.id === room.kuklaId) return 0;
    if (targetPlayer.role === ROLES.MORTISYEN) return 95;
    if (targetPlayer.role === ROLES.SOVALYE) return 90;
    if (targetPlayer.role === ROLES.RAHIBE) return 85;
    return 40;
  }

  // 3) Town Bot (Koylu, Sovalye, Mortisyen, Rahibe, Madman)
  let score = 30; // Baseline suspicion

  if (!isSecretSF && targetPlayer.id === room.sfId) {
    return 0; // Cannot lynch SF in classic mode
  }

  // A) Mortisyen public suspect sightings (+30 per appearance)
  const mortCount = mem.publicSuspects?.[targetPlayer.id] || 0;
  score += mortCount * 30;

  // B) Rahibe tarot active sightings (+35 if seen moving at night)
  if (mem.tarotSightings?.[targetPlayer.id]) {
    score += 35;
  }

  // C) Participated in lynching an innocent (+20 per innocent lynch led/voted)
  const badVotes = mem.lynchVotesOnInnocents?.[targetPlayer.id] || 0;
  score += badVotes * 20;

  // D) Proven Innocent / Protected (-40)
  if (mem.knownInnocents?.[targetPlayer.id]) {
    score -= 40;
  }

  // E) Retaliation: If this target voted for the bot in the previous round (+15)
  if (room.voteHistory && room.voteHistory.length > 0) {
    const lastVotes = room.voteHistory[room.voteHistory.length - 1]?.votes || {};
    if (lastVotes[targetPlayer.id] === botPlayer.id) {
      score += 15;
    }
  }

  // Jitter (±8) unique to bot/target pair so bots don't all vote identically
  const jitter = ((botPlayer.name.charCodeAt(0) * 7 + targetPlayer.name.charCodeAt(0) * 13) % 17) - 8;
  score += jitter;

  return Math.max(0, Math.min(100, score));
}

function scheduleBotActions(code) {
  const room = rooms[code];
  if (!room) return;
  initBotMemory(room);
  const phase = room.phase;

  if (phase === PHASES.NIGHT0) botNight0Action(code);
  else if (phase === PHASES.NIGHT) botNightAction(code);
  else if (phase === PHASES.VOTE) botVoteAction(code);
  else if (phase === PHASES.DAY) {
    botDayChat(code);
    // Bots become ready during day discussion after a natural delay
    const livingBots = room.players.filter(p => p.isBot && p.alive);
    livingBots.forEach((bot, idx) => {
      setTimeout(() => {
        const r = rooms[code];
        if (!r || r.phase !== PHASES.DAY) return;
        setPlayerReady(r, bot.id, true);
      }, 4000 + idx * 1000 + Math.random() * 5000);
    });
  } else if (phase === PHASES.DAWN || phase === PHASES.RESULT) {
    const livingBots = room.players.filter(p => p.isBot && p.alive);
    livingBots.forEach((bot, idx) => {
      setTimeout(() => {
        const r = rooms[code];
        if (!r || r.phase !== phase) return;
        setPlayerReady(r, bot.id, true);
      }, 1500 + idx * 500 + Math.random() * 2000);
    });
  }
}

function botNight0Action(code) {
  const room = rooms[code];
  if (!room) return;
  const sfPlayer = room.players.find(p => p.id === room.sfId);
  if (!sfPlayer?.isBot) return; // Human SF — wait for input
  setTimeout(() => {
    const r = rooms[code];
    if (!r || r.phase !== PHASES.NIGHT0 || r.kuklaId) return;
    const candidates = r.players.filter(p => p.alive && p.id !== r.sfId);
    if (!candidates.length) return;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    r.kuklaId = target.id;
    target.isKukla = true;
    if (!r.kuklaHistory) r.kuklaHistory = [];
    if (!r.kuklaHistory.includes(target.id)) r.kuklaHistory.push(target.id);
    r.newKuklaJustSet = false;
    if (!target.isBot) {
      io.to(target.id).emit('game:becomeKukla', {
        baseRole: target.role,
        message: r.language === 'tr'
          ? `Mr. Schadenfreude sizi seçti. Artık hem ${roleLabel(target.role, r.language)} hem de onun kuklasısınız!`
          : `Mr. Schadenfreude has chosen you. You are both ${roleLabel(target.role, r.language)} and his puppet!`,
      });
      io.to(target.id).emit('game:role', buildPrivateState(r, target.id));
    }
    clearTimer(r);
    handleNight0End(code);
  }, 3000 + Math.random() * 4000);
}

function botNightAction(code) {
  const room = rooms[code];
  if (!room) return;
  initBotMemory(room);
  const isSecretSF = room.settings?.gameMode === 'secretKiller';
  
  // 1) SF bot: send kill order / direct kill / pick replacement puppet
  const sfPlayer = room.players.find(p => p.id === room.sfId);
  if (sfPlayer?.isBot) {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.NIGHT) return;

      // Check if SF can & needs to pick a replacement Kukla (Chaos Score: 2/2 innocent lynches)
      const canPickNewKukla = !isSecretSF && !r.kuklaId && ((r.consecutiveInnocentLynches || 0) >= 2);
      if (canPickNewKukla) {
        const candidates = r.players.filter(p => p.alive && p.id !== r.sfId);
        if (candidates.length > 0) {
          // Camouflage: pick least suspected candidate
          const scored = candidates.map(c => ({ c, score: getBotSuspicion(r, sfPlayer, c) })).sort((a, b) => a.score - b.score);
          const newKukla = scored[0]?.c || candidates[0];
          r.kuklaId = newKukla.id;
          newKukla.isKukla = true;
          if (!r.kuklaHistory) r.kuklaHistory = [];
          if (!r.kuklaHistory.includes(newKukla.id)) r.kuklaHistory.push(newKukla.id);
          r.newKuklaJustSet = true;
          r.consecutiveInnocentLynches = 0;

          if (!newKukla.isBot) {
            io.to(newKukla.id).emit('game:becomeKukla', {
              baseRole: newKukla.role,
              message: r.language === 'tr'
                ? `Mr. Schadenfreude sizi yeni kuklası olarak seçti. Artık hem ${roleLabel(newKukla.role, r.language)} hem de onun kuklasısınız!`
                : `Mr. Schadenfreude has chosen you as his new puppet. You are both ${roleLabel(newKukla.role, r.language)} and his puppet!`,
            });
            io.to(newKukla.id).emit('game:role', buildPrivateState(r, newKukla.id));
          }
          broadcastState(code);
        }
      }

      // If SF has a kukla (or in Secret Killer mode), issue nighttime execution order
      if (r.kuklaId || isSecretSF) {
        if (r.nightActions.sf_target) return;
        const targets = r.players.filter(p => p.alive && p.id !== r.sfId && p.id !== r.kuklaId);
        if (!targets.length) {
          setPlayerReady(r, sfPlayer.id, true);
          return;
        }

        // SF prioritizes high-threat investigative/protective roles: Mortisyen > Sovalye > Rahibe > others
        const threatSorted = [...targets].sort((a, b) => {
          const rolePriority = { mortisyen: 4, sovalye: 3, rahibe: 2, koylu: 1, madman: 0 };
          const pA = rolePriority[a.role] || 1;
          const pB = rolePriority[b.role] || 1;
          return pB - pA;
        });
        const target = threatSorted[0] || targets[0];
        r.nightActions.sf_target = target.id;

        // Bot SF: 70% chance to plant false evidence on a trusted living innocent
        const frameCandidates = r.players.filter(p => p.alive && p.id !== r.sfId && p.id !== r.kuklaId && p.id !== target.id);
        if (frameCandidates.length > 0 && Math.random() < 0.7) {
          const sortedInnocents = [...frameCandidates].sort((a, b) => getBotSuspicion(r, sfPlayer, a) - getBotSuspicion(r, sfPlayer, b));
          const framed = sortedInnocents[0];
          r.nightActions.sf_frame = framed ? framed.id : null;
        } else {
          r.nightActions.sf_frame = null;
        }

        if (!isSecretSF) {
          // Notify human kukla
          const kuklaPlayer = r.kuklaId ? getPlayer(r, r.kuklaId) : null;
          if (kuklaPlayer && !kuklaPlayer.isBot) {
            io.to(r.kuklaId).emit('game:killOrder', {
              targetId: target.id,
              targetName: target.name,
              message: r.language === 'tr'
                ? `Mr. Schadenfreude bu gece "${target.name}" adlı köylüyü öldürmeni emretti.`
                : `Mr. Schadenfreude ordered you to kill "${target.name}" tonight.`,
            });
          }
        }
        setPlayerReady(r, sfPlayer.id, true);
      } else {
        setPlayerReady(r, sfPlayer.id, true);
      }
    }, 2000 + Math.random() * 4000);
  }

  // 2) Şövalye bot: protect or challenge
  const sovalyePlayer = room.players.find(p => p.role === ROLES.SOVALYE && p.isBot && p.alive);
  if (sovalyePlayer) {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.NIGHT) return;
      if (r.nightActions.sovalye_protect || r.nightActions.sovalye_challenge) return;
      const targets = r.players.filter(p => p.alive && p.id !== sovalyePlayer.id && p.id !== r.sfId);
      if (!targets.length) return;

      // Challenge logic: round 2+ when chaos >= 1 or few living remain
      const livingCount = r.players.filter(p => p.alive).length;
      const canChallenge = (r.sovalyeChallengesUsed || 0) < 2 && r.round >= 2 && ((r.consecutiveInnocentLynches || 0) >= 1 || livingCount <= 4);

      if (canChallenge && Math.random() < 0.4) {
        r.nightActions.sovalye_challenge = r.sfId;
        r.sovalyeChallengesUsed = (r.sovalyeChallengesUsed || 0) + 1;
      } else {
        // Protect target: choose candidate with lowest suspicion (highest trust) e.g. Mortisyen, Rahibe, or trusted town
        const scoredTargets = [...targets].sort((a, b) => {
          const valA = (a.role === ROLES.MORTISYEN ? -50 : (a.role === ROLES.RAHIBE ? -40 : getBotSuspicion(r, sovalyePlayer, a)));
          const valB = (b.role === ROLES.MORTISYEN ? -50 : (b.role === ROLES.RAHIBE ? -40 : getBotSuspicion(r, sovalyePlayer, b)));
          return valA - valB;
        });
        const protectTarget = scoredTargets[0] || targets[0];
        r.nightActions.sovalye_protect = protectTarget.id;
      }
      setPlayerReady(r, sovalyePlayer.id, true);
    }, 2500 + Math.random() * 5000);
  }

  // 3) Mortisyen bot: forensics vs surveillance
  const mortisyenPlayer = room.players.find(p => p.role === ROLES.MORTISYEN && p.isBot && p.alive);
  if (mortisyenPlayer) {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.NIGHT) return;
      if (r.nightActions.mortisyen_mode) return;

      const hasBodies = r.players.some(p => !p.alive);
      if (!hasBodies || r.round === 1) {
        // Round 1 or no dead: surveillance mode on highest suspicion player
        const candidates = r.players.filter(p => p.alive && p.id !== mortisyenPlayer.id && p.id !== r.sfId);
        if (candidates.length) {
          const sorted = [...candidates].sort((a, b) => getBotSuspicion(r, mortisyenPlayer, b) - getBotSuspicion(r, mortisyenPlayer, a));
          const target = sorted[0] || candidates[0];
          r.nightActions.mortisyen_mode = 'surveillance';
          r.nightActions.mortisyen_target = target.id;
        } else {
          r.nightActions.mortisyen_mode = 'forensics';
        }
      } else {
        r.nightActions.mortisyen_mode = 'forensics';
      }
      setPlayerReady(r, mortisyenPlayer.id, true);
    }, 2000 + Math.random() * 5000);
  }

  // 4) Rahibe bot: draws tarot for candidate with highest suspicion
  const rahibePlayer = room.players.find(p => p.role === ROLES.RAHIBE && p.isBot && p.alive);
  if (rahibePlayer) {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.NIGHT) return;
      if (!r.rahibeTarotAvailable) {
        setPlayerReady(r, rahibePlayer.id, true);
        return;
      }
      if (r.nightActions.rahibe_target) return;
      const candidates = r.players.filter(p => p.alive && p.id !== rahibePlayer.id && (isSecretSF || p.id !== r.sfId));
      if (!candidates.length) return;

      const sorted = [...candidates].sort((a, b) => getBotSuspicion(r, rahibePlayer, b) - getBotSuspicion(r, rahibePlayer, a));
      const target = sorted[0] || candidates[0];
      r.nightActions.rahibe_target = target.id;
      setPlayerReady(r, rahibePlayer.id, true);
    }, 2000 + Math.random() * 5000);
  }

  // 5) Passive & non-action bots
  const passiveBots = room.players.filter(p => p.isBot && p.alive && p.id !== room.sfId && p.role !== ROLES.SOVALYE && p.role !== ROLES.MORTISYEN && p.role !== ROLES.RAHIBE);
  passiveBots.forEach((bot, idx) => {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.NIGHT) return;
      if (r.kuklaId === bot.id && r.nightActions.sf_target && !r.nightActions.kukla_kill && !r.nightActions.kukla_refused) {
        r.nightActions.kukla_kill = r.nightActions.sf_target;
      }
      setPlayerReady(r, bot.id, true);
    }, 1500 + idx * 800 + Math.random() * 2500);
  });
}

function botVoteAction(code) {
  const room = rooms[code];
  if (!room) return;
  initBotMemory(room);

  const isSecretSF = room.settings?.gameMode === 'secretKiller';
  const sfPlayer = room.players.find(p => p.id === room.sfId);

  // In Classic Puppet Master mode, SF cannot vote at all in the trial
  if (!isSecretSF && sfPlayer && sfPlayer.isBot) {
    setTimeout(() => {
      const r = rooms[code];
      if (r && r.phase === PHASES.VOTE) setPlayerReady(r, sfPlayer.id, true);
    }, 1000);
  }

  // Voting bots
  const bots = room.players.filter(p => p.isBot && p.alive && (isSecretSF || p.id !== room.sfId));
  bots.forEach((bot, idx) => {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.VOTE || r.votes[bot.id]) return;

      const candidates = r.players.filter(p => p.alive && p.id !== bot.id && (isSecretSF || p.id !== r.sfId));
      if (!candidates.length) return;

      // Count current votes to support bandwagoning / consensus building
      const currentVoteCounts = {};
      Object.values(r.votes || {}).forEach(targetId => {
        currentVoteCounts[targetId] = (currentVoteCounts[targetId] || 0) + 1;
      });

      // Calculate tactical vote score for each candidate
      let bestTarget = null;
      let highestScore = -9999;

      candidates.forEach(cand => {
        let score = getBotSuspicion(r, bot, cand);
        const votesOnCand = currentVoteCounts[cand.id] || 0;

        // Bandwagon weight: If candidate already has votes, town unites
        if (bot.id !== r.kuklaId) {
          score += votesOnCand * 15;
        } else {
          // Kukla joins the bandwagon on an innocent to ensure mislynch
          if (cand.id !== r.sfId) {
            score += votesOnCand * 25 + Math.random() * 15;
          } else {
            score = -9999;
          }
        }

        if (score > highestScore) {
          highestScore = score;
          bestTarget = cand;
        }
      });

      if (bestTarget) {
        r.votes[bot.id] = bestTarget.id;
      }
      setPlayerReady(r, bot.id, true);
      broadcastState(code);
    }, 1500 + idx * 1200 + Math.random() * 3500);
  });
}

function botDayChat(code) {
  const room = rooms[code];
  if (!room || room.phase !== PHASES.DAY) return;
  initBotMemory(room);

  const lang = room.language || 'en';
  const livingBots = room.players.filter(p => p.isBot && p.alive);
  if (livingBots.length === 0) return;

  const isSecretSF = room.settings?.gameMode === 'secretKiller';
  const kuklaBot = livingBots.find(p => p.id === room.kuklaId);

  // 1) Mortisyen Bot: automatically publishes autopsy clue if available
  const mortBot = livingBots.find(p => p.role === ROLES.MORTISYEN);
  if (mortBot && room.mortisyenClues && room.mortisyenClues.length > 0) {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.DAY) return;
      const latestClue = r.mortisyenClues[r.mortisyenClues.length - 1];
      if (latestClue) {
        const mortTitles = {
          tr: '⚰️ Mortisyen Gizli Raporu',
          en: '⚰️ Undertaker Confidential Report',
          ja: '⚰️ 葬儀屋の極秘報告',
          de: '⚰️ Vertraulicher Bericht des Leichenbeschauers',
          es: '⚰️ Informe Confidencial del Sepulturero',
          fr: '⚰️ Rapport Confidentiel du Croque-mort',
        };
        const text = latestClue.translations?.[lang] || latestClue.clue;
        const msg = {
          name: mortTitles[lang] || mortTitles.tr,
          nameTranslations: mortTitles,
          message: text,
          translations: latestClue.translations || { tr: text, en: text },
          isSystem: true,
          isBot: true,
          time: Date.now(),
        };
        r.chat.push(msg);
        io.to(code).emit('game:chatMessage', msg);
        recordMorticianClueForBots(r, latestClue);
      }
    }, 2500 + Math.random() * 2500);
  }

  // 2) Rahibe Bot: mentions tarot sighting if found active
  const rahibeBot = livingBots.find(p => p.role === ROLES.RAHIBE);
  if (rahibeBot && room.rahibeTarots && room.rahibeTarots.length > 0) {
    const latestTarot = room.rahibeTarots[room.rahibeTarots.length - 1];
    if (latestTarot && latestTarot.targetActed && latestTarot.round === room.round) {
      setTimeout(() => {
        const r = rooms[code];
        if (!r || r.phase !== PHASES.DAY) return;
        const tarotPhrases = {
          tr: `Kutsal Tarot kartları dün gece "${latestTarot.targetName}" adlı köylünün karanlıkta hareket ettiğini fısıldadı...`,
          en: `The Holy Tarot cards whispered that "${latestTarot.targetName}" was moving in the shadows last night...`,
          ja: `聖なるタロットが、昨夜「${latestTarot.targetName}」が闇で動いていたと告げています...`,
          de: `Das Heilige Tarot flüsterte, dass "${latestTarot.targetName}" letzte Nacht in den Schatten aktiv war...`,
          es: `El Santo Tarot susurró que "${latestTarot.targetName}" se movía en las sombras anoche...`,
          fr: `Le Saint Tarot a murmuré que "${latestTarot.targetName}" s'agitait dans l'ombre la nuit dernière...`,
        };
        const phrase = tarotPhrases[lang] || tarotPhrases.tr;
        const msg = {
          name: rahibeBot.name,
          message: phrase,
          translations: tarotPhrases,
          isBot: true,
          time: Date.now(),
        };
        r.chat.push(msg);
        io.to(code).emit('game:chatMessage', msg);
      }, 5000 + Math.random() * 3000);
    }
  }

  // 3) Kukla Bot Chameleon & Deception Routine (Dedicated)
  if (kuklaBot && Math.random() < 0.85) {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.DAY || !kuklaBot.alive) return;

      const otherLiving = r.players.filter(p => p.alive && p.id !== kuklaBot.id && p.id !== r.sfId);
      if (!otherLiving.length) return;

      // Find top suspicion target among innocents to frame / jump on
      const scored = otherLiving.map(p => ({ p, score: getBotSuspicion(r, kuklaBot, p) })).sort((a, b) => b.score - a.score);
      const topTarget = scored[0]?.p || otherLiving[0];

      const kuklaChameleonPhrases = {
        tr: [
          `Ben de ${topTarget.name}'in hareketlerini çok şüpheli buluyorum, bence ona odaklanmalıyız.`,
          `Köydeki haini yakalamak için acele etmeliyiz, benim oyum ${topTarget.name}'e gidebilir.`,
          `Dünkü olaylara bakılırsa ${topTarget.name} bir şeyler saklıyor gibi görünüyor.`,
          `Masumları korumak için dikkatli olmalıyız, şüpheleri doğru yönlendirelim.`,
        ],
        en: [
          `I also find ${topTarget.name}'s behavior very suspicious, we should focus on them.`,
          `We need to catch the traitor quickly, my vote might go to ${topTarget.name}.`,
          `Looking at yesterday's events, ${topTarget.name} seems to be hiding something.`,
          `We must be careful to protect innocents, let's direct our suspicions wisely.`,
        ],
        ja: [
          `私も${topTarget.name}の行動は怪しいと思います。そこに注目すべきです。`,
          `裏切り者を早く捕まえる必要があります。私は${topTarget.name}に入れるかもしれません。`,
          `昨日の出来事からすると、${topTarget.name}は何かを隠しているように見えます。`,
          `無実の村人を守るため、慎重に推理を進めましょう。`,
        ],
        de: [
          `Ich finde das Verhalten von ${topTarget.name} ebenfalls verdächtig, wir sollten uns darauf konzentrieren.`,
          `Wir müssen den Verräter schnell fassen, meine Stimme könnte an ${topTarget.name} gehen.`,
          `Nach den gestrigen Ereignissen scheint ${topTarget.name} etwas zu verbergen.`,
          `Wir müssen vorsichtig sein, um die Unschuldigen zu schützen.`,
        ],
        es: [
          `También encuentro muy sospechoso a ${topTarget.name}, deberíamos enfocarnos en él.`,
          `Debemos atrapar al traidor pronto, mi voto podría ser para ${topTarget.name}.`,
          `Viendo lo de ayer, parece que ${topTarget.name} oculta algo.`,
          `Tengamos cuidado para proteger a los inocentes.`,
        ],
        fr: [
          `Je trouve aussi le comportement de ${topTarget.name} très suspect, concentrons-nous sur lui.`,
          `Il faut vite démasquer le traître, je pourrais voter contre ${topTarget.name}.`,
          `D'après les événements d'hier, ${topTarget.name} semble cacher quelque chose.`,
          `Soyons prudents pour protéger les innocents.`,
        ],
      };

      const phraseIdx = Math.floor(Math.random() * kuklaChameleonPhrases.tr.length);
      const translations = {
        tr: kuklaChameleonPhrases.tr[phraseIdx],
        en: kuklaChameleonPhrases.en[phraseIdx],
        ja: kuklaChameleonPhrases.ja[phraseIdx],
        de: kuklaChameleonPhrases.de[phraseIdx],
        es: kuklaChameleonPhrases.es[phraseIdx],
        fr: kuklaChameleonPhrases.fr[phraseIdx],
      };
      const msgObj = {
        name: kuklaBot.name,
        message: translations[lang] || translations.tr,
        translations,
        isBot: true,
        time: Date.now(),
      };
      r.chat.push(msgObj);
      io.to(code).emit('game:chatMessage', msgObj);
    }, 7000 + Math.random() * 5000);
  }

  // 4) Town / General Discussion bots (2 to 4 bots active per day)
  const chatCandidates = livingBots.filter(p => (isSecretSF || p.id !== room.sfId) && p.id !== room.kuklaId);
  if (chatCandidates.length === 0) return;

  const chatterCount = Math.min(chatCandidates.length, Math.floor(2 + Math.random() * 2));
  const shuffledChatters = shuffle([...chatCandidates]).slice(0, chatterCount);

  shuffledChatters.forEach((chatter, idx) => {
    setTimeout(() => {
      const r = rooms[code];
      if (!r || r.phase !== PHASES.DAY || !chatter.alive) return;

      const otherLiving = r.players.filter(p => p.alive && p.id !== chatter.id && (isSecretSF || p.id !== r.sfId));
      if (!otherLiving.length) return;

      const scored = otherLiving.map(p => ({ p, score: getBotSuspicion(r, chatter, p) })).sort((a, b) => b.score - a.score);
      const topSuspect = scored[0]?.p;

      let phraseDict = null;
      let phraseIdx = 0;

      // A) If chatter was voted in previous round, defend self
      const lastVoteHistory = r.voteHistory?.[r.voteHistory.length - 1];
      const votesOnMe = lastVoteHistory ? Object.values(lastVoteHistory.votes || {}).filter(v => v === chatter.id).length : 0;

      if (votesOnMe >= 2 && Math.random() < 0.7) {
        phraseDict = {
          tr: ['Ben masumum, köy için faydalı olmaya çalışıyorum!', 'Oylarınızı bende harcamayın, gerçek şüphelilere odaklanalım.', 'Bana iftira atılıyor, dün gece hiçbir şey yapmadım!'],
          en: ['I am innocent, trying to help the village!', 'Do not waste your votes on me, focus on the real suspects.', 'I am being framed, I did nothing last night!'],
          ja: ['私は無実です！村のために尽くしています！', '私に票を無駄遣いしないで、真の容疑者に目を向けましょう。', '濡れ衣を着せられています、昨夜は何もしませんでした！'],
          de: ['Ich bin unschuldig und versuche dem Dorf zu helfen!', 'Verschwendet eure Stimmen nicht an mich, sucht die echten Verdächtigen.', 'Man hängt mir etwas an, ich habe letzte Nacht nichts getan!'],
          es: ['¡Soy inocente, intento ayudar a la aldea!', 'No desperdicien sus votos en mí, miren a los verdaderos sospechosos.', '¡Me están incriminando, no hice nada anoche!'],
          fr: ['Je suis innocent, j\'essaie d\'aider le village !', 'Ne gaspillez pas vos votes sur moi, cherchez les vrais coupables.', 'On me tend un piège, je n\'ai rien fait la nuit dernière !'],
        };
        phraseIdx = Math.floor(Math.random() * phraseDict.tr.length);
      } else if (topSuspect && topSuspect.score >= 45) {
        // B) Point out top suspect
        phraseDict = {
          tr: [`${topSuspect.name} hakkında ciddi şüphelerim var, dikkatle dinlemeliyiz.`, `Bence ${topSuspect.name}'in hareketleri güven vermiyor.`, `${topSuspect.name} dünkü olaylarda çok sessizdi.`],
          en: [`I have strong suspicions about ${topSuspect.name}, we must watch closely.`, `I think ${topSuspect.name}'s behavior is untrustworthy.`, `${topSuspect.name} was too quiet during yesterday's events.`],
          ja: [`${topSuspect.name}には強い疑いがあります。警戒が必要です。`, `${topSuspect.name}の行動は怪しいと思います。`, `${topSuspect.name}は昨日の出来事で静かすぎました。`],
          de: [`Ich habe starken Verdacht gegen ${topSuspect.name}, wir müssen aufpassen.`, `Ich finde das Verhalten von ${topSuspect.name} verdächtig.`, `${topSuspect.name} war gestern viel zu still.`],
          es: [`Tengo fuertes sospechas sobre ${topSuspect.name}, debemos vigilar.`, `Creo que el comportamiento de ${topSuspect.name} no inspira confianza.`, `${topSuspect.name} estuvo demasiado callado ayer.`],
          fr: [`J'ai de sérieux doutes sur ${topSuspect.name}, soyons vigilants.`, `Le comportement de ${topSuspect.name} me semble suspect.`, `${topSuspect.name} était bien trop discret hier.`],
        };
        phraseIdx = Math.floor(Math.random() * phraseDict.tr.length);
      } else {
        // C) General village discussion
        phraseDict = {
          tr: ['İpuçlarını dikkatlice incelemeliyiz, hata yapma şansımız kalmadı.', 'Kuklanın kim olduğunu bulmak için dünkü oylara bakmalıyız.', 'Köydeki herkes sessizliğini bozmalı, kimseye körü körüne güvenemeyiz.'],
          en: ['We must examine the clues carefully, no room for mistakes.', 'We should analyze yesterday\'s votes to find the puppet.', 'Everyone must speak up, blind trust will ruin us.'],
          ja: ['手がかりを慎重に調べるべきです。ミスは許されません。', '昨日の投票を見直して黒幕を見つけるべきです。', '全員が発言すべきです。盲目的な信頼は命取りです。'],
          de: ['Wir müssen die Hinweise genau prüfen, keine Fehler erlaubt.', 'Wir sollten die gestrigen Stimmen analysieren, um die Puppe zu finden.', 'Jeder muss sich äußern, blindes Vertrauen bringt uns um.'],
          es: ['Debemos revisar las pistas con cuidado, no hay margen de error.', 'Deberíamos analizar los votos de ayer para hallar a la marioneta.', 'Todos deben hablar, la confianza ciega nos destruirá.'],
          fr: ['Examinons bien les indices, aucune erreur n\'est permise.', 'Analysons les votes d\'hier pour démasquer la marionnette.', 'Chacun doit s\'exprimer, la confiance aveugle nous perdra.'],
        };
        phraseIdx = Math.floor(Math.random() * phraseDict.tr.length);
      }

      if (phraseDict) {
        const translations = {
          tr: phraseDict.tr[phraseIdx],
          en: phraseDict.en[phraseIdx],
          ja: phraseDict.ja[phraseIdx],
          de: phraseDict.de[phraseIdx],
          es: phraseDict.es[phraseIdx],
          fr: phraseDict.fr[phraseIdx],
        };
        const msgObj = {
          name: chatter.name,
          message: translations[lang] || translations.tr,
          translations,
          isBot: true,
          time: Date.now(),
        };
        r.chat.push(msgObj);
        io.to(code).emit('game:chatMessage', msgObj);
      }
    }, 11000 + idx * 5000 + Math.random() * 4000);
  });
}

// ─────────────────────────────────────────────
// PHASE ENGINE
// ─────────────────────────────────────────────
function startPhase(code, phase) {
  try {
    const room = rooms[code];
    if (!room) return;
    clearTimer(room);
    room.phase = phase;
    room.nightActions = {};
    room.votes = {};
    room.readyPlayers = {};

    let duration = PHASE_DURATIONS[phase] ?? 8;

    if (phase === PHASES.NIGHT) duration = room.settings.nightDuration || 30;
    if (phase === PHASES.DAY) duration = room.settings.dayDuration || 90;
    if (phase === PHASES.VOTE) duration = room.settings.voteDuration || 30;

    room.timerEndsAt = Date.now() + duration * 1000;

    broadcastState(code);
    broadcastReadyUpdate(room);
    scheduleBotActions(code);

    room.timer = setTimeout(() => {
      try {
        handlePhaseEnd(code, phase);
      } catch (err) {
        console.error(`[Error in handlePhaseEnd for ${phase}]:`, err);
      }
    }, duration * 1000);
  } catch (err) {
    console.error(`[Error in startPhase for ${phase}]:`, err);
  }
}

function broadcastReadyUpdate(room) {
  if (!room) return;
  const activeLiving = room.players.filter(p => p.alive && !p.disconnected);
  const readyCount = activeLiving.filter(p => !!room.readyPlayers?.[p.id]).length;
  const totalRequired = activeLiving.length;
  io.to(room.code).emit('room:readyUpdate', {
    readyCount,
    totalRequired,
    readyPlayers: room.readyPlayers || {},
  });
}

function setPlayerReady(room, socketId, isReady) {
  if (!room) return;
  if (!room.readyPlayers) room.readyPlayers = {};
  room.readyPlayers[socketId] = !!isReady;
  broadcastReadyUpdate(room);
  checkAllReady(room);
}

function checkAllReady(room) {
  if (!room || room.phase === PHASES.LOBBY || room.phase === PHASES.ENDED) return;
  const activeLiving = room.players.filter(p => p.alive && !p.disconnected);
  if (activeLiving.length === 0) return;
  const allReady = activeLiving.every(p => !!room.readyPlayers?.[p.id]);
  if (allReady) {
    clearTimer(room);
    handlePhaseEnd(room.code, room.phase);
  }
}

function handlePhaseEnd(code, phase) {
  const room = rooms[code];
  if (!room || room.phase !== phase) return;

  switch (phase) {
    case PHASES.NIGHT0:
      handleNight0End(code);
      break;
    case PHASES.NIGHT:
      handleNightEnd(code);
      break;
    case PHASES.DAWN:
      startPhase(code, PHASES.DAY);
      break;
    case PHASES.DAY:
      startPhase(code, PHASES.VOTE);
      break;
    case PHASES.VOTE:
      handleVoteEnd(code);
      break;
    case PHASES.RESULT:
      room.round++;
      startPhase(code, PHASES.NIGHT);
      break;
  }
}

// ─────────────────────────────────────────────
// NIGHT 0 — SF picks puppet
// ─────────────────────────────────────────────
function handleNight0End(code) {
  const room = rooms[code];
  if (!room) return;

  // Gece 0'da kukla seçilmediyse ZORUNLU olarak rastgele yaşayan bir oyuncu kukla yapılır
  if (!room.kuklaId) {
    const candidates = room.players.filter(p => p.alive && p.id !== room.sfId);
    if (candidates.length > 0) {
      const autoKukla = candidates[Math.floor(Math.random() * candidates.length)];
      room.kuklaId = autoKukla.id;
      autoKukla.isKukla = true;
      if (!room.kuklaHistory) room.kuklaHistory = [];
      if (!room.kuklaHistory.includes(autoKukla.id)) room.kuklaHistory.push(autoKukla.id);
      room.newKuklaJustSet = false;
      if (!autoKukla.isBot) {
        io.to(autoKukla.id).emit('game:becomeKukla', {
          baseRole: autoKukla.role,
          message: room.language === 'tr'
            ? `Gece 0 bitti — Mr. Schadenfreude sizi kuklası olarak seçti! (${roleLabel(autoKukla.role, room.language)})`
            : `Night 0 ended — Mr. Schadenfreude has chosen you as his puppet! (${roleLabel(autoKukla.role, room.language)})`,
        });
      }
      addAnnouncement(room, room.language === 'tr'
        ? 'Mr. Schadenfreude karanlıkta kuklasını seçti.'
        : 'Mr. Schadenfreude has chosen his puppet in the dark.');
    }
  }

  room.round = 1;
  startPhase(code, PHASES.NIGHT);
}

// ─────────────────────────────────────────────
// NIGHT — actions resolve
// ─────────────────────────────────────────────
function handleNightEnd(code) {
  const room = rooms[code];
  const lang = room.language;
  room.pendingDeaths = [];
  const announcements = [];
  const actions = room.nightActions;
  const isSecretSF = room.settings?.gameMode === 'secretKiller';

  // Şövalye protection & challenge
  const sovalyeProtected = actions.sovalye_protect || null;
  const sovalyeChallenge = actions.sovalye_challenge || null;

  // Determine kill target based on mode
  let targetToKill = null;
  if (isSecretSF) {
    targetToKill = actions.sf_target && actions.sf_target !== 'none' ? actions.sf_target : null;
  } else {
    targetToKill = actions.kukla_kill || (!actions.kukla_refused && actions.sf_target && actions.sf_target !== 'none' ? actions.sf_target : null);
  }

  // Şövalye challenge (directly stops the night kill order)
  if (sovalyeChallenge) {
    targetToKill = null;
    const sovalyePlayer = room.players.find(p => p.role === ROLES.SOVALYE);
    if (sovalyePlayer) {
      io.to(sovalyePlayer.id).emit('private:message', {
        type: 'success',
        message: lang === 'tr'
          ? '⚔️ Karanlığa meydan okudun ve infazı engelledin. Gece kayıpsız geçti.'
          : '⚔️ You challenged the darkness and thwarted the execution. The night passed without loss.',
      });
    }
  }

  // Resolve night kill
  if (actions.kukla_refused || (isSecretSF && actions.sf_target === 'none')) {
    announcements.push(makeAnnouncement('peaceful', {
      tr: 'Bu gece hiçbir çığlık duyulmadı... Karanlık el geriye çekildi.',
      en: 'No screams were heard tonight... The dark hand pulled back.',
      ja: '今夜は悲鳴が聞こえなかった… 闇の手は引いた。',
      de: 'Keine Schreie wurden heute Nacht gehört... Die dunkle Hand zog sich zurück.',
      es: 'No se escucharon gritos esta noche... La mano oscura retrocedió.',
      fr: 'Aucun cri n\'a été entendu cette nuit... La main sombre s\'est retirée.',
    }));
  } else if (targetToKill) {
    const target = getPlayer(room, targetToKill);
    if (target && target.alive) {
      // Protected by Şövalye?
      if (sovalyeProtected && sovalyeProtected === targetToKill) {
        recordKnightShieldSaveForBots(room, target);
        announcements.push(makeAnnouncement('blocked', {
          tr: 'Bu gece karanlık bir el uzandı — ama biri onu engelledi.',
          en: 'A dark hand reached out tonight — but someone blocked it.',
          ja: '今夜闇の手が伸びたが、何者かがそれを阻止した。',
          de: 'Eine dunkle Hand streckte sich aus — aber jemand hielt sie auf.',
          es: 'Una mano oscura se extendió esta noche, pero alguien la bloqueó.',
          fr: 'Une main sombre s\'est tendue cette nuit — mais quelqu\'un l\'a arrêtée.',
        }));
      } else {
        // Madman curse?
        if (target.role === ROLES.MADMAN) {
          killPlayer(room, target, 'night', announcements, lang);
          // Curse: killer dies next dawn
          if (isSecretSF) {
            room.pendingDeaths.push({ id: room.sfId, cause: 'madman_curse' });
          } else {
            room.pendingDeaths.push({ id: room.kuklaId, cause: 'madman_curse' });
          }
        } else {
          killPlayer(room, target, 'night', announcements, lang);
        }
      }
    }
  }

  // Mortisyen surveillance resolution
  const mortMode = actions.mortisyen_mode;
  const mortTargetId = actions.mortisyen_target;
  const mortPlayer = getPlayer(room, room.mortisyen);
  if (mortMode === 'surveillance' && mortTargetId && mortPlayer && mortPlayer.alive) {
    const mortTarget = getPlayer(room, mortTargetId);
    if (mortTarget) {
      let targetActed = false;
      if (mortTarget.role === ROLES.SOVALYE && (actions.sovalye_protect || actions.sovalye_challenge)) {
        targetActed = true;
      } else if (mortTarget.role === ROLES.RAHIBE && actions.rahibe_target) {
        targetActed = true;
      } else if (mortTarget.id === room.kuklaId && !actions.kukla_refused && targetToKill) {
        targetActed = true;
      } else if (mortTarget.id === room.sfId && isSecretSF && actions.sf_target && actions.sf_target !== 'none') {
        targetActed = true;
      }

      const isTargetKilled = targetToKill && mortTarget.id === targetToKill;
      let survType = 'info';

      let nameA = '';
      let nameB = '';
      let suspectsList = [];

      if (isTargetKilled) {
        survType = 'warning';
        const framedId = actions.sf_frame;
        const actualKillerId = framedId || (isSecretSF ? room.sfId : (room.kuklaId || room.sfId));
        const killerPlayer = getPlayer(room, actualKillerId);
        const killerName = killerPlayer?.name || 'Biri';

        const decoys = room.players.filter(p => p.alive && p.id !== mortTarget.id && p.id !== room.mortisyen && p.id !== actualKillerId);
        let decoyName = 'Biri';
        if (decoys.length > 0) {
          decoyName = decoys[Math.floor(Math.random() * decoys.length)].name;
        } else {
          const anyOther = room.players.filter(p => p.id !== mortTarget.id && p.id !== actualKillerId);
          decoyName = anyOther.length > 0 ? anyOther[0].name : 'Gölge';
        }

        const pair = Math.random() < 0.5 ? [killerName, decoyName] : [decoyName, killerName];
        nameA = pair[0];
        nameB = pair[1];
        suspectsList = [nameA, nameB];
      } else if (targetActed) {
        survType = 'warning';
        suspectsList = [mortTarget.name];
      } else {
        survType = 'confirm';
        suspectsList = [];
      }

      const survTranslations = {
        tr: isTargetKilled
          ? `⚡ Suçüstü Tanıklığı: ${mortTarget.name} bu gece saldırıya uğradı! Kaçan siluet "${nameA}" ya da "${nameB}" gibi görünüyordu.`
          : targetActed
            ? `⚠️ Gece Hareketi: ${mortTarget.name} bu gece karanlıkta hareket halindeydi.`
            : `🛡️ Hareketsiz: ${mortTarget.name} gece boyunca tamamen hareketsizdi ve sessizce uyudu.`,
        en: isTargetKilled
          ? `⚡ Witnessed: ${mortTarget.name} was attacked tonight! The fleeing silhouette looked like "${nameA}" or "${nameB}".`
          : targetActed
            ? `⚠️ Night Activity: ${mortTarget.name} was active in the dark tonight.`
            : `🛡️ Inactive: ${mortTarget.name} remained completely quiet and undisturbed through the night.`,
        ja: isTargetKilled
          ? `⚡ 現場目撃: ${mortTarget.name}が今夜襲撃された！逃げ去る影は「${nameA}」か「${nameB}」のように見えた。`
          : targetActed
            ? `⚠️ 夜の活動: ${mortTarget.name}は今夜闇の中で活動していた。`
            : `🛡️ 静寂確認: ${mortTarget.name}は夜の間静かに眠っていた。`,
        de: isTargetKilled
          ? `⚡ Auf frischer Tat: ${mortTarget.name} wurde heute Nacht angegriffen! Die fliehende Gestalt sah aus wie "${nameA}" oder "${nameB}".`
          : targetActed
            ? `⚠️ Nachtaktivität: ${mortTarget.name} war heute Nacht in der Dunkelheit aktiv.`
            : `🛡️ Inaktiv: ${mortTarget.name} schlief die ganze Nacht friedlich und ruhig.`,
        es: isTargetKilled
          ? `⚡ Testigo directo: ¡${mortTarget.name} fue atacado esta noche! La silueta que huía se parecía a "${nameA}" o "${nameB}".`
          : targetActed
            ? `⚠️ Actividad nocturna: ${mortTarget.name} estuvo activo en la oscuridad esta noche.`
            : `🛡️ Inactivo: ${mortTarget.name} permaneció en silencio y durmió tranquilamente.`,
        fr: isTargetKilled
          ? `⚡ Témoignage direct : ${mortTarget.name} a été attaqué cette nuit ! La silhouette en fuite ressemblait à "${nameA}" ou "${nameB}".`
          : targetActed
            ? `⚠️ Activité nocturne : ${mortTarget.name} était actif dans l'obscurité cette nuit.`
            : `🛡️ Inactif : ${mortTarget.name} est resté paisible et a dormi tranquillement toute la nuit.`,
      };

      const survClueObj = {
        id: 'surv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        name: mortTarget.name,
        role: lang === 'tr' ? 'Gözetim Raporu' : 'Surveillance Report',
        clue: survTranslations[lang] || survTranslations.tr,
        evidenceType: survType,
        isSurveillance: true,
        suspects: suspectsList,
        translations: survTranslations,
        roleTranslations: {
          tr: 'Gözetim Raporu',
          en: 'Surveillance Report',
          ja: '監視報告',
          de: 'Überwachungsbericht',
          es: 'Informe de Vigilancia',
          fr: 'Rapport de Surveillance',
        }
      };
      if (!room.mortisyenClues) room.mortisyenClues = [];
      room.mortisyenClues.push(survClueObj);
      recordMorticianClueForBots(room, survClueObj);
      io.to(room.mortisyen).emit('private:clue', survClueObj);
    }
  }

  // Rahibe Tarot / Gece Hareketi resolution & Cooldown management
  const rahibeTargetId = actions.rahibe_target;
  const rahibePlayer = room.players.find(p => p.role === ROLES.RAHIBE && p.alive);
  if (rahibeTargetId && rahibePlayer && room.rahibeTarotAvailable) {
    room.rahibeLastTarotRound = room.round;
    room.rahibeTarotAvailable = false; // Next round will be on cooldown (0)
    const rahibeTarget = getPlayer(room, rahibeTargetId);
    if (rahibeTarget) {
      let targetActed = false;
      if (rahibeTarget.role === ROLES.SOVALYE && (actions.sovalye_protect || actions.sovalye_challenge)) {
        targetActed = true;
      } else if (rahibeTarget.role === ROLES.MORTISYEN && (actions.mortisyen_mode === 'surveillance' || actions.mortisyen_mode === 'forensics')) {
        targetActed = true;
      } else if (rahibeTarget.id === room.kuklaId && !actions.kukla_refused && targetToKill) {
        targetActed = true;
      } else if (rahibeTarget.id === room.sfId && isSecretSF && actions.sf_target && actions.sf_target !== 'none') {
        targetActed = true;
      }

      const tarotObj = {
        round: room.round,
        targetName: rahibeTarget.name,
        targetActed,
        message: targetActed
          ? `🃏 Kutsal Tarot: "${rahibeTarget.name}" bu gece karanlıkta hareket halindeydi.`
          : `🕯️ Kutsal Tarot: "${rahibeTarget.name}" bu gece sessizce ve derin bir uykudaydı.`,
        translations: {
          tr: targetActed
            ? `🃏 Kutsal Tarot: "${rahibeTarget.name}" bu gece karanlıkta hareket halindeydi.`
            : `🕯️ Kutsal Tarot: "${rahibeTarget.name}" bu gece sessizce ve derin bir uykudaydı.`,
          en: targetActed
            ? `🃏 Holy Tarot: "${rahibeTarget.name}" was active in the shadows tonight.`
            : `🕯️ Holy Tarot: "${rahibeTarget.name}" slept peacefully through the night.`,
          ja: targetActed
            ? `🃏 聖なるタロット：「${rahibeTarget.name}」は今夜、闇の中で活動していた。`
            : `🕯️ 聖なるタロット：「${rahibeTarget.name}」は今夜、静かに眠っていた。`,
          de: targetActed
            ? `🃏 Heiliges Tarot: "${rahibeTarget.name}" war heute Nacht in den Schatten aktiv.`
            : `🕯️ Heiliges Tarot: "${rahibeTarget.name}" schlief heute Nacht friedlich.`,
          es: targetActed
            ? `🃏 Santo Tarot: "${rahibeTarget.name}" estuvo activo en las sombras esta noche.`
            : `🕯️ Santo Tarot: "${rahibeTarget.name}" durmió plácidamente esta noche.`,
          fr: targetActed
            ? `🃏 Saint Tarot : "${rahibeTarget.name}" était actif dans l'ombre cette nuit.`
            : `🕯️ Saint Tarot : "${rahibeTarget.name}" a dormi paisiblement cette nuit.`,
        }
      };

      if (!room.rahibeTarots) room.rahibeTarots = [];
      room.rahibeTarots.push(tarotObj);
      recordRahibeTarotForBots(room, rahibeTarget, targetActed);

      io.to(rahibePlayer.id).emit('private:tarot', tarotObj);
      io.to(rahibePlayer.id).emit('private:message', {
        type: targetActed ? 'warning' : 'confirm',
        message: tarotObj.translations[lang] || tarotObj.translations.tr,
      });
    }
  } else {
    // If Rahibe did not draw tarot this round
    if (room.rahibeLastTarotRound === room.round - 1) {
      // Cooldown round completed -> Ready for next round (1)
      room.rahibeTarotAvailable = true;
    }
    // If rahibeTarotAvailable was already true (and skipped/passed), it carries over as true (1)!
  }

  room.announcements = announcements;

  // Check win after night deaths before transitioning
  const nightWin = checkWin(room);
  if (nightWin) {
    endGame(code, nightWin.winner, nightWin.reason);
    return;
  }

  startDawn(code);
}

function killPlayer(room, player, cause, announcements, lang) {
  if (player.id === room.kuklaId) {
    player.role = ROLES.KUKLA;
  }
  player.alive = false;
  player.deathRound = room.round;
  player.deathCause = cause;

  // Rahibe: first death announcement
  const rahibe = room.players.find(p => p.id === room.rahibe && p.alive);
  if (rahibe && !room.firstDeathAnnounced && cause === 'night') {
    room.firstDeathAnnounced = true;
    announcements.push(makeAnnouncement('rahibe_reveal', {
      tr: `Rahibe'nin sesi titredi: "${player.name}" bir ${roleLabel(player.role, 'tr')} idi.`,
      en: `The Priest's voice trembled: "${player.name}" was a ${roleLabel(player.role, 'en')}.`,
      ja: `司祭の声が震えた：「${player.name}」は${roleLabel(player.role, 'ja')}だった。`,
      de: `Die Stimme der Nonne zitterte: "${player.name}" war ein ${roleLabel(player.role, 'de')}.`,
      es: `La voz de la Monja tembló: "${player.name}" era un ${roleLabel(player.role, 'es')}.`,
      fr: `La voix du Prêtre trembla : "${player.name}" était un ${roleLabel(player.role, 'fr')}.`,
    }));
  } else {
    announcements.push(makeAnnouncement('death', {
      tr: `"${player.name}" bu gece hayatını kaybetti.`,
      en: `"${player.name}" lost their life tonight.`,
      ja: `「${player.name}」は今夜命を落とした。`,
      de: `"${player.name}" verlor diese Nacht ihr Leben.`,
      es: `"${player.name}" perdió la vida esta noche.`,
      fr: `"${player.name}" a perdu la vie cette nuit.`,
    }));
  }

  // Mortisyen: private actionable clue (only if mortisyen is alive and not the victim)
  const mortPlayer = getPlayer(room, room.mortisyen);
  if (mortPlayer && mortPlayer.alive && room.mortisyen !== player.id) {
    const isDeep = room.nightActions.mortisyen_mode !== 'surveillance';
    const clueObj = generateMortisianClue(room, player, isDeep);
    if (!room.mortisyenClues) room.mortisyenClues = [];
    room.mortisyenClues.push(clueObj);
    recordMorticianClueForBots(room, clueObj);
    io.to(room.mortisyen).emit('private:clue', clueObj);
  }

  // Check if dead player was kukla
  if (player.id === room.kuklaId) {
    handleKuklaDeathAfterKill(room, cause, announcements, lang);
  }
}

function handleKuklaDeathAfterKill(room, cause, announcements, lang) {
  // Kukla just died — check SF's situation
  if (room.kuklaId) {
    const deadKukla = getPlayer(room, room.kuklaId);
    if (deadKukla) deadKukla.isKukla = true;
    if (!room.kuklaHistory) room.kuklaHistory = [];
    if (!room.kuklaHistory.includes(room.kuklaId)) room.kuklaHistory.push(room.kuklaId);
  }
  room.previousKuklaId = room.kuklaId;
  room.kuklaId = null; // Null out dead kukla slot
  room.consecutiveInnocentLynches = 0; // Reset counter
}

// ─────────────────────────────────────────────
// DAWN — resolve pending deaths, broadcast
// ─────────────────────────────────────────────
function startDawn(code) {
  const room = rooms[code];
  // Resolve Madman curse
  if (room.pendingDeaths.length > 0) {
    const lang = room.language;
    for (const death of room.pendingDeaths) {
      if (death.cause === 'madman_curse') {
        const target = getPlayer(room, death.id);
        if (target && target.alive) {
          target.alive = false;
          target.deathRound = room.round;
          target.deathCause = 'madman_curse';
          room.announcements.push(makeAnnouncement('curse', {
            tr: `"${target.name}" sabaha ulaşamadı. Deli'nin laneti onu buldu.`,
            en: `"${target.name}" did not make it to morning. The Madman's curse found them.`,
            ja: `「${target.name}」は朝を迎えられなかった。狂人の呪いが届いた。`,
            de: `"${target.name}" erlebte den Morgen nicht. Der Fluch des Verrückten traf sie.`,
            es: `"${target.name}" no llegó a la mañana. La maldición del Demente los alcanzó.`,
            fr: `"${target.name}" n'a pas vu le matin. La malédiction du Fou les a frappés.`,
          }));

          if (room.mortisyen) {
            const clueObj = generateMortisianClue(room, target);
            if (!room.mortisyenClues) room.mortisyenClues = [];
            room.mortisyenClues.push(clueObj);
            io.to(room.mortisyen).emit('private:clue', clueObj);
          }

          // If kukla died from curse
          if (target.id === room.previousKuklaId || target.role === ROLES.KUKLA) {
            handleKuklaDeathAfterKill(room, 'madman_curse', room.announcements, lang);
            const win = checkWin(room);
            if (win) {
              endGame(code, win.winner, win.reason);
              room.pendingDeaths = [];
              return; // Game ended, don't proceed to DAWN
            }
          }
        }
      }
    }
    room.pendingDeaths = [];
  }
  startPhase(code, PHASES.DAWN);
}

// ─────────────────────────────────────────────
// VOTE / LYNCH
// ─────────────────────────────────────────────
function handleVoteEnd(code) {
  const room = rooms[code];
  const lang = room.language;

  const tally = {};
  for (const [voter, target] of Object.entries(room.votes)) {
    if (!tally[target]) tally[target] = 0;
    tally[target]++;
  }

  let maxVotes = 0;
  let lynchId = null;
  for (const [id, count] of Object.entries(tally)) {
    if (count > maxVotes) { maxVotes = count; lynchId = id; }
  }

  // Tie → no lynch
  const topCount = Object.values(tally).filter(v => v === maxVotes).length;
  if (topCount > 1) lynchId = null;

  if (!room.voteHistory) room.voteHistory = [];
  room.voteHistory.push({
    round: room.round,
    votes: { ...room.votes },
    lynchId: lynchId,
  });

  if (!lynchId) {
    room.announcements = [makeAnnouncement('no_lynch', {
      tr: 'Halk bir karara varamadı. Bu gün kayıpsız geçti.',
      en: 'The people could not decide. This day passed without a verdict.',
      ja: '村人は決断を下せなかった。この日は処刑なしで終わった。',
      de: 'Das Volk konnte sich nicht entscheiden. Der Tag verging ohne Urteil.',
      es: 'El pueblo no pudo decidir. Este día pasó sin veredicto.',
      fr: 'Le peuple n\'a pas pu trancher. Cette journée s\'est achevée sans verdict.',
    })];
    startPhase(code, PHASES.RESULT);
    return;
  }

  const lynched = getPlayer(room, lynchId);
  if (!lynched || !lynched.alive) {
    startPhase(code, PHASES.RESULT);
    return;
  }

  const isSecretSF = room.settings?.gameMode === 'secretKiller';

  // SF execution handling based on mode
  if (lynched.id === room.sfId) {
    if (isSecretSF) {
      // In Secret Killer mode, lynching SF is an immediate VILLAGERS WIN!
      lynched.alive = false;
      lynched.deathRound = room.round;
      lynched.deathCause = 'lynch';
      room.announcements = [makeAnnouncement('lynch', {
        tr: `🎭 "${lynched.name}" asıldı! Aranızdaki gizli Mr. Schadenfreude oydu! Köylüler kazandı!`,
        en: `🎭 "${lynched.name}" was executed! They were Mr. Schadenfreude! Villagers win!`,
        ja: `🎭「${lynched.name}」が処刑された！潜んでいたMr.シャーデンフロイデだった！村人の勝利！`,
        de: `🎭 "${lynched.name}" wurde hingerichtet! Sie waren Mr. Schadenfreude! Dorfbewohner gewinnen!`,
        es: `🎭 ¡"${lynched.name}" fue ejecutado! ¡Era el Mr. Schadenfreude secreto! ¡Los aldeanos ganan!`,
        fr: `🎭 "${lynched.name}" a été exécuté ! C'était Mr. Schadenfreude ! Les villageois gagnent !`,
      })];
      endGame(code, 'villagers', lang === 'tr'
        ? 'Mr. Schadenfreude halk tarafından asıldı. Köylüler kazandı!'
        : 'Mr. Schadenfreude was executed by the people. Villagers win!');
      return;
    } else {
      // In Puppet Master mode, SF is immortal
      room.announcements = [makeAnnouncement('immortal', {
        tr: `Halk ${lynched.name}'i idam etmeye çalıştı — ama ona dokunamadılar. Güldü.`,
        en: `The people tried to execute ${lynched.name} — but could not touch them. He laughed.`,
        ja: `村人は${lynched.name}を処刑しようとしたが、触れることすらできなかった。彼は笑った。`,
        de: `Das Volk versuchte ${lynched.name} hinzurichten — aber sie konnten ihn nicht berühren. Er lachte.`,
        es: `El pueblo intentó ejecutar a ${lynched.name} — pero no pudieron tocarlo. Se rió.`,
        fr: `Le peuple a tenté d'exécuter ${lynched.name} — mais nul n'a pu le toucher. Il a ri.`,
      })];
      startPhase(code, PHASES.RESULT);
      return;
    }
  }

  // Lynch kukla → SF loses if no new kukla right
  const isKukla = lynched.id === room.kuklaId;
  lynched.alive = false;
  lynched.deathRound = room.round;
  lynched.deathCause = 'lynch';

  recordLynchResultForBots(room, lynched, room.votes);

  const announcements = [];

  // Rahibe: first lynch reveal
  const rahibe = room.players.find(p => p.id === room.rahibe && p.alive);
  if (rahibe && !room.firstLynchAnnounced) {
    room.firstLynchAnnounced = true;
    announcements.push(makeAnnouncement('rahibe_reveal', {
      tr: `Rahibe'nin sesi titredi: "${lynched.name}" bir ${isKukla ? `${roleLabel(ROLES.KUKLA, 'tr')} (${roleLabel(lynched.role, 'tr')})` : roleLabel(lynched.role, 'tr')} idi.`,
      en: `The Priest's voice trembled: "${lynched.name}" was a ${isKukla ? `${roleLabel(ROLES.KUKLA, 'en')} (${roleLabel(lynched.role, 'en')})` : roleLabel(lynched.role, 'en')}.`,
      ja: `司祭の声が震えた：「${lynched.name}」は${isKukla ? `${roleLabel(ROLES.KUKLA, 'ja')} (${roleLabel(lynched.role, 'ja')})` : roleLabel(lynched.role, 'ja')}だった。`,
      de: `Die Stimme der Nonne zitterte: "${lynched.name}" war ein ${isKukla ? `${roleLabel(ROLES.KUKLA, 'de')} (${roleLabel(lynched.role, 'de')})` : roleLabel(lynched.role, 'de')}.`,
      es: `La voz de la Monja tembló: "${lynched.name}" era un ${isKukla ? `${roleLabel(ROLES.KUKLA, 'es')} (${roleLabel(lynched.role, 'es')})` : roleLabel(lynched.role, 'es')}.`,
      fr: `La voix du Prêtre trembla : "${lynched.name}" était un ${isKukla ? `${roleLabel(ROLES.KUKLA, 'fr')} (${roleLabel(lynched.role, 'fr')})` : roleLabel(lynched.role, 'fr')}.`,
    }));
  } else {
    announcements.push(makeAnnouncement(isKukla ? 'kukla_death' : 'lynch', {
      tr: isKukla
        ? `🎭 "${lynched.name}" asıldı! Gizli rolü: ${roleLabel(ROLES.KUKLA, 'tr')} (${roleLabel(lynched.role, 'tr')}) idi!`
        : `"${lynched.name}" halkın kararıyla idam edildi. Rolü: ${roleLabel(lynched.role, 'tr')}.`,
      en: isKukla
        ? `🎭 "${lynched.name}" was executed! Secret role: ${roleLabel(ROLES.KUKLA, 'en')} (${roleLabel(lynched.role, 'en')})!`
        : `"${lynched.name}" was executed by the people. Role: ${roleLabel(lynched.role, 'en')}.`,
      ja: isKukla
        ? `🎭「${lynched.name}」が処刑された！秘密の役職：${roleLabel(ROLES.KUKLA, 'ja')} (${roleLabel(lynched.role, 'ja')})だった！`
        : `「${lynched.name}」は村人の決定により処刑された。役職：${roleLabel(lynched.role, 'ja')}。`,
      de: isKukla
        ? `🎭 "${lynched.name}" wurde hingerichtet! Geheime Rolle: ${roleLabel(ROLES.KUKLA, 'de')} (${roleLabel(lynched.role, 'de')})!`
        : `"${lynched.name}" wurde vom Volk hingerichtet. Rolle: ${roleLabel(lynched.role, 'de')}.`,
      es: isKukla
        ? `🎭 ¡"${lynched.name}" fue ejecutado! Su rol secreto era: ${roleLabel(ROLES.KUKLA, 'es')} (${roleLabel(lynched.role, 'es')})!`
        : `"${lynched.name}" fue ejecutado por el pueblo. Rol: ${roleLabel(lynched.role, 'es')}.`,
      fr: isKukla
        ? `🎭 "${lynched.name}" a été exécuté ! Rôle secret : ${roleLabel(ROLES.KUKLA, 'fr')} (${roleLabel(lynched.role, 'fr')}) !`
        : `"${lynched.name}" a été exécuté par le peuple. Rôle : ${roleLabel(lynched.role, 'fr')}.`,
    }));
  }

  // Mortisyen clue (only if mortisyen is alive and not the victim)
  const mortPlayer = getPlayer(room, room.mortisyen);
  if (mortPlayer && mortPlayer.alive && room.mortisyen !== lynched.id) {
    const clueData = generateMortisianClue(room, lynched);
    if (!room.mortisyenClues) room.mortisyenClues = [];
    room.mortisyenClues.push(clueData);
    recordMorticianClueForBots(room, clueData);
    io.to(room.mortisyen).emit('private:clue', clueData);
  }


  if (isSecretSF && lynched.id === room.sfId) {
    announcements.push({
      type: 'lynch',
      text: lang === 'tr'
        ? `⚖️ ADALET YERİNİ BULDU! ${lynched.name} gizlenen Mr. Schadenfreude idi ve idam edildi!`
        : `⚖️ JUSTICE SERVED! ${lynched.name} was the secret Mr. Schadenfreude and was executed!`
    });
    room.announcements = announcements;
    endGame(code, 'villagers', lang === 'tr' ? 'Gizli katil Mr. Schadenfreude asıldı. Köylüler kazandı!' : 'The secret killer Mr. Schadenfreude was lynched. Villagers win!');
    return;
  }

  if (isKukla) {
    lynched.isKukla = true;
    if (!room.kuklaHistory) room.kuklaHistory = [];
    if (!room.kuklaHistory.includes(lynched.id)) room.kuklaHistory.push(lynched.id);
    const hadPickRight = (room.consecutiveInnocentLynches || 0) >= 2;
    room.previousKuklaId = room.kuklaId;
    room.kuklaId = null;

    if (hadPickRight) {
      // SF yeni kukla seçme hakkına sahip (2 masum önceden asılmıştı) -> Oyun devam eder
      announcements.push({
        type: 'warning',
        text: lang === 'tr'
          ? 'Kukla idam edildi — ancak dökülen masum kanları yüzünden Mr. Schadenfreude bu gece yeni bir kukla seçecek!'
          : 'The puppet was executed — but past innocent blood allows Mr. Schadenfreude to choose a new puppet tonight!'
      });
    } else {
      // SF'nin yeni kukla seçme hakkı yok -> Köylüler anında kazanır
      room.consecutiveInnocentLynches = 0;
      room.announcements = announcements;
      endGame(code, 'villagers',
        lang === 'tr'
          ? 'Kukla yok edildi ve Mr. Schadenfreude yeni bir kukla seçme hakkına sahip değil. Köylüler kazandı!'
          : 'The puppet was eliminated and Mr. Schadenfreude has no right to choose another. Villagers win!');
      return;
    }
  } else if (lynched.id !== room.sfId) {
    // Masum köylü / şövalye / mortisyen / rahibe / madman linç edildi -> Kaos puanı artar
    room.consecutiveInnocentLynches = Math.min(2, (room.consecutiveInnocentLynches || 0) + 1);
  }

  room.announcements = announcements;
  room.newKuklaJustSet = false;

  const win = checkWin(room);
  if (win) {
    room.announcements = [...announcements];
    endGame(code, win.winner, win.reason);
    return;
  }

  startPhase(code, PHASES.RESULT);
}

// ─────────────────────────────────────────────
// GAME END
// ─────────────────────────────────────────────
function endGame(code, winner, reason) {
  const room = rooms[code];
  if (!room) return;
  clearTimer(room);
  room.phase = PHASES.ENDED;
  room.winner = winner;
  room.endReason = reason;

  const endedPlayers = room.players.map(p => ({
    ...p,
    isKukla: !!p.isKukla || p.id === room.kuklaId || p.id === room.previousKuklaId || (room.kuklaHistory && room.kuklaHistory.includes(p.id))
  }));

  broadcastState(code);
  io.to(code).emit('game:ended', { winner, reason, players: endedPlayers });
}

function resetRoomToLobby(room) {
  if (!room) return;
  const code = room.code;
  clearTimer(room);
  room.phase = PHASES.LOBBY;
  room.round = 0;
  room.timer = null;
  room.timerEndsAt = null;
  room.winner = null;
  room.endReason = null;
  room.sfId = null;
  room.kuklaId = null;
  room.previousKuklaId = null;
  room.kuklaHistory = [];
  room.consecutiveInnocentLynches = 0;
  room.newKuklaJustSet = false;
  room.firstDeathAnnounced = false;
  room.firstLynchAnnounced = false;
  room.rahibe = null;
  room.mortisyen = null;
  room.sovalye = null;
  room.nightActions = {};
  room.votes = {};
  room.pendingDeaths = [];
  room.announcements = [];
  room.chat = [];
  room.voteHistory = [];
  room.mortisyenClueHistory = [];
  room.sovalyeChallengesUsed = 0;
  room.readyPlayers = {};

  // Reset all players to alive and unassigned
  room.players.forEach(p => {
    p.alive = true;
    p.role = null;
    p.isKukla = false;
    p.deathCause = null;
    p.deathRound = null;
  });

  // Re-initialize bot memory
  initBotMemory(room);

  // Send empty private state to all players so their client roles reset
  room.players.forEach(p => {
    if (!p.isBot) {
      io.to(p.id).emit('game:role', {});
    }
  });

  addAnnouncement(room, room.language === 'tr'
    ? '🏰 Oyun tamamlandı. Tüm oyuncular yeni tur için lobiye döndü.'
    : '🏰 Game completed. All players returned to the lobby for a new match.');

  broadcastState(code);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function makeAnnouncement(type, texts) {
  return {
    type: type || 'info',
    text: texts.tr || texts.en || '',
    translations: {
      tr: texts.tr || '',
      en: texts.en || texts.tr || '',
      ja: texts.ja || texts.en || texts.tr || '',
      de: texts.de || texts.en || texts.tr || '',
      es: texts.es || texts.en || texts.tr || '',
      fr: texts.fr || texts.en || texts.tr || '',
    }
  };
}

function addAnnouncement(room, text) {
  if (!room.announcements) room.announcements = [];
  room.announcements.push(typeof text === 'object' ? text : { type: 'info', text });
}

function roleLabel(role, lang = 'en') {
  const labels = {
    tr: { sf: 'Mr. Schadenfreude', kukla: 'Kukla', mortisyen: 'Mortisyen', rahibe: 'Rahibe', sovalye: 'Şövalye', madman: 'Madman', koylu: 'Köylü' },
    en: { sf: 'Mr. Schadenfreude', kukla: 'Puppet', mortisyen: 'Undertaker', rahibe: 'Priest', sovalye: 'Knight', madman: 'Madman', koylu: 'Villager' },
    ja: { sf: 'Mr.シャーデンフロイデ', kukla: '人形', mortisyen: '葬儀屋', rahibe: '司祭', sovalye: '騎士', madman: '狂人', koylu: '村人' },
    de: { sf: 'Mr. Schadenfreude', kukla: 'Puppe', mortisyen: 'Leichenbeschauer', rahibe: 'Nonne', sovalye: 'Ritter', madman: 'Verrückter', koylu: 'Dorfbewohner' },
    es: { sf: 'Mr. Schadenfreude', kukla: 'Marioneta', mortisyen: 'Sepulturero', rahibe: 'Monja', sovalye: 'Caballero', madman: 'Demente', koylu: 'Aldeano' },
    fr: { sf: 'Mr. Schadenfreude', kukla: 'Marionnette', mortisyen: 'Croque-mort', rahibe: 'Nonne', sovalye: 'Chevalier', madman: 'Fou', koylu: 'Villageois' },
  };
  return (labels[lang] || labels.en || labels.tr)[role] || role;
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function broadcastState(code) {
  const room = rooms[code];
  if (!room) return;

  // Send public state to all
  const publicState = buildPublicState(room);
  io.to(code).emit('game:state', publicState);

  // Send synchronized private state to each player
  room.players.forEach(p => {
    if (!p.isBot) {
      io.to(p.id).emit('game:role', buildPrivateState(room, p.id));
    }
  });
}

function buildPublicState(room) {
  const isSecretSF = room.settings?.gameMode === 'secretKiller';
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    language: room.language,
    timerEndsAt: room.timerEndsAt,
    settings: room.settings,
    isSecretSF,
    sfId: isSecretSF ? null : room.sfId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      // SF role is public only in puppetMaster mode; in secretKiller mode, revealed only on death/end
      role: (!p.alive || (!isSecretSF && p.id === room.sfId) || room.phase === PHASES.ENDED) ? p.role : null,
      isKukla: (!p.alive || room.phase === PHASES.ENDED) ? (!!p.isKukla || p.id === room.kuklaId || p.id === room.previousKuklaId || (room.kuklaHistory && room.kuklaHistory.includes(p.id))) : undefined,
      deathCause: p.deathCause,
      deathRound: p.deathRound,
    })),
    announcements: room.announcements || [],
    chat: room.chat || [],
    winner: room.winner || null,
    endReason: room.endReason || null,
    host: room.host,
    // If showVotes is enabled (or in VOTE/RESULT phase), include votes
    votes: room.settings.showVotes ? room.votes : undefined,
    consecutiveInnocentLynches: room.consecutiveInnocentLynches || 0,
    kuklaSlotEmpty: !isSecretSF && !room.kuklaId && !!room.sfId,
    canSFPickThisNight: !isSecretSF && !room.kuklaId && !!room.sfId && !room.newKuklaJustSet && ((room.consecutiveInnocentLynches || 0) >= 2),
    assignedRoles: room.assignedRoles || {},
  };
}

function buildPrivateState(room, playerId) {
  const player = getPlayer(room, playerId);
  if (!player) return {};
  const isSF = player.id === room.sfId;
  const isKukla = player.id === room.kuklaId;
  const isSecretSF = room.settings?.gameMode === 'secretKiller';

  const isSovalye = player.role === ROLES.SOVALYE;
  return {
    alive: player.alive,
    myRole: player.role, // Base role is preserved!
    isSF,
    isKukla,
    isSecretKiller: isSF && isSecretSF,
    gameMode: room.settings?.gameMode || 'puppetMaster',
    puppetCanSkip: room.settings.puppetCanSkip,
    // SF knows who kukla is (only in puppetMaster mode)
    kuklaId: (isSF && !isSecretSF) ? room.kuklaId : undefined,
    kuklaName: (isSF && !isSecretSF && room.kuklaId) ? getPlayer(room, room.kuklaId)?.name : undefined,
    // SF & Kukla private chat history
    shadowChat: ((isSF || isKukla) && !isSecretSF) ? (room.shadowChat || []) : undefined,
    canPickKukla: isSF && !isSecretSF && !room.kuklaId,
    sfCanPickCondition: isSF && !isSecretSF ? getSFPickCondition(room) : undefined,
    // Şövalye: remaining challenge uses
    sovalyeChallengesLeft: isSovalye ? Math.max(0, 2 - (room.sovalyeChallengesUsed || 0)) : undefined,
    sovalyeActionDone: isSovalye ? (!!(room.nightActions.sovalye_protect || room.nightActions.sovalye_challenge)) : undefined,
    // Mortisyen: active investigation state
    isMortisyen: player.role === ROLES.MORTISYEN,
    mortisyenActionDone: player.role === ROLES.MORTISYEN ? (!!room.nightActions.mortisyen_mode) : undefined,
    mortisyenMode: player.role === ROLES.MORTISYEN ? room.nightActions.mortisyen_mode : undefined,
    mortisyenTarget: player.role === ROLES.MORTISYEN ? room.nightActions.mortisyen_target : undefined,
    mortisyenClues: player.role === ROLES.MORTISYEN ? (room.mortisyenClues || []) : undefined,
    // Rahibe: tarot prophecy state
    isRahibe: player.role === ROLES.RAHIBE,
    rahibeActionDone: player.role === ROLES.RAHIBE ? (!!room.nightActions.rahibe_target || !!room.nightActions.rahibe_passed) : undefined,
    rahibePassed: player.role === ROLES.RAHIBE ? !!room.nightActions.rahibe_passed : undefined,
    rahibeTarotAvailable: player.role === ROLES.RAHIBE ? !!room.rahibeTarotAvailable : undefined,
    rahibeTarots: player.role === ROLES.RAHIBE ? (room.rahibeTarots || []) : undefined,
  };
}

function getSFPickCondition(room) {
  if (room.kuklaId) return 'has_kukla';
  if (room.newKuklaJustSet) return 'cannot_pick';
  if (room.consecutiveInnocentLynches >= 2) return 'can_pick_condition2';
  return 'waiting'; // kukla dead, waiting for condition
}

// ─────────────────────────────────────────────
// SOCKET.IO EVENTS
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Create room (Rate limited & sanitized)
  socket.on('room:create', ({ name, language }) => {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const clientIp = (forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address) || socket.id;
    if (isRateLimited(createRoomLimits, clientIp, 8, 30000)) {
      return socket.emit('error', { message: (language === 'tr' ? 'Lütfen yeni lobi kurmadan önce 30 saniye bekleyin.' : 'Too many rooms created. Please wait 30 seconds.') });
    }

    const cleanName = String(name || '')
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .slice(0, 24);
    if (!cleanName || cleanName.length < 2) {
      return socket.emit('error', { message: (language === 'tr' ? 'İsim en az 2 karakter olmalıdır.' : 'Name must be at least 2 characters.') });
    }

    try {
      const code = createRoom(socket.id, cleanName, language);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.name = cleanName;
      socket.emit('room:created', { code });
      broadcastState(code);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  // Join room (Sanitized & validated)
  socket.on('room:join', ({ code, name }) => {
    const cleanCode = String(code || '').trim().toUpperCase().slice(0, 12);
    const cleanName = String(name || '')
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .slice(0, 24);

    if (!cleanCode || !cleanName || cleanName.length < 2) {
      return socket.emit('error', { message: 'Geçerli bir oda kodu ve en az 2 karakterli isim giriniz.' });
    }

    const room = rooms[cleanCode];
    if (!room) return socket.emit('error', { message: room?.language === 'tr' ? 'Oda bulunamadı.' : 'Room not found.' });
    if (room.bannedNames && room.bannedNames.includes(cleanName.toLowerCase())) {
      return socket.emit('error', { message: room.language === 'tr' ? 'Bu lobiden yasaklandınız.' : 'You have been banned from this lobby.' });
    }
    if (room.phase !== PHASES.LOBBY && !room.players.find(p => p.name === cleanName)) {
      return socket.emit('error', { message: room.language === 'tr' ? 'Oyun başladı, katılamazsın.' : 'Game already started.' });
    }
    if (room.players.length >= 15 && !room.players.find(p => p.name === cleanName)) {
      return socket.emit('error', { message: room.language === 'tr' ? 'Oda dolu.' : 'Room is full.' });
    }

    addPlayer(cleanCode, socket.id, cleanName);
    socket.join(cleanCode);
    socket.data.roomCode = cleanCode;
    socket.data.name = cleanName;
    socket.emit('room:joined', { code: cleanCode });
    broadcastState(cleanCode);
  });

  // Start game
  socket.on('game:start', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const isSecretSF = room.settings?.gameMode === 'secretKiller';
    const minRequired = isSecretSF ? 4 : 5;
    if (room.players.length < minRequired) {
      return socket.emit('error', {
        message: room.language === 'tr'
          ? (isSecretSF ? 'Gizli Katil modu için en az 4 oyuncu gerekli.' : 'Kukla Ustası modu için en az 5 oyuncu gerekli.')
          : (isSecretSF ? 'At least 4 players required for Secret Killer mode.' : 'At least 5 players required for Puppet Master mode.')
      });
    }
    assignRoles(room);
    // Send each player their private role
    room.players.forEach(p => {
      const priv = buildPrivateState(room, p.id);
      io.to(p.id).emit('game:role', priv);
    });

    if (room.settings?.gameMode === 'secretKiller') {
      // Secret Killer mode: Starts directly at Night 1 without Night 0!
      room.round = 1;
      addAnnouncement(room, room.language === 'tr'
        ? 'Mr. Schadenfreude halkın arasına gizlendi. Gece başlıyor.'
        : 'Mr. Schadenfreude is hidden among the villagers. Night begins.');
      startPhase(code, PHASES.NIGHT);
    } else if (room.kuklaId) {
      // Kukla önceden atandıysa doğrudan 1. Gece'den başla
      room.round = 1;
      addAnnouncement(room, room.language === 'tr'
        ? 'Mr. Schadenfreude karanlıkta kuklasını seçti.'
        : 'Mr. Schadenfreude has chosen his puppet in the dark.');
      startPhase(code, PHASES.NIGHT);
    } else {
      startPhase(code, PHASES.NIGHT0);
    }
  });

  // Play again / Return to lobby from ENDED phase
  socket.on('game:playAgain', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    if (room.phase !== PHASES.ENDED && room.phase !== PHASES.LOBBY) return;
    resetRoomToLobby(room);
  });

  // Host sets role for any player in lobby
  socket.on('room:setPlayerRole', ({ targetId, role }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id || room.phase !== PHASES.LOBBY) return;
    if (!room.assignedRoles) room.assignedRoles = {};
    if (role === 'auto') {
      delete room.assignedRoles[targetId];
    } else {
      room.assignedRoles[targetId] = role;
    }
    broadcastState(code);
  });

  // Host transfers host privileges to another player
  socket.on('room:transferHost', ({ targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id || room.phase !== PHASES.LOBBY) return;
    const target = getPlayer(room, targetId);
    if (!target || target.isBot || target.id === socket.id) return;
    room.host = targetId;
    addAnnouncement(room, room.language === 'tr'
      ? `👑 ${target.name} yeni oda yöneticisi (Host) oldu.`
      : `👑 ${target.name} is now the room host.`);
    broadcastState(code);
  });

  // Host kicks player from lobby
  socket.on('room:kickPlayer', ({ targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id || room.phase !== PHASES.LOBBY) return;
    const target = getPlayer(room, targetId);
    if (!target || target.id === socket.id) return;

    const targetName = target.name;
    room.players = room.players.filter(p => p.id !== targetId);
    if (room.assignedRoles) delete room.assignedRoles[targetId];

    if (!target.isBot) {
      io.to(targetId).emit('room:kicked', {
        message: room.language === 'tr' ? 'Oda yöneticisi tarafından lobiden atıldınız.' : 'You have been kicked from the lobby.'
      });
      io.sockets.sockets.get(targetId)?.leave(code);
    }

    addAnnouncement(room, room.language === 'tr'
      ? `👢 ${targetName} lobiden atıldı.`
      : `👢 ${targetName} was kicked from the lobby.`);
    broadcastState(code);
  });

  // Host bans player from lobby
  socket.on('room:banPlayer', ({ targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id || room.phase !== PHASES.LOBBY) return;
    const target = getPlayer(room, targetId);
    if (!target || target.id === socket.id) return;

    const targetName = target.name;
    if (!room.bannedNames) room.bannedNames = [];
    if (!room.bannedNames.includes(targetName.toLowerCase())) {
      room.bannedNames.push(targetName.toLowerCase());
    }

    room.players = room.players.filter(p => p.id !== targetId);
    if (room.assignedRoles) delete room.assignedRoles[targetId];

    if (!target.isBot) {
      io.to(targetId).emit('room:banned', {
        message: room.language === 'tr' ? 'Bu lobiden kalıcı olarak yasaklandınız.' : 'You have been banned from this lobby.'
      });
      io.sockets.sockets.get(targetId)?.leave(code);
    }

    addAnnouncement(room, room.language === 'tr'
      ? `🚫 ${targetName} lobiden yasaklandı.`
      : `🚫 ${targetName} was banned from the lobby.`);
    broadcastState(code);
  });

  // Player explicitly leaves room
  socket.on('room:leave', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (room) {
      handlePlayerLeave(room, socket.id);
      socket.leave(code);
      socket.data.roomCode = null;
    }
  });

  // Night 0: SF picks kukla
  socket.on('action:pickKukla', ({ targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.sfId !== socket.id) return;
    const sfPlayer = getPlayer(room, socket.id);
    if (!sfPlayer || !sfPlayer.alive) return;

    const isNight0 = room.phase === PHASES.NIGHT0;
    const isNight = room.phase === PHASES.NIGHT;
    const canPick = !room.kuklaId && (
      isNight0 ||
      (isNight && (room.consecutiveInnocentLynches >= 2))
    );
    if (!canPick) return;

    const target = getPlayer(room, targetId);
    if (!target || !target.alive || target.id === room.sfId) return;

    room.kuklaId = targetId;
    target.isKukla = true;
    if (!room.kuklaHistory) room.kuklaHistory = [];
    if (!room.kuklaHistory.includes(targetId)) room.kuklaHistory.push(targetId);
    room.newKuklaJustSet = !isNight0; // Track if this is a re-pick (not initial)
    room.consecutiveInnocentLynches = 0;

    // Notify kukla (only if human)
    if (!target.isBot) {
      io.to(targetId).emit('game:becomeKukla', {
        baseRole: target.role,
        message: room.language === 'tr'
          ? `Mr. Schadenfreude sizi seçti. Artık hem ${roleLabel(target.role, room.language)} hem de onun kuklasısınız!`
          : `Mr. Schadenfreude has chosen you. You are both ${roleLabel(target.role, room.language)} and his puppet!`,
      });
    }

    // Notify SF
    socket.emit('private:message', {
      type: 'success',
      message: room.language === 'tr'
        ? `"${target.name}" artık sizin kuklanız.`
        : `"${target.name}" is now your puppet.`,
    });

    // Update SF private state
    socket.emit('game:role', buildPrivateState(room, socket.id));

    // If night0, end it early
    if (isNight0) {
      clearTimer(room);
      handleNight0End(code);
    }
  });

  // Ready Toggle (All players)
  socket.on('action:setReady', ({ ready }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase === PHASES.LOBBY || room.phase === PHASES.ENDED) return;
    setPlayerReady(room, socket.id, ready);
  });

  // Night: SF sets target for kukla + optional false evidence framing (or 'none' for no order)
  socket.on('action:sfTarget', ({ targetId, frameId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== PHASES.NIGHT || room.sfId !== socket.id) return;
    const sfPlayer = getPlayer(room, socket.id);
    if (!sfPlayer || !sfPlayer.alive) return;

    const isSecretSF = room.settings?.gameMode === 'secretKiller';

    if (targetId === 'none' || !targetId) {
      room.nightActions.sf_target = 'none';
      room.nightActions.sf_frame = null;
      const kuklaPlayer = room.kuklaId ? getPlayer(room, room.kuklaId) : null;
      if (kuklaPlayer && !kuklaPlayer.isBot) {
        io.to(room.kuklaId).emit('game:killOrder', {
          targetId: 'none',
          targetName: 'Yok',
          message: room.language === 'tr'
            ? 'Mr. Schadenfreude bu gece herhangi bir infaz emri vermedi (Pas geçti).'
            : 'Mr. Schadenfreude issued no kill order tonight (Passed).',
        });
      }
      socket.emit('private:message', {
        type: 'info',
        message: room.language === 'tr' ? '🚫 Bu gece infaz emri verilmedi (Pas geçildi).' : '🚫 No kill order sent tonight (Passed).',
      });
      return;
    }

    if (!isSecretSF && !room.kuklaId) return;
    const target = getPlayer(room, targetId);
    if (!target || !target.alive || targetId === room.sfId || (!isSecretSF && targetId === room.kuklaId)) return;

    room.nightActions.sf_target = targetId;
    if (frameId && frameId !== room.sfId && (!isSecretSF && frameId !== room.kuklaId) && frameId !== targetId) {
      room.nightActions.sf_frame = frameId;
    } else {
      room.nightActions.sf_frame = null;
    }

    if (isSecretSF) {
      // Secret killer acts directly
      socket.emit('private:message', {
        type: 'success',
        message: room.language === 'tr' ? `🗡️ Hedef seçildi: "${target.name}" şafakta yok edilecek.` : `🗡️ Target selected: "${target.name}" will be eliminated at dawn.`,
      });
    } else {
      // Send to kukla (skip if bot — bot auto-confirms)
      const kuklaPlayer = getPlayer(room, room.kuklaId);
      if (kuklaPlayer?.isBot && kuklaPlayer.alive) {
        room.nightActions.kukla_kill = targetId; // Bot kukla auto-confirms kill
        setTimeout(() => {
          const r = rooms[code];
          if (r && r.phase === PHASES.NIGHT) setPlayerReady(r, kuklaPlayer.id, true);
        }, 1000 + Math.random() * 2000);
      } else if (kuklaPlayer && !kuklaPlayer.isBot) {
        io.to(room.kuklaId).emit('game:killOrder', {
          targetId,
          targetName: target.name,
          message: room.language === 'tr'
            ? `Mr. Schadenfreude'nin emri: "${target.name}" bu gece yok edilmeli.`
            : `Mr. Schadenfreude's order: "${target.name}" must be eliminated tonight.`,
        });
      }

      const framePlayer = room.nightActions.sf_frame ? getPlayer(room, room.nightActions.sf_frame) : null;
      const frameNote = framePlayer 
        ? (room.language === 'tr' ? ` (🪶 "${framePlayer.name}"'in eşyası bırakıldı)` : ` (🪶 "${framePlayer.name}"'s item planted)`)
        : '';

      socket.emit('private:message', {
        type: 'info',
        message: (room.language === 'tr' ? 'Emir gönderildi.' : 'Order sent.') + frameNote,
      });
    }
  });

  // Night: SF explicitly passes / no order
  socket.on('action:sfNoOrder', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== PHASES.NIGHT || room.sfId !== socket.id) return;
    const sfPlayer = getPlayer(room, socket.id);
    if (!sfPlayer || !sfPlayer.alive) return;

    room.nightActions.sf_target = 'none';
    room.nightActions.sf_frame = null;
    const kuklaPlayer = room.kuklaId ? getPlayer(room, room.kuklaId) : null;
    if (kuklaPlayer && kuklaPlayer.isBot && kuklaPlayer.alive) {
      setTimeout(() => {
        const r = rooms[code];
        if (r && r.phase === PHASES.NIGHT) setPlayerReady(r, kuklaPlayer.id, true);
      }, 1000 + Math.random() * 1500);
    } else if (kuklaPlayer && !kuklaPlayer.isBot) {
      io.to(room.kuklaId).emit('game:killOrder', {
        targetId: 'none',
        targetName: 'Yok',
        message: room.language === 'tr'
          ? 'Mr. Schadenfreude bu gece herhangi bir infaz emri vermedi (Pas geçti).'
          : 'Mr. Schadenfreude issued no kill order tonight (Passed).',
      });
    }
    socket.emit('private:message', {
      type: 'info',
      message: room.language === 'tr' ? '🚫 Bu gece infaz emri verilmedi (Pas geçildi).' : '🚫 No kill order sent tonight.',
    });
  });

  // Kukla confirms kill
  socket.on('action:kuklaKill', ({ targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== PHASES.NIGHT || room.kuklaId !== socket.id) return;
    const kuklaPlayer = getPlayer(room, socket.id);
    if (!kuklaPlayer || !kuklaPlayer.alive) return;

    room.nightActions.kukla_kill = targetId;
    delete room.nightActions.kukla_refused;
    socket.emit('private:message', {
      type: 'confirm',
      message: room.language === 'tr' ? 'Emir yerine getirildi.' : 'Order carried out.',
    });
  });

  // Kukla refuses / skips kill
  socket.on('action:kuklaRefuse', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== PHASES.NIGHT || room.kuklaId !== socket.id) return;
    if (!room.settings.puppetCanSkip) return socket.emit('error', { message: room.language === 'tr' ? 'Kukla emri reddetme ayarı kapalı.' : 'Puppet refuse setting disabled.' });
    room.nightActions.kukla_refused = true;
    delete room.nightActions.kukla_kill;
    socket.emit('private:message', {
      type: 'confirm',
      message: room.language === 'tr' ? 'Bu gece emre uymadın — cinayet işlenmeyecek.' : 'You refused the order — no kill tonight.',
    });
    if (room.sfId) {
      io.to(room.sfId).emit('private:message', {
        type: 'error',
        message: room.language === 'tr' ? 'Kuklan bu gece emrini yerine getirmedi!' : 'Your puppet did not carry out your command!',
      });
    }
  });

  // Mortisyen publishes clue to village (Rate-limited)
  socket.on('action:mortisyenPublishClue', ({ text }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    const player = getPlayer(room, socket.id);
    if (!room || room.phase !== PHASES.DAY || player?.role !== ROLES.MORTISYEN || !player?.alive) return;
    if (isRateLimited(cluePublishLimits, socket.id, 3, 5000)) return;

    const cleanText = String(text || '').slice(0, 400).trim();
    if (!cleanText) return;

    const msg = {
      name: room.language === 'tr' ? '⚰️ Mortisyen Gizli Raporu' : '⚰️ Undertaker Confidential Report',
      message: cleanText,
      isSystem: true,
      time: Date.now(),
    };
    room.chat.push(msg);
    io.to(code).emit('game:chatMessage', msg);
    socket.emit('private:message', {
      type: 'success',
      message: room.language === 'tr' ? 'İpucu köyle paylaşıldı!' : 'Clue published to the village!',
    });
  });

  // Rahibe night action: inspect a player via tarot
  socket.on('action:rahibe', ({ targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== PHASES.NIGHT) return;
    const player = getPlayer(room, socket.id);
    if (!player || player.role !== ROLES.RAHIBE || !player.alive) return;
    if (isRateLimited(nightActionLimits, socket.id, 4, 2000)) return;

    if (!room.rahibeTarotAvailable) {
      return socket.emit('error', { message: room.language === 'tr' ? 'Tarot kartları bu gece dinlenmede.' : 'Tarot cards are resting tonight.' });
    }

    if (room.nightActions.rahibe_target) {
      return socket.emit('error', { message: room.language === 'tr' ? 'Bu gece zaten Tarot çektin.' : 'You already drew a Tarot card tonight.' });
    }

    const target = getPlayer(room, targetId);
    if (!target || !target.alive || target.id === socket.id) return;

    room.nightActions.rahibe_target = targetId;
    delete room.nightActions.rahibe_passed;
    socket.emit('private:message', {
      type: 'confirm',
      message: room.language === 'tr'
        ? `🃏 "${target.name}" için Tarot kartı çekildi. Şafakta ruh hali sezilecek.`
        : `🃏 Tarot card drawn for "${target.name}". Spiritual state will be sensed at dawn.`
    });
    socket.emit('game:role', buildPrivateState(room, socket.id));
  });

  // Rahibe night action: pass/save tarot charge for next round
  socket.on('action:rahibePass', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== PHASES.NIGHT) return;
    const player = getPlayer(room, socket.id);
    if (!player || player.role !== ROLES.RAHIBE || !player.alive) return;

    delete room.nightActions.rahibe_target;
    room.nightActions.rahibe_passed = true;
    socket.emit('private:message', {
      type: 'info',
      message: room.language === 'tr'
        ? 'Tarot hakkın saklandı, sonraki gece kullanabilirsin.'
        : 'Tarot charge saved for next night.'
    });
    socket.emit('game:role', buildPrivateState(room, socket.id));
  });

  // Host updates room settings
  socket.on('room:updateSettings', ({ settings }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id || room.phase !== PHASES.LOBBY) return;
    if (settings.gameMode && ['puppetMaster', 'secretKiller'].includes(settings.gameMode)) {
      room.settings.gameMode = settings.gameMode;
    }
    if (settings.nightDuration !== undefined) {
      room.settings.nightDuration = Math.floor(Math.max(15, Math.min(120, Number(settings.nightDuration) || 30)));
    }
    if (settings.dayDuration !== undefined) {
      room.settings.dayDuration = Math.floor(Math.max(30, Math.min(240, Number(settings.dayDuration) || 90)));
    }
    if (settings.voteDuration !== undefined) {
      room.settings.voteDuration = Math.floor(Math.max(15, Math.min(90, Number(settings.voteDuration) || 30)));
    }
    if (typeof settings.showVotes === 'boolean') room.settings.showVotes = settings.showVotes;
    if (typeof settings.puppetCanSkip === 'boolean') room.settings.puppetCanSkip = settings.puppetCanSkip;
    if (settings.debugRole) room.settings.debugRole = settings.debugRole;
    broadcastState(code);
  });

  // Şövalye action
  socket.on('action:sovalye', ({ type, targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    const player = getPlayer(room, socket.id);
    if (!room || room.phase !== PHASES.NIGHT || player?.role !== ROLES.SOVALYE || !player.alive) return;

    // Prevent re-submission if action already locked this night
    if (room.nightActions.sovalye_protect || room.nightActions.sovalye_challenge) {
      return socket.emit('error', { message: room.language === 'tr' ? 'Bu gece zaten aksiyon seçtin.' : 'You already submitted an action this night.' });
    }

    if (type === 'protect') {
      if (!targetId) return socket.emit('error', { message: room.language === 'tr' ? 'Hedef seç.' : 'Select a target.' });
      if (targetId === socket.id) {
        return socket.emit('error', { message: room.language === 'tr' ? 'Şövalye kendisini doğrudan koruyamaz!' : 'The Knight cannot protect himself!' });
      }
      if (targetId === room.sfId) {
        return socket.emit('error', { message: room.language === 'tr' ? 'Mr. Schadenfreude karanlığın efendisidir — korunamaz!' : 'Mr. Schadenfreude cannot be protected!' });
      }
      room.nightActions.sovalye_protect = targetId;
    } else if (type === 'challenge') {
      // Challenge limit: max 2 per game
      if ((room.sovalyeChallengesUsed || 0) >= 2) {
        return socket.emit('error', { message: room.language === 'tr' ? 'Mücadele hakkın doldu (max 2).' : 'Challenge limit reached (max 2).' });
      }
      // Blind challenge — always auto-targets SF
      room.nightActions.sovalye_challenge = room.sfId;
      room.sovalyeChallengesUsed = (room.sovalyeChallengesUsed || 0) + 1;
    } else {
      return;
    }

    socket.emit('private:message', {
      type: 'confirm',
      message: room.language === 'tr' ? 'Gece aksiyonun alındı.' : 'Your night action has been recorded.',
    });
    // Push updated private state so client can lock UI
    socket.emit('game:role', buildPrivateState(room, socket.id));
  });

  // Mortisyen action (forensics vs surveillance)
  socket.on('action:mortisyen', ({ mode, targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    const player = getPlayer(room, socket.id);
    if (!room || room.phase !== PHASES.NIGHT || player?.role !== ROLES.MORTISYEN || !player.alive) return;

    room.nightActions.mortisyen_mode = mode || 'forensics';
    if (mode === 'surveillance' && targetId) {
      room.nightActions.mortisyen_target = targetId;
    } else {
      delete room.nightActions.mortisyen_target;
    }

    socket.emit('private:message', {
      type: 'confirm',
      message: room.language === 'tr' ? 'Adli araştırma odağın kaydedildi.' : 'Investigation focus recorded.',
    });
    socket.emit('game:role', buildPrivateState(room, socket.id));
  });

  // Vote (Rate-limited)
  socket.on('game:vote', ({ targetId }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== PHASES.VOTE) return;
    const voter = getPlayer(room, socket.id);
    if (!voter || !voter.alive) return;
    if (isRateLimited(voteLimits, socket.id, 6, 2000)) return;

    const isSecretSF = room.settings?.gameMode === 'secretKiller';

    // In puppetMaster mode, SF cannot vote; in secretKiller mode, SF can vote
    if (!isSecretSF && socket.id === room.sfId) return;

    // Abstain / withdraw existing vote
    if (!targetId) {
      delete room.votes[socket.id];
      broadcastState(code);
      return;
    }
    // In puppetMaster mode, cannot vote for immortal SF
    if (!isSecretSF && targetId === room.sfId) return;
    room.votes[socket.id] = targetId;
    broadcastState(code);
  });

  // Chat (Rate-limited & sanitized)
  socket.on('game:chat', ({ message }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== PHASES.DAY) return;
    const player = getPlayer(room, socket.id);
    if (!player || !player.alive) return;

    if (isRateLimited(chatLimits, socket.id, 4, 2000)) {
      return socket.emit('private:message', {
        type: 'error',
        message: room.language === 'tr' ? 'Çok hızlı mesaj gönderiyorsunuz.' : 'You are chatting too fast.',
      });
    }

    const isSecretSF = room.settings?.gameMode === 'secretKiller';
    // SF cannot participate in public village chat in puppetMaster mode; in secretKiller mode, SF is disguised and can chat!
    if (!isSecretSF && socket.id === room.sfId) {
      return socket.emit('private:message', {
        type: 'info',
        message: room.language === 'tr'
          ? 'Köy sohbetine katılamazsın. Yalnızca Gölge Fısıltılarını kullanabilirsin.'
          : 'You cannot join village chat. Use Shadow Whispers only.',
      });
    }

    const cleanMsg = String(message || '').slice(0, 200).trim();
    if (!cleanMsg) return;

    const msg = { name: player.name, message: cleanMsg, time: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    io.to(code).emit('game:chatMessage', msg);
  });

  // Shadow Chat (SF & Kukla private - Rate-limited & sanitized)
  socket.on('game:shadowChat', ({ message }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    const isSF = socket.id === room.sfId;
    const isKukla = socket.id === room.kuklaId;
    if (!isSF && !isKukla) return;

    const player = getPlayer(room, socket.id);
    if (!player || !player.alive) return;

    if (isRateLimited(chatLimits, socket.id, 4, 2000)) {
      return;
    }

    const msgText = String(message || '').slice(0, 150).trim();
    if (!msgText) return;

    const chatMsg = {
      role: isSF ? 'sf' : 'kukla',
      senderTitle: isSF ? 'Mr. Schadenfreude' : 'Kukla',
      name: player.name,
      message: msgText,
      time: Date.now(),
    };

    if (!room.shadowChat) room.shadowChat = [];
    room.shadowChat.push(chatMsg);
    if (room.shadowChat.length > 50) room.shadowChat.shift();

    if (room.sfId) io.to(room.sfId).emit('game:shadowChatMessage', chatMsg);
    if (room.kuklaId) io.to(room.kuklaId).emit('game:shadowChatMessage', chatMsg);

    // Bot auto-reply if receiver is a bot
    if (isSF && room.kuklaId) {
      const kuklaPlayer = getPlayer(room, room.kuklaId);
      if (kuklaPlayer?.isBot && kuklaPlayer.alive) {
        const kuklaReplies = [
          {
            tr: 'Emriniz başım üstüne, Efendim...',
            en: 'Your wish is my command, Master...',
            ja: '仰せの通りに、ご主人様...',
            de: 'Zu Eurem Befehl, Meister...',
            es: 'A sus órdenes, mi Señor...',
            fr: 'À vos ordres, Maître...',
          },
          {
            tr: 'Sessizce halledeceğim.',
            en: 'I will handle it quietly.',
            ja: '静かに始末します。',
            de: 'Ich werde es leise erledigen.',
            es: 'Me encargaré de ello en silencio.',
            fr: 'Je m\'en occupe en silence.',
          },
          {
            tr: 'Kimse bizden şüphelenmiyor...',
            en: 'Nobody suspects us...',
            ja: '誰も私たちを疑っていません...',
            de: 'Niemand verdächtigt uns...',
            es: 'Nadie sospecha de nosotros...',
            fr: 'Personne ne nous soupçonne...',
          },
          {
            tr: 'Kimi yok etmemi istersiniz?',
            en: 'Whom do you wish me to eliminate?',
            ja: '誰を始末すればよいですか？',
            de: 'Wen soll ich für Euch beseitigen?',
            es: '¿A quién desea que elimine?',
            fr: 'Qui voulez-vous que j\'élimine ?',
          },
        ];
        const replyObj = kuklaReplies[Math.floor(Math.random() * kuklaReplies.length)];
        setTimeout(() => {
          const r = rooms[code];
          if (!r) return;
          const senderTitles = {
            tr: 'Kukla',
            en: 'Puppet',
            ja: '人形',
            de: 'Puppe',
            es: 'Marioneta',
            fr: 'Marionnette',
          };
          const botMsg = {
            role: 'kukla',
            senderTitle: senderTitles[r.language || 'tr'] || 'Kukla',
            senderTitleTranslations: senderTitles,
            name: kuklaPlayer.name,
            message: replyObj[r.language || 'tr'] || replyObj.tr,
            translations: replyObj,
            isBot: true,
            time: Date.now(),
          };
          r.shadowChat.push(botMsg);
          if (r.sfId) io.to(r.sfId).emit('game:shadowChatMessage', botMsg);
        }, 1200 + Math.random() * 2000);
      }
    } else if (isKukla && room.sfId) {
      const sfPlayer = getPlayer(room, room.sfId);
      if (sfPlayer?.isBot && sfPlayer.alive) {
        const sfReplies = [
          {
            tr: 'Aferin kuklam... Gölgelerin ritmine uy.',
            en: 'Well done, my puppet... Follow the rhythm of shadows.',
            ja: 'よくやった、我が人形よ... 影の調べに身を任せよ。',
            de: 'Gut gemacht, meine Puppe... Folge dem Rhythmus der Schatten.',
            es: 'Bien hecho, mi marioneta... Sigue el ritmo de las sombras.',
            fr: 'Bien joué, ma marionnette... Suis le rythme des ombres.',
          },
          {
            tr: 'Sessiz ol ve geceyi bekle.',
            en: 'Stay quiet and await the night.',
            ja: '静かにして夜を待て。',
            de: 'Sei still und warte auf die Nacht.',
            es: 'Guarda silencio y espera la noche.',
            fr: 'Reste discret et attends la nuit.',
          },
          {
            tr: 'Kaos büyüyecek...',
            en: 'Chaos shall grow...',
            ja: '混沌は深まるのみ...',
            de: 'Das Chaos wird wachsen...',
            es: 'El caos crecerá...',
            fr: 'Le chaos va grandir...',
          },
        ];
        const replyObj = sfReplies[Math.floor(Math.random() * sfReplies.length)];
        setTimeout(() => {
          const r = rooms[code];
          if (!r) return;
          const senderTitles = {
            tr: 'Mr. Schadenfreude',
            en: 'Mr. Schadenfreude',
            ja: 'Mr.シャーデンフロイデ',
            de: 'Mr. Schadenfreude',
            es: 'Mr. Schadenfreude',
            fr: 'Mr. Schadenfreude',
          };
          const botMsg = {
            role: 'sf',
            senderTitle: senderTitles[r.language || 'tr'] || 'Mr. Schadenfreude',
            senderTitleTranslations: senderTitles,
            name: sfPlayer.name,
            message: replyObj[r.language || 'tr'] || replyObj.tr,
            translations: replyObj,
            isBot: true,
            time: Date.now(),
          };
          r.shadowChat.push(botMsg);
          if (r.kuklaId) io.to(r.kuklaId).emit('game:shadowChatMessage', botMsg);
        }, 1200 + Math.random() * 2000);
      }
    }
  });

  // Request private state
  socket.on('game:requestPrivate', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    socket.emit('game:role', buildPrivateState(room, socket.id));
  });

  // Add test bots (host only)
  socket.on('room:addBots', ({ count }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const added = addBots(room, Math.max(1, Number(count) || 1));
    broadcastState(code);
    socket.emit('room:botsAdded', { count: added });
  });

  // Disconnect
  socket.on('disconnect', () => {
    chatLimits.delete(socket.id);
    voteLimits.delete(socket.id);
    cluePublishLimits.delete(socket.id);
    nightActionLimits.delete(socket.id);

    const code = socket.data.roomCode;
    const room = rooms[code];
    if (room) {
      handlePlayerLeave(room, socket.id);
      if (room.phase !== PHASES.LOBBY) {
        // 60s grace period for in-game reconnects
        setTimeout(() => {
          const r = rooms[code];
          if (r) {
            const p = getPlayer(r, socket.id);
            if (p && p.disconnected) {
              // Could auto-kill or mark deceased if needed
            }
          }
        }, 60000);
      }
    }
  });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎭 Mr. Schadenfreude server running!`);
  console.log(`   ➜ Local:   http://localhost:${PORT}`);
  console.log(`   ➜ Network: http://192.168.1.5:${PORT}`);
});
