// @ts-nocheck

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ================== 설정 ==================
const TOKEN = process.env.TOKEN;
const CLIENT_ID = '1489904266461319218';
const GUILD_ID = '1486229581190004748';

// ✅ 인처단 전용 스프레드시트 ID
const SPREADSHEET_ID = '1-ab0QPdvcBCj1uRk-1iMv8vyxvWbQJO07coZISBU0TM';

// ✅ 서비스 계정 이메일
const SERVICE_ACCOUNT_EMAIL = 'ffulfillment-management-bot4@fulfillment-management-bot4.iam.gserviceaccount.com';

// ================== Railway용: 서비스계정 JSON을 env로 받아 파일로 생성 ==================
function ensureGoogleKeyFile() {
  const envJson = process.env.GOOGLE_SA_JSON;
  const filePath = process.env.GOOGLE_KEYFILE || path.join(__dirname, 'service-account.json');

  if (!envJson && fs.existsSync(filePath)) {
    console.log(`✅ 기존 Google key file 사용: ${filePath}`);
    return filePath;
  }

  if (!envJson) {
    console.log('❌ GOOGLE_SA_JSON 환경변수가 없고, service-account.json 파일도 없습니다.');
    return filePath;
  }

  try {
    const parsed = JSON.parse(envJson);

    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }

    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    console.log(`✅ Google service account key written to: ${filePath}`);
    console.log(`✅ Service Account Email: ${parsed.client_email}`);

    if (parsed.client_email !== SERVICE_ACCOUNT_EMAIL) {
      console.log(`⚠️ 현재 GOOGLE_SA_JSON의 client_email과 코드의 SERVICE_ACCOUNT_EMAIL이 다릅니다.`);
      console.log(`   JSON: ${parsed.client_email}`);
      console.log(`   CODE: ${SERVICE_ACCOUNT_EMAIL}`);
    }

    return filePath;
  } catch (err) {
    console.error('❌ GOOGLE_SA_JSON 파싱 실패:', err);
    throw err;
  }
}

const GOOGLE_KEYFILE = ensureGoogleKeyFile();

// ✅ 구글 인증
const gAuth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function appendRowToSheet(rangeA1, values) {
  const sheets = google.sheets({ version: 'v4', auth: gAuth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: rangeA1,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] }
  });
}

async function verifyGoogleSheetAccess() {
  try {
    const sheets = google.sheets({ version: 'v4', auth: gAuth });

    const info = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID
    });

    const sheetNames = (info.data.sheets || []).map(s => s.properties?.title).filter(Boolean);

    console.log('✅ 스프레드시트 접근 성공');
    console.log(`✅ 스프레드시트 제목: ${info.data.properties?.title || '(제목 없음)'}`);
    console.log(`✅ 스프레드시트 ID: ${SPREADSHEET_ID}`);
    console.log(`✅ 시트 탭 목록: ${sheetNames.join(', ') || '(없음)'}`);

    if (!sheetNames.includes('인처단')) {
      console.log('⚠️ 시트 탭 이름 "인처단" 이 존재하지 않습니다. 탭 이름을 정확히 "인처단" 으로 맞춰야 합니다.');
    }
  } catch (err) {
    console.error('❌ 스프레드시트 접근 확인 실패:', err?.message || err);
    console.log('⚠️ 아래 사항을 확인하세요:');
    console.log('1) 스프레드시트 ID가 맞는지');
    console.log(`2) 서비스 계정 이메일(${SERVICE_ACCOUNT_EMAIL})에 편집자 권한을 줬는지`);
    console.log('3) Railway의 GOOGLE_SA_JSON 값이 올바른지');
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// ================== 역할 ID ==================
const PERSONNEL_PROCESSING_ROLE_ID = '1486733583740567692'; // 인처단 보고 가능 역할
const ALL_COMMAND_MANAGER_ROLE_ID = '1489255392168120350';  // 모든 관리 명령어 사용 가능
const DEMOTION_EXCLUDED_ROLE_ID = '1486229581190004752';    // 강등대상 제외 역할

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'personnel_processing_data.json');

// ================== 기준 점수 ==================
const DAILY_MIN_POINTS = 20;   // 20포인트면 오늘/어제/주간 조회에 포함 X
const WEEKLY_MIN_POINTS = 140; // 140포인트 미만이면 강등 대상

// ================== 데이터 구조 ==================
let data = {
  인처단: {
    weekStart: '',
    lastWeekStart: '',
    users: {},
    history: {
      daily: {},
      weekly: {}
    }
  }
};

// ================== 런타임 캐시 ==================
const dayTotalsCache = new Map(); // `인처단|dateStr` -> Map(userId->points)
const paginationSessions = new Map();

// ================== 데이터 저장 ==================
function loadData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    saveData();
  }

  if (!data.인처단) {
    data.인처단 = {
      weekStart: '',
      lastWeekStart: '',
      users: {},
      history: { daily: {}, weekly: {} }
    };
  }

  if (!data.인처단.users) data.인처단.users = {};
  if (!data.인처단.history) data.인처단.history = { daily: {}, weekly: {} };
  if (!data.인처단.history.daily) data.인처단.history.daily = {};
  if (!data.인처단.history.weekly) data.인처단.history.weekly = {};
  if (!data.인처단.weekStart) data.인처단.weekStart = '';
  if (!data.인처단.lastWeekStart) data.인처단.lastWeekStart = '';

  for (const u of Object.values(data.인처단.users || {})) {
    if (!u.daily) u.daily = {};
    if (typeof u.totalPoints !== 'number') u.totalPoints = 0;
    if (typeof u.manualAdjust !== 'number') u.manualAdjust = 0;
    if (!Array.isArray(u.adjustLogs)) u.adjustLogs = [];
  }

  recomputeTotals(data.인처단);
  dayTotalsCache.clear();
  paginationSessions.clear();
}

function saveData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ================== 날짜 (새벽 2시 기준) ==================
function getReportDate() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
  if (now.getHours() < 2) now.setDate(now.getDate() - 1);
  return now.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getYesterdayDate() {
  return addDays(getReportDate(), -1);
}

function getSundayWeekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00+09:00`);
  const day = d.getUTCDay(); // 0=일요일
  return addDays(dateStr, -day);
}

// ================== 공용 유틸 ==================
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hasRole(member, roleId) {
  return member?.roles?.cache?.has(roleId);
}

function daysSinceJoined(member) {
  const joined = member?.joinedAt;
  if (!joined) return 9999;
  const diffMs = Date.now() - joined.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function recomputeTotals(group) {
  for (const u of Object.values(group.users || {})) {
    let basePoints = 0;

    if (u.daily) {
      for (const d of Object.values(u.daily)) {
        basePoints += (d?.points || 0);
      }
    }

    const manualAdjust = typeof u.manualAdjust === 'number' ? u.manualAdjust : 0;
    u.totalPoints = basePoints + manualAdjust;
  }
}

function getBasePointsOfUser(userObj) {
  let basePoints = 0;
  if (userObj?.daily) {
    for (const d of Object.values(userObj.daily)) {
      basePoints += (d?.points || 0);
    }
  }
  return basePoints;
}

async function getEligibleMemberIds(guild) {
  const members = await guild.members.fetch();
  const ids = [];

  for (const [, m] of members) {
    if (m.user?.bot) continue;
    if (!m.roles.cache.has(PERSONNEL_PROCESSING_ROLE_ID)) continue;
    ids.push(m.id);
  }

  return ids;
}

function collectEvidenceAttachments(interaction) {
  const result = [];

  for (let i = 1; i <= 10; i++) {
    const att = interaction.options.getAttachment(`증거${i}`);
    if (!att) continue;

    const contentType = att.contentType || '';
    if (!contentType.startsWith('image/')) {
      throw new Error(`증거${i}는 사진 파일만 첨부할 수 있습니다.`);
    }

    result.push({
      name: att.name,
      url: att.url,
      contentType: att.contentType || '',
      size: att.size || 0
    });
  }

  return result;
}

// ================== 포인트 계산 ==================
function calculatePoints(input) {
  return (
    (input.보고서처리 || 0) * 1 +
    (input.전역전출처리 || 0) * 5 +
    (input.군탈처리 || 0) * 5
  );
}

function buildDayScoresForMembers(dateStr, memberIds) {
  const group = data.인처단;

  const display = (memberIds || [])
    .map((userId) => {
      const u = group.users?.[userId];
      const points = u?.daily?.[dateStr]?.points ?? 0;
      const 보고서처리 = u?.daily?.[dateStr]?.보고서처리 ?? 0;
      const 전역전출처리 = u?.daily?.[dateStr]?.전역전출처리 ?? 0;
      const 군탈처리 = u?.daily?.[dateStr]?.군탈처리 ?? 0;
      const nick = u?.nick || `<@${userId}>`;

      return {
        userId,
        nick,
        보고서처리,
        전역전출처리,
        군탈처리,
        points
      };
    })
    .filter(r => r.points > DAILY_MIN_POINTS)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.전역전출처리 !== a.전역전출처리) return b.전역전출처리 - a.전역전출처리;
      if (b.군탈처리 !== a.군탈처리) return b.군탈처리 - a.군탈처리;
      return b.보고서처리 - a.보고서처리;
    });

  return { display, dateStr };
}

function getDayTotalsOnly(dateStr) {
  const cacheKey = `인처단|${dateStr}`;
  const cached = dayTotalsCache.get(cacheKey);
  if (cached) return cached;

  const group = data.인처단;
  const totalsMap = new Map();

  for (const [userId, u] of Object.entries(group.users || {})) {
    const points = u?.daily?.[dateStr]?.points ?? 0;
    totalsMap.set(userId, points);
  }

  dayTotalsCache.set(cacheKey, totalsMap);
  return totalsMap;
}

// ================== 임베드/페이지네이션 ==================
function buildPagerComponents(mode, key, page, totalPages) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`pg|${mode}|${key}|${page - 1}`)
        .setLabel('이전 페이지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`pg|${mode}|${key}|${page + 1}`)
        .setLabel('다음 페이지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    )
  ];
}

function createDailyEmbedPaged(dateStr, fullList, page, pageSize, titlePrefix) {
  const total = fullList.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = clamp(page, 0, totalPages - 1);

  const start = p * pageSize;
  const slice = fullList.slice(start, start + pageSize);

  const lines = slice.length
    ? slice.map((r, i) => {
        const rankNo = start + i + 1;
        return `**${rankNo}위** ${r.nick} — **${r.points}포인트** 〔보고서 처리: ${r.보고서처리} / 전역·전출 처리: ${r.전역전출처리} / 군탈 처리: ${r.군탈처리}〕`;
      }).join('\n')
    : '조건을 만족하는 데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`인처단 ${titlePrefix} (${dateStr})`)
    .setDescription(
      `※ ${DAILY_MIN_POINTS}포인트 이하는 표시되지 않습니다.\n\n${lines}`
    )
    .setFooter({ text: `페이지 ${p + 1}/${totalPages} · 보고서처리 1점 / 전역·전출 5점 / 군탈 5점` });
}

function createWeeklyEmbedPaged(weekStart, fullList, page, pageSize, titlePrefix) {
  const total = fullList.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = clamp(page, 0, totalPages - 1);

  const start = p * pageSize;
  const slice = fullList.slice(start, start + pageSize);
  const nextWeekStart = addDays(weekStart, 7);

  const lines = slice.length
    ? slice.map((u, i) => {
        const rankNo = start + i + 1;
        return `**${rankNo}위** ${u.nick} — **${u.weeklyTotal}포인트**`;
      }).join('\n')
    : '조건을 만족하는 데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`인처단 ${titlePrefix}`)
    .setDescription(
      `**주간 범위(기준)**: ${weekStart} 02:00 ~ ${nextWeekStart} 02:00\n` +
      `※ ${WEEKLY_MIN_POINTS}포인트 이하는 표시되지 않습니다.\n\n${lines}`
    )
    .setFooter({ text: `페이지 ${p + 1}/${totalPages} · 일요일 새벽 2시 ~ 다음주 일요일 새벽 2시` });
}

function createDemotionEmbed(list, page, pageSize, totalPages, title, footerPrefix, weekStart) {
  const start = page * pageSize;
  const slice = list.slice(start, start + pageSize);
  const nextWeekStart = addDays(weekStart, 7);

  const lines = slice.length
    ? slice.map((x, i) => {
        const rankNo = start + i + 1;
        return `**${rankNo}위** ${x.mention} — **주간 ${x.totalScore}포인트**`;
      }).join('\n')
    : '대상이 없습니다.';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(`**주간 범위(기준)**: ${weekStart} 02:00 ~ ${nextWeekStart} 02:00\n\n${lines}`)
    .setFooter({ text: `페이지 ${page + 1}/${totalPages} · ${footerPrefix} 기준 · ${WEEKLY_MIN_POINTS}포인트 미만 / 제외역할 미보유 / 가입 7일 이상` });
}

function buildDemotionComponents(mode, key, page, totalPages) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dg|${mode}|${key}|${page - 1}`)
        .setLabel('이전 페이지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`dg|${mode}|${key}|${page + 1}`)
        .setLabel('다음 페이지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    )
  ];
}

function createTotalPointsEmbedPaged(fullList, page, pageSize) {
  const total = fullList.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = clamp(page, 0, totalPages - 1);

  const start = p * pageSize;
  const slice = fullList.slice(start, start + pageSize);

  const lines = slice.length
    ? slice.map((r, i) => {
        const rankNo = start + i + 1;
        return `**${rankNo}위** ${r.nick} — **${r.totalPoints}포인트** 〔기본: ${r.basePoints} / 수동조정: ${r.manualAdjust}〕`;
      }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle('인처단 전체 누적 포인트')
    .setDescription(lines)
    .setFooter({ text: `페이지 ${p + 1}/${totalPages}` });
}

// ================== 자동 초기화 / 스냅샷 ==================
function pruneOldDaily(keepDays) {
  const cutoff = addDays(getReportDate(), -keepDays);

  for (const u of Object.values(data.인처단.users || {})) {
    if (!u.daily) continue;
    for (const dateKey of Object.keys(u.daily)) {
      if (dateKey < cutoff) delete u.daily[dateKey];
    }
  }

  for (const dateKey of Object.keys(data.인처단.history.daily || {})) {
    if (dateKey < cutoff) delete data.인처단.history.daily[dateKey];
  }

  dayTotalsCache.clear();
}

function pruneOldWeekly(keepWeeks) {
  const cutoff = addDays(getReportDate(), -(keepWeeks * 7));
  for (const k of Object.keys(data.인처단.history.weekly || {})) {
    if (k < cutoff) delete data.인처단.history.weekly[k];
  }
}

function makeDailySnapshot(dateStr) {
  const ids = Object.keys(data.인처단.users || {});
  const { display } = buildDayScoresForMembers(dateStr, ids);
  return display.map(r => ({
    userId: r.userId,
    nick: r.nick,
    보고서처리: r.보고서처리,
    전역전출처리: r.전역전출처리,
    군탈처리: r.군탈처리,
    points: r.points
  }));
}

function makeWeeklySnapshot(weekStart) {
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const totals = {};

  for (const [uid, u] of Object.entries(data.인처단.users || {})) {
    totals[uid] = {
      userId: uid,
      nick: u?.nick || `<@${uid}>`,
      weeklyTotal: 0
    };
  }

  for (const d of weekDates) {
    const totalsMap = getDayTotalsOnly(d);
    for (const [uid, t] of totalsMap.entries()) {
      if (!totals[uid]) totals[uid] = {
        userId: uid,
        nick: data.인처단.users?.[uid]?.nick || `<@${uid}>`,
        weeklyTotal: 0
      };
      totals[uid].weeklyTotal += t;
    }
  }

  const list = Object.values(totals)
    .filter(x => x.weeklyTotal > WEEKLY_MIN_POINTS)
    .sort((a, b) => b.weeklyTotal - a.weeklyTotal);

  return {
    weekStart,
    nextWeekStart: addDays(weekStart, 7),
    list: list.map(x => ({ userId: x.userId, nick: x.nick, weeklyTotal: x.weeklyTotal }))
  };
}

function runDailyAutoReset() {
  const y = getYesterdayDate();
  data.인처단.history.daily[y] = makeDailySnapshot(y);

  pruneOldDaily(28);
  recomputeTotals(data.인처단);
  saveData();
  console.log(`🧹 인처단 어제 스냅샷 저장 완료 (${y})`);
}

function runWeeklyAutoReset() {
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);
  const lastWeekStart = addDays(thisWeekStart, -7);

  data.인처단.history.weekly[lastWeekStart] = makeWeeklySnapshot(lastWeekStart);
  data.인처단.lastWeekStart = lastWeekStart;
  data.인처단.weekStart = thisWeekStart;

  pruneOldWeekly(16);
  recomputeTotals(data.인처단);
  saveData();
  console.log(`🔄 인처단 주간 초기화 완료 (weekStart=${thisWeekStart}, lastWeekStart=${lastWeekStart})`);
}

// ================== 강등 대상 계산 ==================
async function buildDemotionListForWeek(guild, weekStart) {
  const members = await guild.members.fetch();
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const eligible = [];
  for (const [, m] of members) {
    if (m.user?.bot) continue;
    if (!m.roles.cache.has(PERSONNEL_PROCESSING_ROLE_ID)) continue;
    if (m.roles.cache.has(DEMOTION_EXCLUDED_ROLE_ID)) continue;
    if (daysSinceJoined(m) < 7) continue;
    eligible.push(m);
  }

  const list = [];

  for (const member of eligible) {
    let totalScore = 0;

    for (const d of weekDates) {
      const dayTotals = getDayTotalsOnly(d);
      totalScore += (dayTotals.get(member.id) || 0);
    }

    if (totalScore < WEEKLY_MIN_POINTS) {
      list.push({
        userId: member.id,
        mention: `<@${member.id}>`,
        totalScore
      });
    }
  }

  list.sort((a, b) => a.totalScore - b.totalScore);
  return list;
}

// ================== 명령어 등록 ==================
async function registerCommands() {
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return console.log('서버를 찾을 수 없습니다.');

  const 인처단행정보고 = new SlashCommandBuilder()
    .setName('인처단행정보고')
    .setDescription('인처단 행정 보고서 (인처단 역할 전용 / 02시~익일 02시 기준 하루 1회)')
    .addIntegerOption(o => o.setName('보고서처리').setDescription('보고서 처리 건수').setRequired(true))
    .addIntegerOption(o => o.setName('전역전출처리').setDescription('전역 / 전출 처리 건수').setRequired(true))
    .addIntegerOption(o => o.setName('군탈처리').setDescription('군탈 처리 건수').setRequired(true))
    .addAttachmentOption(o => o.setName('증거1').setDescription('사진 증거 1').setRequired(false))
    .addAttachmentOption(o => o.setName('증거2').setDescription('사진 증거 2').setRequired(false))
    .addAttachmentOption(o => o.setName('증거3').setDescription('사진 증거 3').setRequired(false))
    .addAttachmentOption(o => o.setName('증거4').setDescription('사진 증거 4').setRequired(false))
    .addAttachmentOption(o => o.setName('증거5').setDescription('사진 증거 5').setRequired(false))
    .addAttachmentOption(o => o.setName('증거6').setDescription('사진 증거 6').setRequired(false))
    .addAttachmentOption(o => o.setName('증거7').setDescription('사진 증거 7').setRequired(false))
    .addAttachmentOption(o => o.setName('증거8').setDescription('사진 증거 8').setRequired(false))
    .addAttachmentOption(o => o.setName('증거9').setDescription('사진 증거 9').setRequired(false))
    .addAttachmentOption(o => o.setName('증거10').setDescription('사진 증거 10').setRequired(false));

  const 인처단오늘초기화 = new SlashCommandBuilder()
    .setName('인처단오늘초기화')
    .setDescription('인처단 오늘 기록 초기화 - 특정 유저 또는 전체')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 유저를 오늘 기록 초기화').setRequired(false));

  await guild.commands.set([
    인처단행정보고.toJSON(),

    new SlashCommandBuilder().setName('인처단오늘건수').setDescription('인처단 오늘 건수/포인트 조회').toJSON(),
    new SlashCommandBuilder().setName('인처단어제건수').setDescription('인처단 어제 건수/포인트 조회').toJSON(),
    new SlashCommandBuilder().setName('이번주인처단점수').setDescription('인처단 이번 주 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('지난주인처단점수').setDescription('인처단 지난 주 점수 조회').toJSON(),

    new SlashCommandBuilder().setName('인처단강등대상').setDescription(`인처단 이번 주 주간 총합 ${WEEKLY_MIN_POINTS}포인트 미만 강등 대상 조회`).toJSON(),
    new SlashCommandBuilder().setName('지난주인처단강등대상').setDescription(`인처단 지난 주 주간 총합 ${WEEKLY_MIN_POINTS}포인트 미만 강등 대상 조회`).toJSON(),

    new SlashCommandBuilder()
      .setName('누적포인트')
      .setDescription('특정 유저의 최종 누적 포인트(일일합산 + 수동조정) 조회')
      .addUserOption(o => o.setName('대상').setDescription('조회할 유저').setRequired(true))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('전체누적포인트')
      .setDescription('인처단 전체 인원의 누적 전체 포인트 조회')
      .toJSON(),

    new SlashCommandBuilder()
      .setName('누적포인트수정')
      .setDescription('특정 유저의 누적 포인트를 수동 조정합니다')
      .addUserOption(o =>
        o.setName('대상')
          .setDescription('수정할 유저')
          .setRequired(true)
      )
      .addStringOption(o =>
        o.setName('방식')
          .setDescription('add=추가 / sub=차감 / set=직접설정')
          .setRequired(true)
          .addChoices(
            { name: '추가', value: 'add' },
            { name: '차감', value: 'sub' },
            { name: '직접설정', value: 'set' }
          )
      )
      .addIntegerOption(o =>
        o.setName('포인트')
          .setDescription('적용할 포인트')
          .setRequired(true)
      )
      .addStringOption(o =>
        o.setName('사유')
          .setDescription('수정 사유')
          .setRequired(false)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('누적포인트조정조회')
      .setDescription('특정 유저의 누적 포인트 수동 조정 내역 조회')
      .addUserOption(o =>
        o.setName('대상')
          .setDescription('조회할 유저')
          .setRequired(true)
      )
      .toJSON(),

    인처단오늘초기화.toJSON(),
    new SlashCommandBuilder().setName('인처단초기화주간').setDescription('인처단 주간 전체 초기화').toJSON(),
    new SlashCommandBuilder().setName('인처단통계').setDescription('인처단 전체 통계').toJSON()
  ]);

  console.log('✅ 인처단 명령어 등록 완료');
  console.log(`✅ CLIENT_ID: ${CLIENT_ID}`);
}

// ================== ready ==================
client.once('ready', async () => {
  console.log(`${client.user.tag} 준비 완료!`);
  loadData();

  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  if (!data.인처단.weekStart) data.인처단.weekStart = thisWeekStart;
  recomputeTotals(data.인처단);
  saveData();

  if (!fs.existsSync(GOOGLE_KEYFILE)) {
    console.log(`⚠️ GOOGLE KEYFILE을 찾을 수 없습니다: ${GOOGLE_KEYFILE}`);
    console.log('   Railway Variables에 GOOGLE_SA_JSON을 추가했는지 확인하세요.');
  }

  await verifyGoogleSheetAccess();
  await registerCommands();

  cron.schedule('0 2 * * *', () => runDailyAutoReset(), { timezone: 'Asia/Seoul' });
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(), { timezone: 'Asia/Seoul' });

  console.log('⏰ 인처단 자동 스냅샷/초기화 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

// ================== interactionCreate ==================
client.on('interactionCreate', async interaction => {
  // ================== 버튼 처리 ==================
  if (interaction.isButton()) {
    const customId = interaction.customId || '';

    if (customId.startsWith('pg|')) {
      const isManager = () => hasRole(interaction.member, ALL_COMMAND_MANAGER_ROLE_ID);
      if (!isManager()) {
        return interaction.reply({ content: '❌ 지정된 관리 역할만 사용할 수 있습니다.', ephemeral: true });
      }

      const parts = customId.split('|');
      const mode = parts[1];
      const key = parts[2];
      const page = parseInt(parts[3], 10) || 0;

      const msgId = interaction.message?.id;
      const session = msgId ? paginationSessions.get(msgId) : null;

      if (!session || session.mode !== mode || session.key !== key) {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

        const memberIds = await getEligibleMemberIds(guild);
        let newSession = null;

        if (mode === 'today' || mode === 'yesterday') {
          const dateStr = key;
          const { display } = buildDayScoresForMembers(dateStr, memberIds);
          newSession = { mode, key: dateStr, list: display, pageSize: 28 };
        } else if (mode === 'week' || mode === 'lastweek') {
          const weekStart = key;
          const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

          const totals = {};
          for (const uid of memberIds) {
            totals[uid] = {
              userId: uid,
              nick: data.인처단.users?.[uid]?.nick || `<@${uid}>`,
              weeklyTotal: 0
            };
          }

          for (const d of weekDates) {
            const totalsMap = getDayTotalsOnly(d);
            for (const uid of memberIds) {
              totals[uid].weeklyTotal += (totalsMap.get(uid) || 0);
            }
          }

          const list = Object.values(totals)
            .filter(x => x.weeklyTotal > WEEKLY_MIN_POINTS)
            .sort((a, b) => b.weeklyTotal - a.weeklyTotal);

          newSession = { mode, key: weekStart, list, pageSize: 28 };
        } else if (mode === 'total') {
          const list = memberIds.map(uid => {
            const userObj = data.인처단.users?.[uid];
            const basePoints = getBasePointsOfUser(userObj);
            const manualAdjust = userObj?.manualAdjust || 0;
            return {
              userId: uid,
              nick: userObj?.nick || `<@${uid}>`,
              totalPoints: userObj?.totalPoints || 0,
              basePoints,
              manualAdjust
            };
          }).sort((a, b) => b.totalPoints - a.totalPoints);

          newSession = { mode, key: 'all', list, pageSize: 28 };
        }

        if (!newSession) {
          return interaction.reply({ content: '❌ 페이지 정보를 처리할 수 없습니다.', ephemeral: true });
        }

        paginationSessions.set(msgId, newSession);
      }

      const s = paginationSessions.get(msgId);
      const pageSize = s.pageSize || 28;

      if (s.mode === 'today' || s.mode === 'yesterday') {
        const dateStr = s.key;
        const totalPages = Math.max(1, Math.ceil(s.list.length / pageSize));
        const p = clamp(page, 0, totalPages - 1);

        const titlePrefix = s.mode === 'today' ? '오늘 건수' : '어제 건수';
        const embed = createDailyEmbedPaged(dateStr, s.list, p, pageSize, titlePrefix);
        const components = buildPagerComponents(s.mode, s.key, p, totalPages);

        return interaction.update({ embeds: [embed], components });
      }

      if (s.mode === 'week' || s.mode === 'lastweek') {
        const weekStart = s.key;
        const totalPages = Math.max(1, Math.ceil(s.list.length / pageSize));
        const p = clamp(page, 0, totalPages - 1);

        const titlePrefix = s.mode === 'week' ? '이번주 점수' : '지난주 점수';
        const embed = createWeeklyEmbedPaged(weekStart, s.list, p, pageSize, titlePrefix);
        const components = buildPagerComponents(s.mode, s.key, p, totalPages);

        return interaction.update({ embeds: [embed], components });
      }

      if (s.mode === 'total') {
        const totalPages = Math.max(1, Math.ceil(s.list.length / pageSize));
        const p = clamp(page, 0, totalPages - 1);

        const embed = createTotalPointsEmbedPaged(s.list, p, pageSize);
        const components = buildPagerComponents(s.mode, s.key, p, totalPages);

        return interaction.update({ embeds: [embed], components });
      }

      return;
    }

    if (customId.startsWith('dg|')) {
      const allowed = hasRole(interaction.member, ALL_COMMAND_MANAGER_ROLE_ID);
      if (!allowed) {
        return interaction.reply({ content: '❌ 지정된 관리 역할만 사용할 수 있습니다.', ephemeral: true });
      }

      const parts = customId.split('|');
      const mode = parts[1];
      const key = parts[2];
      const page = parseInt(parts[3], 10) || 0;

      const msgId = interaction.message?.id;
      const session = msgId ? paginationSessions.get(msgId) : null;

      if (!session || session.mode !== mode || session.key !== key) {
        return interaction.reply({ content: 'ℹ️ 페이지 세션이 만료되었습니다. 명령어를 다시 실행하세요.', ephemeral: true });
      }

      const pageSize = session.pageSize || 28;
      const list = session.list || [];
      const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
      const p = clamp(page, 0, totalPages - 1);

      const isLastWeek = mode === 'demotion_lastweek';
      const weekStart = key;

      const embed = createDemotionEmbed(
        list,
        p,
        pageSize,
        totalPages,
        isLastWeek ? '지난주 인처단 강등 대상' : '인처단 강등 대상',
        isLastWeek ? '지난 주' : '현재 주',
        weekStart
      );

      const components = buildDemotionComponents(mode, key, p, totalPages);

      return interaction.update({ embeds: [embed], components });
    }

    return;
  }

  // ================== 슬래시 처리 ==================
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  const guild = interaction.guild;

  const isManager = () => hasRole(interaction.member, ALL_COMMAND_MANAGER_ROLE_ID);
  const isPersonnelProcessing = () => hasRole(interaction.member, PERSONNEL_PROCESSING_ROLE_ID);

  if (cmd === '인처단행정보고') {
    if (!isPersonnelProcessing()) {
      return interaction.reply({
        content: `❌ 이 명령어는 **인처단 역할**(<@&${PERSONNEL_PROCESSING_ROLE_ID}>)만 사용할 수 있습니다.`,
        ephemeral: true
      });
    }
  }

  if (cmd !== '인처단행정보고') {
    if (!isManager()) {
      return interaction.reply({
        content: `❌ 지정된 관리 역할(<@&${ALL_COMMAND_MANAGER_ROLE_ID}>)만 이 봇 명령어를 사용할 수 있습니다.`,
        ephemeral: true
      });
    }
  }

  // ================== 인처단 행정보고 ==================
  if (cmd === '인처단행정보고') {
    const date = getReportDate();
    const mention = `<@${interaction.user.id}>`;
    const displayName = interaction.member?.displayName || interaction.user.username;

    const input = {
      보고서처리: interaction.options.getInteger('보고서처리'),
      전역전출처리: interaction.options.getInteger('전역전출처리'),
      군탈처리: interaction.options.getInteger('군탈처리')
    };

    let evidences = [];
    try {
      evidences = collectEvidenceAttachments(interaction);
    } catch (err) {
      return interaction.reply({
        content: `❌ ${err.message}`,
        ephemeral: true
      });
    }

    const points = calculatePoints(input);

    if (!data.인처단.users[interaction.user.id]) {
      data.인처단.users[interaction.user.id] = {
        nick: displayName,
        totalPoints: 0,
        manualAdjust: 0,
        adjustLogs: [],
        daily: {}
      };
    }

    const u = data.인처단.users[interaction.user.id];
    u.nick = displayName;
    if (typeof u.manualAdjust !== 'number') u.manualAdjust = 0;
    if (!Array.isArray(u.adjustLogs)) u.adjustLogs = [];

    if (u.daily[date]) {
      return interaction.reply({
        content:
          `❌ 오늘(${date}, 02:00 ~ 익일 02:00 기준)은 이미 **인처단 행정보고**를 완료했습니다.\n` +
          `기록을 다시 제출해야 하면 관리자 역할이 **/인처단오늘초기화 대상:@유저** 명령어로 초기화한 뒤 다시 보고해 주세요.`,
        ephemeral: true
      });
    }

    u.daily[date] = {
      보고서처리: input.보고서처리,
      전역전출처리: input.전역전출처리,
      군탈처리: input.군탈처리,
      points,
      evidences
    };

    recomputeTotals(data.인처단);
    dayTotalsCache.delete(`인처단|${date}`);
    saveData();

    let replyText =
      `✅ **인처단 보고 완료!**\n` +
      `**닉네임**: ${mention}\n` +
      `**일자**: ${date}\n` +
      `**기준**: 02:00 ~ 익일 02:00 (하루 1회 제출)\n\n` +
      `**보고서 처리**: ${input.보고서처리}건\n` +
      `**전역 / 전출 처리**: ${input.전역전출처리}건\n` +
      `**군탈 처리**: ${input.군탈처리}건\n` +
      `**총 포인트**: ${points}포인트\n` +
      `**증거 사진**: ${evidences.length}개`;

    if (evidences.length > 0) {
      replyText += '\n\n**첨부된 증거 사진 목록**';
      for (let i = 0; i < evidences.length; i++) {
        replyText += `\n${i + 1}. ${evidences[i].url}`;
      }
    }

    try {
      await appendRowToSheet('인처단!A:F', [
        date,
        displayName,
        input.보고서처리,
        input.전역전출처리,
        input.군탈처리,
        points
      ]);
    } catch (e) {
      console.error('❌ 구글시트 저장 실패:', e);
      replyText += `\n\n⚠️ 구글 시트 자동 기입에 실패했습니다.`;
      replyText += `\n- 시트 ID 확인`;
      replyText += `\n- 탭 이름 "인처단" 확인`;
      replyText += `\n- 서비스 계정 편집 권한 확인`;
      replyText += `\n- Railway Logs 확인`;
    }

    return interaction.reply({
      content: replyText,
      ephemeral: false
    });
  }

  // ================== 공용 응답 함수 ==================
  async function replyDailyPaged(dateStr, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const memberIds = await getEligibleMemberIds(guild);
    const { display } = buildDayScoresForMembers(dateStr, memberIds);

    const pageSize = 28;
    const page = 0;
    const totalPages = Math.max(1, Math.ceil(display.length / pageSize));

    const titlePrefix = mode === 'today' ? '오늘 건수' : '어제 건수';
    const embed = createDailyEmbedPaged(dateStr, display, page, pageSize, titlePrefix);
    const components = buildPagerComponents(mode, dateStr, page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { mode, key: dateStr, list: display, pageSize });
  }

  async function replyWeeklyPaged(weekStart, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const memberIds = await getEligibleMemberIds(guild);
    const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

    const totals = {};
    for (const uid of memberIds) {
      totals[uid] = {
        userId: uid,
        nick: data.인처단.users?.[uid]?.nick || `<@${uid}>`,
        weeklyTotal: 0
      };
    }

    for (const d of weekDates) {
      const totalsMap = getDayTotalsOnly(d);
      for (const uid of memberIds) {
        totals[uid].weeklyTotal += (totalsMap.get(uid) || 0);
      }
    }

    const list = Object.values(totals)
      .filter(x => x.weeklyTotal > WEEKLY_MIN_POINTS)
      .sort((a, b) => b.weeklyTotal - a.weeklyTotal);

    const pageSize = 28;
    const page = 0;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));

    const titlePrefix = mode === 'week' ? '이번주 점수' : '지난주 점수';
    const embed = createWeeklyEmbedPaged(weekStart, list, page, pageSize, titlePrefix);
    const components = buildPagerComponents(mode, weekStart, page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { mode, key: weekStart, list, pageSize });
  }

  async function replyDemotionPaged(weekStart, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const list = await buildDemotionListForWeek(guild, weekStart);
    const pageSize = 28;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    const page = 0;
    const isLastWeek = mode === 'demotion_lastweek';

    const embed = createDemotionEmbed(
      list,
      page,
      pageSize,
      totalPages,
      isLastWeek ? '지난주 인처단 강등 대상' : '인처단 강등 대상',
      isLastWeek ? '지난 주' : '현재 주',
      weekStart
    );

    const components = buildDemotionComponents(mode, weekStart, page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { mode, key: weekStart, list, pageSize });
  }

  // ================== 점수 조회 ==================
  if (cmd === '인처단오늘건수') return replyDailyPaged(getReportDate(), 'today');
  if (cmd === '인처단어제건수') return replyDailyPaged(getYesterdayDate(), 'yesterday');

  if (cmd === '이번주인처단점수') {
    const weekStart = data.인처단.weekStart || getSundayWeekStart(getReportDate());
    return replyWeeklyPaged(weekStart, 'week');
  }

  if (cmd === '지난주인처단점수') {
    const thisWeekStart = data.인처단.weekStart || getSundayWeekStart(getReportDate());
    const lastWeekStart = data.인처단.lastWeekStart || addDays(thisWeekStart, -7);
    return replyWeeklyPaged(lastWeekStart, 'lastweek');
  }

  // ================== 강등 대상 ==================
  if (cmd === '인처단강등대상') {
    const currentWeekStart = getSundayWeekStart(getReportDate());
    return replyDemotionPaged(currentWeekStart, 'demotion_current');
  }

  if (cmd === '지난주인처단강등대상') {
    const thisWeekStart = getSundayWeekStart(getReportDate());
    const lastWeekStart = addDays(thisWeekStart, -7);
    return replyDemotionPaged(lastWeekStart, 'demotion_lastweek');
  }

  // ================== 누적 포인트 ==================
  if (cmd === '누적포인트') {
    const target = interaction.options.getUser('대상');
    const uid = target.id;

    const saved = data.인처단.users?.[uid];
    const totalPoints = saved?.totalPoints || 0;
    const nick = saved?.nick || target.username;
    const basePoints = getBasePointsOfUser(saved);
    const manualAdjust = saved?.manualAdjust || 0;

    const embed = new EmbedBuilder()
      .setTitle('누적 포인트 조회')
      .setDescription(
        `**대상:** <@${uid}>\n` +
        `**닉네임:** ${nick}\n` +
        `**기본 누적 포인트:** ${basePoints}포인트\n` +
        `**수동 조정 포인트:** ${manualAdjust}포인트\n` +
        `**최종 누적 포인트:** ${totalPoints}포인트`
      );

    return interaction.reply({ embeds: [embed] });
  }

  if (cmd === '전체누적포인트') {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const memberIds = await getEligibleMemberIds(guild);
    const list = memberIds.map(uid => {
      const userObj = data.인처단.users?.[uid];
      const basePoints = getBasePointsOfUser(userObj);
      const manualAdjust = userObj?.manualAdjust || 0;

      return {
        userId: uid,
        nick: userObj?.nick || `<@${uid}>`,
        totalPoints: userObj?.totalPoints || 0,
        basePoints,
        manualAdjust
      };
    }).sort((a, b) => b.totalPoints - a.totalPoints);

    const pageSize = 28;
    const page = 0;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));

    const embed = createTotalPointsEmbedPaged(list, page, pageSize);
    const components = buildPagerComponents('total', 'all', page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { mode: 'total', key: 'all', list, pageSize });
    return;
  }

  // ================== 누적 포인트 수동 수정 ==================
  if (cmd === '누적포인트수정') {
    const target = interaction.options.getUser('대상');
    const mode = interaction.options.getString('방식');
    const point = interaction.options.getInteger('포인트');
    const reason = interaction.options.getString('사유') || '사유 없음';

    if (point < 0) {
      return interaction.reply({
        content: '❌ 포인트는 0 이상 정수만 입력할 수 있습니다.',
        ephemeral: true
      });
    }

    const uid = target.id;

    if (!data.인처단.users[uid]) {
      data.인처단.users[uid] = {
        nick: target.username,
        totalPoints: 0,
        manualAdjust: 0,
        adjustLogs: [],
        daily: {}
      };
    }

    const u = data.인처단.users[uid];
    if (typeof u.manualAdjust !== 'number') u.manualAdjust = 0;
    if (!Array.isArray(u.adjustLogs)) u.adjustLogs = [];
    if (!u.daily) u.daily = {};
    if (!u.nick) u.nick = target.username;

    const basePoints = getBasePointsOfUser(u);
    const beforeManual = u.manualAdjust;
    const beforeTotal = basePoints + beforeManual;

    if (mode === 'add') {
      u.manualAdjust += point;
    } else if (mode === 'sub') {
      u.manualAdjust -= point;
    } else if (mode === 'set') {
      u.manualAdjust = point - basePoints;
    } else {
      return interaction.reply({
        content: '❌ 잘못된 방식입니다.',
        ephemeral: true
      });
    }

    recomputeTotals(data.인처단);

    const afterManual = u.manualAdjust;
    const afterTotal = u.totalPoints;

    u.adjustLogs.unshift({
      at: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString(),
      managerId: interaction.user.id,
      managerTag: interaction.user.tag,
      mode,
      point,
      reason,
      beforeManual,
      afterManual,
      beforeTotal,
      afterTotal
    });

    if (u.adjustLogs.length > 50) {
      u.adjustLogs = u.adjustLogs.slice(0, 50);
    }

    saveData();

    const modeText =
      mode === 'add' ? '추가' :
      mode === 'sub' ? '차감' :
      '직접설정';

    const embed = new EmbedBuilder()
      .setTitle('누적 포인트 수정 완료')
      .setDescription(
        `**대상:** <@${uid}>\n` +
        `**닉네임:** ${u.nick || target.username}\n` +
        `**수정 방식:** ${modeText}\n` +
        `**입력 포인트:** ${point}\n` +
        `**기본 누적 포인트(daily 합산):** ${basePoints}\n` +
        `**수동 조정 포인트:** ${beforeManual} → ${afterManual}\n` +
        `**최종 누적 포인트:** ${beforeTotal} → ${afterTotal}\n` +
        `**사유:** ${reason}\n` +
        `**처리 관리자:** <@${interaction.user.id}>`
      );

    return interaction.reply({
      embeds: [embed],
      ephemeral: false
    });
  }

  if (cmd === '누적포인트조정조회') {
    const target = interaction.options.getUser('대상');
    const uid = target.id;
    const u = data.인처단.users?.[uid];

    if (!u) {
      return interaction.reply({
        content: 'ℹ️ 해당 유저의 저장된 데이터가 없습니다.',
        ephemeral: true
      });
    }

    const basePoints = getBasePointsOfUser(u);
    const manualAdjust = typeof u.manualAdjust === 'number' ? u.manualAdjust : 0;
    const logs = Array.isArray(u.adjustLogs) ? u.adjustLogs.slice(0, 10) : [];

    const logText = logs.length
      ? logs.map((log, i) => {
          const modeText =
            log.mode === 'add' ? '추가' :
            log.mode === 'sub' ? '차감' :
            '직접설정';

          return (
            `**${i + 1}.** ${log.at}\n` +
            `- 방식: ${modeText}\n` +
            `- 포인트: ${log.point}\n` +
            `- 총 포인트: ${log.beforeTotal} → ${log.afterTotal}\n` +
            `- 사유: ${log.reason}\n` +
            `- 관리자: <@${log.managerId}>`
          );
        }).join('\n\n')
      : '수동 조정 내역이 없습니다.';

    const embed = new EmbedBuilder()
      .setTitle('누적 포인트 수동 조정 조회')
      .setDescription(
        `**대상:** <@${uid}>\n` +
        `**닉네임:** ${u.nick || target.username}\n` +
        `**기본 누적 포인트(daily 합산):** ${basePoints}\n` +
        `**수동 조정 포인트:** ${manualAdjust}\n` +
        `**최종 누적 포인트:** ${u.totalPoints || 0}\n\n` +
        `**최근 조정 내역(최대 10개)**\n${logText}`
      );

    return interaction.reply({ embeds: [embed] });
  }

  // ================== 초기화 ==================
  if (cmd === '인처단초기화주간') {
    const today = getReportDate();
    const thisWeekStart = getSundayWeekStart(today);
    const rangeStart = addDays(thisWeekStart, -7);
    const rangeEnd = thisWeekStart;

    let clearedEntries = 0;

    for (const u of Object.values(data.인처단.users || {})) {
      if (!u.daily) continue;
      for (const dateKey of Object.keys(u.daily)) {
        if (dateKey >= rangeStart && dateKey < rangeEnd) {
          delete u.daily[dateKey];
          clearedEntries++;
        }
      }
    }

    recomputeTotals(data.인처단);
    data.인처단.weekStart = thisWeekStart;

    pruneOldDaily(28);
    pruneOldWeekly(16);
    dayTotalsCache.clear();
    paginationSessions.clear();
    saveData();

    return interaction.reply({
      content:
        `🔄 인처단 주간 초기화 완료\n` +
        `- 오늘(reportDate): ${today}\n` +
        `- 보호(이번 주): ${thisWeekStart} 02:00 이후 ~ 현재\n` +
        `- 삭제 구간(reportDate 7일): ${rangeStart} ~ ${addDays(rangeEnd, -1)}\n` +
        `- 삭제된 daily 항목 수: ${clearedEntries}`,
      ephemeral: false
    });
  }

  if (cmd === '인처단오늘초기화') {
    const date = getReportDate();
    const targetUser = interaction.options.getUser('대상');
    const isAll = interaction.options.getBoolean('전체') === true;

    if (!isAll && !targetUser) {
      return interaction.reply({ content: 'ℹ️ 대상 또는 전체(true)를 선택하세요.', ephemeral: true });
    }

    let cleared = 0;

    if (isAll) {
      for (const uid of Object.keys(data.인처단.users || {})) {
        const u = data.인처단.users[uid];
        if (u?.daily?.[date]) {
          delete u.daily[date];
          cleared++;
        }
      }

      recomputeTotals(data.인처단);
      dayTotalsCache.delete(`인처단|${date}`);
      paginationSessions.clear();
      saveData();

      return interaction.reply({
        content:
          `✅ 오늘(${date}) 인처단 기록 전체 초기화 완료 (${cleared}명)\n` +
          `이제 해당 인원들은 /인처단행정보고를 다시 사용할 수 있습니다.`,
        ephemeral: false
      });
    }

    const uid = targetUser.id;
    const u = data.인처단.users?.[uid];
    if (!u?.daily?.[date]) {
      return interaction.reply({ content: `ℹ️ ${targetUser} 님은 오늘(${date}) 기록이 없습니다.`, ephemeral: true });
    }

    delete u.daily[date];
    recomputeTotals(data.인처단);

    dayTotalsCache.delete(`인처단|${date}`);
    paginationSessions.clear();
    saveData();

    return interaction.reply({
      content:
        `✅ ${targetUser} 님의 오늘(${date}) 인처단 기록을 초기화했습니다.\n` +
        `이제 ${targetUser} 님은 /인처단행정보고를 다시 사용할 수 있습니다.`,
      ephemeral: false
    });
  }

  // ================== 통계 ==================
  if (cmd === '인처단통계') {
    const date = getReportDate();

    let userCount = 0;
    let totalPoints = 0;
    let totalManualAdjust = 0;
    let totalBasePoints = 0;
    let todayPoints = 0;
    let today보고서처리 = 0;
    let today전역전출처리 = 0;
    let today군탈처리 = 0;

    for (const u of Object.values(data.인처단.users || {})) {
      userCount++;
      totalPoints += (u.totalPoints || 0);
      totalManualAdjust += (u.manualAdjust || 0);
      totalBasePoints += getBasePointsOfUser(u);

      const d = u.daily?.[date];
      if (d) {
        todayPoints += (d.points || 0);
        today보고서처리 += (d.보고서처리 || 0);
        today전역전출처리 += (d.전역전출처리 || 0);
        today군탈처리 += (d.군탈처리 || 0);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('인처단 통계')
      .setDescription(
        `**기준 일자(02시~익일 02시 기준)**: ${date}\n\n` +
        `- 등록 인원: ${userCount}명\n` +
        `- 기본 누적 포인트 합계: ${totalBasePoints}\n` +
        `- 수동 조정 포인트 합계: ${totalManualAdjust}\n` +
        `- 최종 누적 포인트 합계: ${totalPoints}\n` +
        `- 오늘 보고서 처리: ${today보고서처리}건\n` +
        `- 오늘 전역 / 전출 처리: ${today전역전출처리}건\n` +
        `- 오늘 군탈 처리: ${today군탈처리}건\n` +
        `- 오늘 총 포인트: ${todayPoints}\n\n` +
        `※ 보고서처리 1건=1포인트 / 전역·전출 1건=5포인트 / 군탈 1건=5포인트\n` +
        `※ ${DAILY_MIN_POINTS}포인트 이하는 오늘/어제/주간 조회에서 제외됩니다.\n` +
        `※ 행정보고는 02시~익일 02시 기준 하루 1회만 제출 가능합니다.`
      );

    return interaction.reply({ embeds: [embed] });
  }
});

// ================== TOKEN 체크 ==================
if (!TOKEN) {
  console.log('❌ TOKEN이 설정되지 않았습니다! Railway Variables의 TOKEN 확인');
  process.exit(1);
}

client.login(TOKEN);

/*
================== 최종 반영 사항 ==================

1) 역할 ID
- 인처단 보고 가능 역할: 1486733583740567692
- 모든 관리 명령어 사용 가능 역할: 1489255392168120350
- 강등대상 제외 역할: 1486229581190004752

2) 입력 항목
- 보고서처리
- 전역전출처리
- 군탈처리
- 증거1 ~ 증거10 (사진 첨부)

3) 포인트 계산
- 보고서 처리 1건 = 1포인트
- 전역 / 전출 처리 1건 = 5포인트
- 군탈 처리 1건 = 5포인트

4) 일일/주간 기준
- 일일 최소 행정 기준: 20포인트
  → 20포인트 이하면 /인처단오늘건수, /인처단어제건수 등 조회 목록에서 제외
- 주간 강등 기준: 140포인트 미만
  → /인처단강등대상, /지난주인처단강등대상 포함

5) 구글 시트 저장 형식
A 날짜
B 닉네임
C 보고서 처리
D 전역 / 전출 처리
E 군탈 처리
F 총포인트
※ 증거 사진은 구글 시트에 저장 안 함
※ F열 총포인트는 수정된 계산식(1 / 5 / 5) 기준으로 저장됨

6) 보고 명령어
- /인처단행정보고
  → 1486733583740567692 역할만 사용 가능
  → 사진 증거 최대 10개 첨부 가능

7) 조회 명령어
- /인처단오늘건수
- /인처단어제건수
- /이번주인처단점수
- /지난주인처단점수

8) 강등 대상 명령어
- /인처단강등대상
- /지난주인처단강등대상
→ 제외 기준:
   1. 1486229581190004752 역할 보유
   2. 서버 가입 7일 미만
   3. 주간 140포인트 이상

9) 주간 기준
- 일요일 새벽 2시 ~ 다음주 일요일 새벽 2시

10) 누적 포인트 명령어
- /누적포인트 대상:@유저
- /전체누적포인트

11) 누적 포인트 수동 조정 명령어
- /누적포인트수정
  방식:
  - 추가(add)
  - 차감(sub)
  - 직접설정(set)
- /누적포인트조정조회

12) 수동 조정 방식
- 기본 누적 포인트 = daily 합산
- 수동 조정 포인트 = 관리자가 추가/차감/직접설정한 값
- 최종 누적 포인트 = 기본 누적 포인트 + 수동 조정 포인트
※ recomputeTotals 실행 시에도 수동 조정값이 유지됨

13) 1일 1회 제한
- /인처단행정보고는 02:00 ~ 익일 02:00 기준 하루 1회만 가능

14) 시트 탭 이름
- 반드시 '인처단'

15) 스프레드시트 정보
- SPREADSHEET_ID: 1-ab0QPdvcBCj1uRk-1iMv8vyxvWbQJO07coZISBU0TM
- SERVICE_ACCOUNT_EMAIL: ffulfillment-management-bot4@fulfillment-management-bot4.iam.gserviceaccount.com
- CLIENT_ID: 1489904266461319218

16) Railway 환경변수
- TOKEN
- GOOGLE_SA_JSON
- (선택) GOOGLE_KEYFILE
*/
