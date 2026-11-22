// Agent状態付箋 hook（Claude Code 全体: ~/.claude/settings.json から呼ぶ）
// Claude Code の hook 入力(JSON)を stdin で受け取り、hook_event_name ごとに付箋の begin/end を行う。
// 付箋の開き方・閉じ方（アーカイブ手順）は同梱 README.md を参照。
// 使い方: node sticky_hook.mjs [--link <正式なチャットリンク>] [--window <窓口名>] [--owner <担当名>]
// 場所の上書き（任意の環境変数）: STICKY_APP_EXE（付箋アプリ app.exe）、STICKY_NOTE_DIR（付箋Markdownの保存先）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = process.env.STICKY_APP_EXE || path.join(process.env.LOCALAPPDATA || '', 'Markdown Sticky Notes', 'app.exe');
const NOTE_DIR = process.env.STICKY_NOTE_DIR || path.join(process.env.USERPROFILE || '', 'Documents', 'StickyNotes');
const STATE_DIR = path.join(HERE, 'state');
const RECEIPT_DIR = path.join(HERE, 'receipts');
const LOG = path.join(HERE, 'hook.log');

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
// 窓口ごとの上書き: <CLAUDE_PROJECT_DIR>/.claude/sticky-hook.json に {"link","window","owner"} を置ける。
// link は get_session などで正式に取得したリンクだけ。ローカルIDからURLを組み立てない。無ければリンク行を出さない。
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || '';
let proj = {};
try { if (PROJECT_DIR) proj = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, '.claude', 'sticky-hook.json'), 'utf8')); } catch {}
const LINK = opt('--link', proj.link || '');
const WINDOW = opt('--window', proj.window || (PROJECT_DIR ? path.basename(PROJECT_DIR) : 'Claude窓口'));
const OWNER = opt('--owner', proj.owner || 'Claude');
const DRY = argv.includes('--dry-run'); // テスト用: app.exe を呼ばない

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => { try { fs.appendFileSync(LOG, JSON.stringify({ t: jst(), ...o }) + '\n', 'utf8'); } catch {} };

function jst(d = new Date()) {
  const t = new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 19);
  return `${t}+09:00`;
}
const oneLine = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// ---- lock（同じsessionのhookが同時に走ったとき用）
async function withLock(session, fn) {
  const dir = path.join(STATE_DIR, `lock-${session}`);
  for (let i = 0; i < 150; i++) {
    try { fs.mkdirSync(dir); break; } catch {
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 60e3) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      await sleep(100);
      if (i === 149) throw new Error('lock timeout');
    }
  }
  try { return await fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const statePath = (session, kind) => path.join(STATE_DIR, `state-${session}-${kind}.json`);
const readState = (session, kind) => { try { return JSON.parse(fs.readFileSync(statePath(session, kind), 'utf8')); } catch { return null; } };

// ---- app.exe CLI
async function runCli(args, prefix) {
  const receipt = path.join(RECEIPT_DIR, `${prefix}-${crypto.randomUUID()}.json`);
  if (DRY) { fs.writeFileSync(receipt, JSON.stringify({ ok: true, dry: true })); return { ok: true, dry: true, receipt }; }
  const child = spawn(EXE, [...args, '--result', receipt], { detached: true, stdio: 'ignore', windowsHide: true });
  let spawnError; child.on('error', e => { spawnError = e; });
  child.unref();
  for (let i = 0; i < 100; i++) { // 最大10秒
    if (spawnError) return { ok: false, error: spawnError.code || 'spawn failed', receipt };
    await sleep(100);
    try { const r = JSON.parse(fs.readFileSync(receipt, 'utf8')); return { ...r, receipt }; } catch {}
  }
  return { ok: false, error: 'receipt timeout', receipt };
}

async function confirmClosed(note, receipt) {
  if (DRY || receipt.state === 'not-open') return true;
  if (receipt.state !== 'close-requested') return false;
  // Match this note's persisted state; another note closing is not proof.
  await sleep(2300);
  const config = path.join(process.env.APPDATA || '', 'io.github.hogawish.stickynotes', 'config.json');
  const normalize = s => s.replace(/^\\\\\?\\/, '').replaceAll('/', '\\').toLowerCase();
  for (let i = 0; i < 40; i++) {
    try {
      const notes = JSON.parse(fs.readFileSync(config, 'utf8').replace(/^\uFEFF/, '')).notes || {};
      const match = Object.entries(notes).find(([file]) => normalize(file) === normalize(note));
      if (match?.[1].open === false) return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

// ---- begin
// UserPromptSubmit の入力元。hook入力の prompt_id と transcript の promptId を突き合わせ、
// 構造化属性 origin.kind（human / peer など）を返す。見つからなければ 'unknown'。
async function promptOrigin(ev) {
  const tp = ev.transcript_path, pid = ev.prompt_id;
  if (!tp || !pid) return 'unknown';
  for (let i = 0; i < 40; i++) { // 書き込み待ち 最大約10秒
    try {
      const lines = fs.readFileSync(tp, 'utf8').trimEnd().split('\n');
      for (let j = lines.length - 1; j >= Math.max(0, lines.length - 400); j--) {
        let o; try { o = JSON.parse(lines[j]); } catch { continue; }
        if (o.type !== 'user' || o.promptId !== pid || !o.origin) continue;
        const org = typeof o.origin === 'string' ? JSON.parse(o.origin) : o.origin;
        return String(org?.kind || 'unknown');
      }
    } catch {}
    await sleep(250);
  }
  return 'unknown';
}

async function begin(session, kind, sub, headline, reason, toolUseId) {
  return withLock(session, async () => {
    const cur = readState(session, kind);
    if (cur) { log({ action: 'begin-skip', kind, sub, open: cur.sub, note: cur.note }); return; }
    const id = crypto.randomUUID();
    const created = jst();
    const note = path.join(NOTE_DIR, `agent-state-${session}-${kind}-${id}.md`);
    const title = kind === 'cu' ? `Computer Use · ${OWNER}` : `判断待ち · ${WINDOW}`;
    const lines = kind === 'cu'
      ? [`操作担当：${OWNER}`, `目的：${headline}`]
      : [`**${headline}**`, `待ち理由：${reason}`, `返答先：${OWNER}／${WINDOW}`];
    if (LINK) lines.push(`[${WINDOW}のチャット](${LINK})`);
    const md = ['---', `id: ${id}`, `created: "${created}"`, `title: ${title}`, '---', ...lines, ''].join('\n');
    if (fs.existsSync(note)) throw new Error('note already exists');
    fs.writeFileSync(note, md, 'utf8');
    const r = await runCli(['open', note, '--monitor', 'primary', '--anchor', kind === 'cu' ? 'bottom-right' : 'top-right',
      '--width', '340', '--height', '190', '--pin'], 'sticky-open');
    fs.writeFileSync(statePath(session, kind), JSON.stringify({ id, kind, sub, note, created, toolUseId: toolUseId || null, open: r }, null, 2), 'utf8');
    log({ action: 'begin', kind, sub, note, ok: r.ok, receipt: r.receipt, error: r.error });
  });
}

// ---- end（アーカイブ手順 1〜7）
async function end(session, kind, why, onlySubs) {
  return withLock(session, async () => {
    const st = readState(session, kind);
    if (!st) return;
    if (onlySubs && !onlySubs.includes(st.sub)) return;
    const endedAt = jst(); // 1
    const r = await runCli(['close', st.note], 'sticky-close'); // 2
    if (!r.ok) { log({ action: 'end-close-failed', kind, why, note: st.note, r }); return; }
    const gone = await confirmClosed(st.note, r);
    if (!gone) { log({ action: 'end-close-unconfirmed', kind, why, note: st.note }); return; }
    // 4〜6: 最新Markdownを読み直し、ended_at / archived / 終了行を足して一時ファイルから置換
    const stat0 = fs.statSync(st.note);
    const text = fs.readFileSync(st.note, 'utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) { log({ action: 'end-no-frontmatter', note: st.note }); return; }
    if (!m[1].split(/\r?\n/).includes(`id: ${st.id}`)) throw new Error('Note identity changed; retaining state');
    const fm = m[1].split(/\r?\n/).filter((l) => !/^(ended_at|archived):/.test(l));
    fm.push(`ended_at: "${endedAt}"`, 'archived: true');
    let body = m[2].replace(/\s*$/, '');
    body += `\n終了：${endedAt}\n`;
    const out = ['---', ...fm, '---', body].join('\n');
    if (fs.statSync(st.note).mtimeMs !== stat0.mtimeMs) { log({ action: 'end-changed-during-edit', note: st.note }); return; }
    const tmp = `${st.note}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, out, 'utf8');
    fs.renameSync(tmp, st.note);
    // 7: 読み直して確認
    const back = fs.readFileSync(st.note, 'utf8');
    const verified = back.includes(`ended_at: "${endedAt}"`) && back.includes('archived: true') && back.includes(`終了：${endedAt}`);
    if (verified) fs.rmSync(statePath(session, kind), { force: true });
    log({ action: 'end', kind, sub: st.sub, why, note: st.note, endedAt, closeState: r.state, windowGone: gone, verified });
  });
}

// ---- event → action
async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  // 明示終了: node sticky_hook.mjs --end-session <session_id> [--kind reply|cu]
  const manual = opt('--end-session', '');
  if (manual) { await end(manual.replace(/[^0-9A-Za-z-]/g, ''), opt('--kind', 'reply'), 'manual', null); return; }
  const ev = await readStdin();
  const session = String(ev.session_id || '').replace(/[^0-9A-Za-z-]/g, '');
  if (!session) return;
  const name = ev.hook_event_name;
  const tool = ev.tool_name || '';
  const isCu = /^mcp__(computer-use|remote-devices)__/.test(tool);
  if (fs.existsSync(path.join(HERE, 'debug.flag'))) log({ action: 'seen', name, tool, type: ev.notification_type, mode: ev.permission_mode, keys: Object.keys(ev).join(','), prompt_id: ev.prompt_id });

  switch (name) {
    case 'Notification': {
      const type = ev.notification_type || '';
      if (type && !/^(permission_prompt|elicitation_dialog|elicitation_url_dialog)$/.test(type)) return;
      await begin(session, 'reply', 'permission', '許可の確認を待ってるよ', oneLine(ev.message) || type || '確認ダイアログ');
      break;
    }
    case 'PreToolUse': {
      if (tool === 'AskUserQuestion') {
        const q = ev.tool_input?.questions?.[0];
        await begin(session, 'reply', 'ask', oneLine(q?.question) || '質問に答えてほしい', `${OWNER}からの質問に答えてくれたら進めるよ`, ev.tool_use_id);
      } else if (tool === 'mcp__ccd_turn__wrap_up' && (ev.tool_input?.blocked === true || oneLine(ev.tool_input?.ask))) {
        // 質問欄(ask)があれば、blocked の付け忘れに関係なく判断待ちとして出す
        await begin(session, 'reply', 'wrapup', oneLine(ev.tool_input?.ask) || '判断を待ってるよ', oneLine(ev.tool_input?.recap, 100) || '返事をもらうまで止まってる');
      } else if (isCu) {
        await begin(session, 'cu', 'cu', 'Computer Useで画面を操作中', '');
      }
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (tool === 'AskUserQuestion') {
        const st = readState(session, 'reply');
        // ask は開始時の tool_use_id と一致するときだけ閉じる
        if (st?.sub === 'ask' && (!st.toolUseId || !ev.tool_use_id || st.toolUseId !== ev.tool_use_id)) break;
        await end(session, 'reply', `${name}:${tool}`, ['ask', 'permission']);
      }
      else if (tool !== 'mcp__ccd_turn__wrap_up') await end(session, 'reply', `${name}:${tool}`, ['permission']);
      break;
    }
    case 'PermissionDenied':
      await end(session, 'reply', name, ['permission']);
      break;
    case 'UserPromptSubmit': {
      // 次の入力をそのまま本人回答とみなさない。transcript の構造化属性 origin.kind が human のときだけ閉じる。
      // 本文の自己申告（「Humanが言った」等）は見ない。判別できなければ付箋を残す。
      if (!readState(session, 'reply')) break;
      const origin = await promptOrigin(ev);
      if (origin === 'human') await end(session, 'reply', `${name}:human`, null);
      else log({ action: 'keep-open', why: `${name}:${origin}`, prompt_id: ev.prompt_id });
      break;
    }
    case 'Stop': {
      await end(session, 'reply', name, ['permission']);
      await end(session, 'cu', name, null);
      // 予備: 最後の発言が質問で終わっていれば判断待ちとして出す（既に出ていれば begin が二重を避ける）
      const last = String(ev.last_assistant_message || '').trim();
      if (/[？?][\s」』）)\]*_`]*$/.test(last)) {
        const tail = oneLine(last.split(/\r?\n/).filter((l) => l.trim()).pop()).replace(/^[*_`#>\-\s]+|[*_`\s]+$/g, '');
        await begin(session, 'reply', 'stop', tail || '質問に答えてほしい', `${OWNER}が返事を待ってるよ`);
      }
      break;
    }
    default:
      break;
  }
}

main().catch((e) => log({ action: 'error', error: String(e?.stack || e) }));
