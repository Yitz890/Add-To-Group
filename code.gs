/**
 * GroupMe Bot – No Key Required.
 * Just deploy and set the callback URL.
 */
const CONFIG = {
  GROUPME_ACCESS_TOKEN: '',
  GROUPME_BOT_ID: '',
  GROUP_MAP: {

"GroupName: groupid",
  }
};

const API_URL = 'https://api.groupme.com/v3';
const PROPERTIES = PropertiesService.getScriptProperties();
const RECORDS_KEY = 'managed_members';
const USER_COUNTER_KEY = 'auto_user_number';
const DEBUG = true;

function logDebug(msg) {
  if (DEBUG) console.log(`[DEBUG] ${msg}`);
}

// ===== WEBHOOK ENTRY POINTS =====

function doGet() {
  return ContentService.createTextOutput('GroupMe bot online.');
}

function doPost(e) {
  logDebug('doPost called');
  try {
    const raw = e.postData?.contents || '{}';
    const msg = JSON.parse(raw);
    logDebug(`Received: ${JSON.stringify(msg)}`);
    handleMessage_(msg);
  } catch (err) {
    console.error(`doPost error: ${err.message}`);
    try { postBotMessage_(`⚠️ Error: ${err.message}`); } catch(e) {}
  }
  return ok_();
}

// ===== MESSAGE HANDLER =====

function handleMessage_(msg) {
  logDebug('handleMessage_ started');

  // Always confirm receipt for user messages
  if (msg.sender_type === 'user' && !msg.system) {
    const txt = String(msg.text || '').trim();
    postBotMessage_(`✅ Bot received: "${txt}" (will process)`);
  }

  const text = String(msg.text || '').trim().toLowerCase();
  if (text === '!debug') {
    postBotMessage_(buildDebugMessage_());
    return;
  }
  if (handlePublicListAddon_(msg)) return;
  if (msg.sender_type !== 'user' || msg.system) return;

  if (isHelpCommand(text)) {
    postBotMessage_(buildHelpMessage());
    return;
  }

  const command = parseCommand_(text);
  if (!command) {
    postBotMessage_('❌ Could not parse. Use: `add "Name" 1234567890 groupkey` or `!help`.');
    return;
  }

  const groupId = CONFIG.GROUP_MAP[command.groupKey];
  if (!groupId) {
    postBotMessage_(`❌ Group "${command.groupKey}" not found. Use !help.`);
    return;
  }

  if (command.type === 'lookup') {
    const id = getMemberRecord_(groupId, command.phone);
    postBotMessage_(id ? `${command.phone} is managed here.` : `${command.phone} is not managed.`);
    return;
  }

  if (command.type === 'add') {
    const name = command.name || getNextAutoName_();
    const result = addMember_(groupId, name, command.phone);
    postBotMessage_(result.ok ? `✅ Added ${name} to "${command.groupKey}".` : `❌ ${result.error}`);
    return;
  }

  // remove
  const result = command.removeBy === 'phone' ?
    removeMemberByPhone_(groupId, command.value) :
    removeMemberByName_(groupId, command.value);
  postBotMessage_(result.ok ? `✅ Removed ${command.value} from "${command.groupKey}".` : `❌ ${result.error}`);
}

// ===== PARSING (flexible) =====

function parseCommand_(text) {
  logDebug(`Parsing: "${text}"`);
  const phoneMatch = text.match(/([\d\s\+\-]{7,})/);
  if (!phoneMatch) return null;
  const phoneRaw = phoneMatch[1].trim();
  const phone = normalizePhone_(phoneRaw);
  if (!phone) return null;

  const before = text.substring(0, phoneMatch.index).trim();
  const after = text.substring(phoneMatch.index + phoneRaw.length).trim();
  const all = before + ' ' + after;
  const words = text.split(/\s+/);
  const verb = words[0].toLowerCase();
  if (!['add','remove','lookup'].includes(verb)) return null;

  // Find group key (longest match)
  const keys = Object.keys(CONFIG.GROUP_MAP).sort((a,b) => b.length - a.length);
  let groupKey = null, remaining = all;
  for (const k of keys) {
    if (all.toLowerCase().includes(k.toLowerCase())) {
      groupKey = k;
      remaining = all.replace(new RegExp(k, 'i'), '').trim();
      break;
    }
  }
  if (!groupKey) return null;

  const name = remaining || undefined;

  if (verb === 'add') return { type:'add', name: name || getNextAutoName_(), phone, groupKey };
  if (verb === 'remove') {
    const val = name || phone;
    const ph = normalizePhone_(val);
    return ph ? { type:'remove', removeBy:'phone', value:ph, groupKey } : { type:'remove', removeBy:'name', value:val, groupKey };
  }
  if (verb === 'lookup') return { type:'lookup', phone, groupKey };
  return null;
}

function normalizePhone_(v) {
  const d = String(v).replace(/[^0-9]/g,'');
  if (d.length===10) return '+1'+d;
  if (d.length===11 && d.startsWith('1')) return '+'+d;
  if (String(v).startsWith('+') && d.length>=11 && d.length<=15) return '+'+d;
  return null;
}

function isHelpCommand(t) {
  const l = t.toLowerCase().trim();
  return ['!help','!list','!commands'].includes(l) || l.startsWith('!help ');
}

function buildHelpMessage() {
  const shortcuts = Object.keys(CONFIG.GROUP_MAP).sort();
  const lines = [];
  for (let i = 0; i < shortcuts.length; i += 5) lines.push(shortcuts.slice(i, i+5).join(', '));
  return '📋 *Available groups:*\n' + lines.join('\n') +
         '\n\n📝 *Usage:* `add Name 1234567890 groupkey`\nExample: `add Alice 5551234567 td2`';
}

function buildDebugMessage_() {
  const groups = Object.keys(CONFIG.GROUP_MAP).join(', ');
  const managed = Object.values(getMemberRecords_()).reduce((s,g) => s + Object.keys(g||{}).length, 0);
  return `🔍 *Debug*\nBot: ${CONFIG.GROUPME_BOT_ID}\nGroups: ${groups}\nManaged: ${managed}`;
}

function getNextAutoName_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const n = (Number(PROPERTIES.getProperty(USER_COUNTER_KEY)||'0') + 1);
    PROPERTIES.setProperty(USER_COUNTER_KEY, String(n));
    return `User${n}`;
  } finally { lock.releaseLock(); }
}

// ===== ADD / REMOVE / LOOKUP (with detailed error) =====

function addMember_(groupId, name, phone) {
  if (getMemberRecord_(groupId, phone)) return { ok:false, error:'already managed in this group' };
  const guid = Utilities.getUuid();
  const result = groupMeRequest_(`/groups/${groupId}/members/add`, 'post', {
    members: [{ nickname: name, phone_number: phone, guid }]
  });
  if (!result.ok) return result;
  const resultsId = result.data?.response?.results_id || result.data?.id;
  if (!resultsId) return { ok:false, error:'No results ID' };

  const poll = waitForMembershipResult_(groupId, resultsId, guid);
  if (poll.member) {
    const membershipId = poll.member.id || poll.member.membership_id;
    if (membershipId) {
      saveMemberRecord_(groupId, phone, membershipId);
      return { ok:true };
    }
    return { ok:false, error:'Membership ID missing' };
  }
  if (poll.failure) {
    const code = poll.failure.code;
    let msg = '';
    if (code === 401) msg = 'The phone number is not a GroupMe user or is already in the group.';
    else if (code === 404) msg = 'User not found.';
    else if (code === 409) msg = 'User already in group.';
    else msg = `Failed with code ${code}.`;
    return { ok:false, error:msg };
  }
  return { ok:false, error:'Invitation timed out.' };
}

function waitForMembershipResult_(groupId, resultsId, guid) {
  for (let i = 0; i < 12; i++) {
    Utilities.sleep(2000);
    const res = groupMeRequest_(`/groups/${groupId}/members/results/${resultsId}`, 'get');
    if (!res.ok) continue;
    const data = res.data?.response || res.data || {};
    const failed = data.failed || [];
    if (failed.length) {
      const f = failed[0];
      if (f.code) return { failure: f };
    }
    const members = data.members || [];
    for (const item of members) {
      const m = item.member || item;
      if (m.guid === guid) return { member: m };
    }
  }
  return { timeout: true };
}

function removeMemberByPhone_(groupId, phone) {
  const id = getMemberRecord_(groupId, phone);
  if (!id) return { ok:false, error:'not managed by bot' };
  const res = groupMeRequest_(`/groups/${groupId}/members/${id}/remove`, 'post');
  if (res.ok) deleteMemberRecord_(groupId, phone);
  return res;
}

function removeMemberByName_(groupId, name) {
  const group = groupMeRequest_(`/groups/${groupId}`, 'get');
  if (!group.ok) return group;
  const members = group.data?.response?.members || group.data?.members || [];
  const wanted = name.trim().toLowerCase();
  const matches = members.filter(m => String(m.nickname||'').trim().toLowerCase() === wanted);
  if (!matches.length) return { ok:false, error:'person not found' };
  if (matches.length > 1) return { ok:false, error:'multiple matches, use phone' };
  const id = matches[0].id || matches[0].membership_id;
  if (!id) return { ok:false, error:'no membership ID' };
  const res = groupMeRequest_(`/groups/${groupId}/members/${id}/remove`, 'post');
  if (res.ok) deleteMemberRecordById_(groupId, id);
  return res;
}

// ===== PERSISTENT STORAGE =====

function getMemberRecord_(gid, phone) {
  const records = getMemberRecords_();
  return (records[gid] || {})[phone] || null;
}
function saveMemberRecord_(gid, phone, membershipId) {
  updateMemberRecords_(r => {
    if (!r[gid]) r[gid] = {};
    r[gid][phone] = membershipId;
  });
}
function deleteMemberRecord_(gid, phone) {
  updateMemberRecords_(r => {
    if (r[gid]) delete r[gid][phone];
    if (r[gid] && !Object.keys(r[gid]).length) delete r[gid];
  });
}
function deleteMemberRecordById_(gid, membershipId) {
  updateMemberRecords_(r => {
    if (r[gid]) {
      Object.keys(r[gid]).forEach(ph => {
        if (r[gid][ph] === membershipId) delete r[gid][ph];
      });
      if (!Object.keys(r[gid]).length) delete r[gid];
    }
  });
}
function getMemberRecords_() {
  return JSON.parse(PROPERTIES.getProperty(RECORDS_KEY) || '{}') || {};
}
function updateMemberRecords_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const r = getMemberRecords_();
    fn(r);
    PROPERTIES.setProperty(RECORDS_KEY, JSON.stringify(r));
  } finally { lock.releaseLock(); }
}

// ===== API WRAPPERS (with logging) =====

function groupMeRequest_(path, method, payload) {
  try {
    const opts = {
      method,
      headers: { 'X-Access-Token': CONFIG.GROUPME_ACCESS_TOKEN },
      muteHttpExceptions: true
    };
    if (payload) {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(payload);
    }
    const resp = UrlFetchApp.fetch(`${API_URL}${path}`, opts);
    const status = resp.getResponseCode();
    const content = resp.getContentText();
    logDebug(`API ${method} ${path} → ${status}`);
    if (DEBUG) console.log(`Response: ${content}`);
    const data = JSON.parse(content);
    if (status >= 200 && status < 300) return { ok: true, data };
    const err = data?.meta?.errors?.join(', ') || data?.response?.message || data?.message || `HTTP ${status}`;
    return { ok: false, error: err };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function postBotMessage_(text) {
  logDebug(`postBotMessage_: "${text}"`);
  try {
    const resp = UrlFetchApp.fetch(`${API_URL}/bots/post`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ bot_id: CONFIG.GROUPME_BOT_ID, text }),
      muteHttpExceptions: true
    });
    const status = resp.getResponseCode();
    if (status >= 300) console.error(`❌ Bot reply failed (${status}): ${resp.getContentText()}`);
    else logDebug('✅ Bot reply sent');
  } catch (e) { console.error(`❌ postBotMessage_ error: ${e.message}`); }
}

function ok_() { return ContentService.createTextOutput('ok'); }

// ===== /list COMMAND (optional) =====

function handlePublicListAddon_(msg) {
  const text = String(msg.text || '').trim().toLowerCase();
  const match = text.match(/^\/list\s+(.+)$/);
  if (!match) return false;
  const key = match[1].trim();
  const gid = CONFIG.GROUP_MAP[key];
  if (!gid) { postBotMessage_(`❌ Group "${key}" not found.`); return true; }
  const res = groupMeRequest_(`/groups/${gid}`, 'get');
  if (!res.ok) { postBotMessage_(`Could not list: ${res.error}`); return true; }
  const group = res.data?.response || res.data || {};
  const names = (group.members || []).map(m => String(m.nickname || m.name || 'Unknown')).sort();
  let remaining = `Members (${names.length}):\n${names.join('\n')}`;
  const max = 950;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < 1) cut = max;
    postBotMessage_(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining) postBotMessage_(remaining);
  return true;
}
