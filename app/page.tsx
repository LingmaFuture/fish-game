'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { errorMessages, type Ack, type Command, type Snapshot, type ContentSummary } from '../shared/protocol';

type Connection = 'connecting' | 'connected' | 'disconnected' | 'replaced';
const reasonLabels = { last_standing: '坚持到了最后', time_limit: '时间到，按生命和答对数结算', content_exhausted: '题库可用答案不足，本局不判冠军', opponents_left: '对手退出，本局结束', no_players: '本局结束，无获胜者' };
function Icon({ name, size = 20 }: { name: 'arrow' | 'link' | 'users' | 'clock' | 'close' | 'check' | 'heart' | 'bolt'; size?: number }) {
  const paths = { arrow: 'M5 12h14m-6-6 6 6-6 6', link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-7.87a4 4 0 0 1 0 7.75', clock: 'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 4 4L19 6', heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z', bolt: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
const initialConnectionLabels = { connecting: '正在连接', connected: '已连接', disconnected: '正在重连，暂时无法操作', replaced: '另一页面已接管' };
export default function Home() {
  const socketRef = useRef<Socket | null>(null), roomRef = useRef<Snapshot | null>(null);
  const composing = useRef(false), offset = useRef(0);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [room, setRoom] = useState<Snapshot | null>(null);
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const [invited, setInvited] = useState(false);
  const [inviteInfo, setInviteInfo] = useState<{ count: number; phase: string } | null>(null);
  const [modal, setModal] = useState<'create' | 'join' | 'rules' | 'privacy' | 'feedback' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [answer, setAnswer] = useState('');
  const [feedbackText, setFeedbackText] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [now, setNow] = useState(0);
  const [contentSummary, setContentSummary] = useState<ContentSummary | null>(null);
  const connected = connection === 'connected';
  function saveNickname(value: string) { try { localStorage.setItem('kyj_nickname', value); } catch {} }
  function setRoomState(value: Snapshot | null) { roomRef.current = value; setRoom(value); }
  useEffect(() => {
    let alive = true;
    fetch('/api/content').then(async response => {
      if (!response.ok) return;
      const summary: ContentSummary = await response.json();
      if (alive) setContentSummary(summary);
    }).catch(() => {});
    const params = new URLSearchParams(location.search);
    const roomCode = params.get('room');
    if (roomCode) {
      setCode(roomCode.toUpperCase()); setInvited(true);
      fetch(`/api/rooms/${encodeURIComponent(roomCode)}`).then(async r => {
        if (!alive) return;
        if (r.ok) setInviteInfo(await r.json());
        else setNotice(errorMessages.ROOM_NOT_FOUND);
      }).catch(() => { if (alive) setNotice('暂时无法查看房间，请检查连接。'); });
    }
    try { setNickname(localStorage.getItem('kyj_nickname') ?? ''); } catch {}
    fetch('/api/guest', { method: 'POST' }).then(async response => {
      if (!response.ok) throw new Error('访客身份初始化失败，请刷新重试。');
      await response.json(); if (!alive) return;
      const socket = io({ autoConnect: false, withCredentials: true }); socketRef.current = socket;
      socket.on('connect', () => {
        setConnection('connected');
        socket.emit('room:resume', { actionId: crypto.randomUUID() }, (ack: Ack) => {
          if (!ack.ok && roomRef.current) { setRoomState(null); setNotice(errorMessages.ROOM_NOT_FOUND); }
        });
      });
      socket.on('disconnect', () => { setConnection('disconnected'); setAnswer(''); });
      socket.on('connect_error', () => setConnection('disconnected'));
      socket.on('connection:replaced', () => { setConnection('replaced'); setNotice(errorMessages.CONNECTION_REPLACED); });
      socket.on('room:snapshot', (snapshot: Snapshot) => {
        const previous = roomRef.current;
        if (previous?.roomId === snapshot.roomId && snapshot.version < previous.version) return;
        offset.current = snapshot.serverNow - Date.now(); setNow(snapshot.serverNow);
        if (previous?.match?.roundId !== snapshot.match?.roundId) setAnswer('');
        setRoomState(snapshot); if (!previous || previous.roomId !== snapshot.roomId) setModal(null); setInvited(false);
        history.replaceState(null, '', `/?room=${snapshot.roomCode}`);
      });
      socket.on('room:closed', ({ reason }: { reason: string }) => { setRoomState(null); setNotice(reason); history.replaceState(null, '', '/'); });
      socket.connect();
    }).catch(error => { if (alive) { setConnection('disconnected'); setNotice(error.message); } });
    const timer = setInterval(() => setNow(Date.now() + offset.current), 100);
    return () => { alive = false; clearInterval(timer); socketRef.current?.disconnect(); socketRef.current = null; };
  }, []);
  useEffect(() => {
    if (!modal) return;
    const dialog = document.querySelector<HTMLDialogElement>('dialog');
    dialog?.showModal();
    return () => dialog?.close();
  }, [modal]);
  async function command(event: string, extra: Partial<Command> = {}) {
    if (!connected || !socketRef.current) return false;
    setBusy(true); setNotice('');
    try {
      const ack: Ack = await socketRef.current.timeout(5000).emitWithAck(event, { actionId: crypto.randomUUID(), ...extra });
      if (!ack.ok) setNotice(errorMessages[ack.errorCode ?? ''] ?? '操作失败，请稍后重试。');
      return ack.ok;
    } catch { setNotice('暂未收到确认，请以房间最新状态为准。'); return false; }
    finally { setBusy(false); }
  }
  async function enter(event: FormEvent, create: boolean) {
    event.preventDefault();
    if (await command(create ? 'room:create' : 'room:join', { nickname, roomCode: code.toUpperCase().trim(), gameKey: 'idiom' })) saveNickname(nickname.trim());
  }
  async function copyInvite() {
    if (!room) return;
    const link = `${location.origin}/?room=${room.roomCode}`; setInviteLink(link);
    try { await navigator.clipboard.writeText(link); setNotice('邀请链接已复制，发给朋友就能加入。'); }
    catch { setNotice('未能自动复制，请选中下面的链接手动复制。'); }
  }
  async function leave() {
    if (await command('room:leave')) { setRoomState(null); setInviteLink(''); history.replaceState(null, '', '/'); }
  }
  async function submitAnswer(event: FormEvent) {
    event.preventDefault(); if (composing.current) return;
    if (await command('answer:submit', { answer, matchId: room?.match?.matchId, roundId: room?.match?.roundId })) setAnswer('');
  }
  const me = room?.members.find(m => m.playerId === room.me);
  const host = room?.hostId === room?.me;
  const match = room?.match;
  const myScore = match?.scores.find(s => s.playerId === room?.me);
  const activeTurn = room?.phase === 'PLAYING' && match?.stage === 'TURN' && match.turnPlayerId === room.me;
  const turnName = match?.scores.find(s => s.playerId === match.turnPlayerId)?.nickname;
  const seconds = Math.max(0, Math.ceil(((room?.phase === 'COUNTDOWN' ? room.countdownAt : match?.deadline) ?? 0) - now) / 1000);
  const waiting = room?.phase === 'WAITING';
  const readyToStart = room && room.members.filter(m => m.online).length >= 2 && room.members.every(m => !m.online || m.playerId === room.hostId || m.ready);
  const statusLabel = connection === 'replaced' ? '当前页面只读' : initialConnectionLabels[connection];
  const nicknameInput = <label className="field">怎么称呼你？<input autoFocus value={nickname} onChange={e => setNickname(e.target.value)} placeholder="给朋友熟悉的那个昵称" maxLength={40} required autoComplete="nickname" /><span className="field-hint">2–12 个可见字符，无需注册</span></label>;

  return <div className="site-shell">
    <header className="site-header">
      <a className="brand" href="/" aria-label="开一局首页"><span className="brand-mark"><Icon name="bolt" size={24} /></span>开一局<span className="wordmark-en">PLAY TOGETHER</span></a>
      <div className="header-right"><span className={`connection ${connected ? 'online' : ''}`}><i />{statusLabel}</span><button className="text-button" onClick={() => setModal('rules')}>玩法说明</button></div>
    </header>

    <main>
      {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><Icon name="close" size={16} /></button></div>}
      {!room ? <>
        {invited ? <section className="invitation panel">
          <span className="eyebrow">朋友的邀请</span><h1>人就差你了。</h1>
          <p>成语炸弹 · 房间 <strong>{code}</strong>{inviteInfo ? ` · ${inviteInfo.count}/8 人` : ''}</p>
          {inviteInfo?.phase === 'PLAYING' && <p>游戏正在进行，加入后先观战，下局一起玩。</p>}
          <form onSubmit={event => enter(event, false)}>{nicknameInput}<button className="primary" disabled={!connected || busy}>加入朋友的房间 <Icon name="arrow" /></button></form>
          <button className="text-button" onClick={() => { setInvited(false); setNotice(''); history.replaceState(null, '', '/'); }}>我也来创建一间</button>
        </section> : <>
          <section className="intro"><div><span className="eyebrow">把朋友叫上，好玩才刚开始</span><h1>来都来了，<br className="mobile-break" /><span>开一局。</span><span className="headline-star" aria-hidden="true">✳</span></h1><p>一个昵称，一条链接。和熟悉的人，玩点新鲜的。</p></div><div className="intro-note"><span>小局，也有大快乐</span><strong>2–8 人 · 即开即玩</strong></div></section>
          <section aria-labelledby="games-heading"><div className="section-heading"><h2 id="games-heading">今天玩什么？</h2><span>选个玩法，叫上你的搭子</span></div>
            <div className="games-grid">
              <article className="game-card idiom-card"><div className="card-top"><span className="pill">首发试玩</span><span className="game-number">01</span></div><div className="game-visual idiom-visual" aria-hidden="true"><span className="character">马</span><span className="answer-label">马到成功</span><span className="timer-label">00:12</span></div><div className="card-copy"><h3>成语炸弹</h3><p>有「马」的成语，你能接几个？<br />倒计时内接招，别让灵感断线。</p><div className="game-meta"><span><Icon name="users" size={16} />2–8 人</span><span><Icon name="clock" size={16} />最长 3 分钟</span></div><button className="card-action" onClick={() => setModal('create')} disabled={!connected}>创建房间 <Icon name="arrow" /></button></div></article>
              <article className="game-card initials-card"><div className="card-top"><span className="pill muted">筹备中</span><span className="game-number">02</span></div><div className="game-visual initials-visual" aria-hidden="true"><span className="letter">b</span><span className="letter">d</span><span className="little-caption">百度？表达？冰岛？</span></div><div className="card-copy"><h3>缩写炸弹</h3><p>两个字母，脑洞全开。<br />让你脑海里的词语抢先一步。</p><div className="game-meta"><span><Icon name="users" size={16} />2–8 人</span><span><Icon name="clock" size={16} />最长 3 分钟</span></div><button className="card-action" disabled>题库准备中 <span>即将见面</span></button></div></article>
              <article className="game-card vote-card"><div className="card-top"><span className="pill muted">筹备中</span><span className="game-number">03</span></div><div className="game-visual vote-visual" aria-hidden="true"><span className="vote-question">谁最可能<br />说走就走？</span><span className="vote-option">你</span><span className="vote-option second">我</span></div><div className="card-copy"><h3>谁最像</h3><p>关于朋友，你有自己的答案。<br />看看这一次，大家有没有默契。</p><div className="game-meta"><span><Icon name="users" size={16} />2–8 人</span><span><Icon name="clock" size={16} />约 85 秒</span></div><button className="card-action" disabled>玩法准备中 <span>即将见面</span></button></div></article>
            </div>
          </section>
          <section className="join-bar"><div className="join-heading"><span className="join-icon"><Icon name="link" size={24} /></span><div><h2>朋友已经开好房了？</h2><p>输入 6 位房间码，马上入座。</p></div></div><form onSubmit={e => { e.preventDefault(); setModal('join'); }}><label className="sr-only" htmlFor="room-code">6 位房间码</label><input id="room-code" className="room-code-input" value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="输入房间码" maxLength={6} minLength={6} required autoComplete="off" /><button className="dark-button" disabled={!connected}>加入房间 <Icon name="arrow" size={18} /></button></form></section>
          <div className="home-notes"><span><Icon name="check" size={16} />无需注册</span><span><Icon name="check" size={16} />私人房间</span><span><Icon name="check" size={16} />一局结束，原地再来</span></div>
        </>}
      </> : <>
        <section className="room-heading"><div><span className="eyebrow">好友局 / 成语炸弹</span><h1>{room.phase === 'RESULTS' ? '这局，玩得漂亮。' : room.phase === 'PLAYING' ? '灵感，别掉线。' : '搭子们，集合。'}</h1></div><button className="text-button" onClick={leave} disabled={!connected || busy}>退出房间 <Icon name="close" size={16} /></button></section>
        <div className="room-layout"><aside className="players-panel panel"><div className="players-heading"><h2>房间里的朋友</h2><span>{room.members.length}/8</span></div><div className="room-code-block"><span>房间码</span><strong>{room.roomCode}</strong></div><button className="invite-button" onClick={copyInvite}><Icon name="link" size={17} />复制邀请链接</button>
          {inviteLink && <label className="copy-fallback">也可以手动复制<input aria-label="邀请链接" readOnly value={inviteLink} onFocus={e => e.target.select()} /></label>}
          <ul className="player-list">{room.members.map((member, i) => {
            const score = match?.scores.find(s => s.playerId === member.playerId);
            const status = !member.online ? '断线 · 等待重连' : room.phase === 'PLAYING' ? !score || score.exited ? '观战中' : score.lives === 0 ? '已淘汰 · 观战' : match?.turnPlayerId === member.playerId ? '正在作答' : '等待回合' : member.playerId === room.hostId ? '房主' : member.ready ? '已准备' : '等待准备';
            return <li key={member.playerId} className={match?.turnPlayerId === member.playerId && room.phase === 'PLAYING' ? 'current-player' : ''}><span className={`avatar avatar-${i % 4}`}>{Array.from(member.nickname)[0]}</span><div className="player-name"><strong>{member.nickname}{member.playerId === room.me && <small>你</small>}</strong><span>{status}</span></div>{score && room.phase === 'PLAYING' ? <span className="lives" aria-label={`${score.lives} 条生命`}>{'♥'.repeat(score.lives)}{'♡'.repeat(2 - score.lives)}</span> : host && member.playerId !== room.me && (waiting || room.phase === 'RESULTS') ? <button className="kick-button" aria-label={`移除 ${member.nickname}`} onClick={() => command('room:kick', { playerId: member.playerId })} disabled={busy || !connected}><Icon name="close" size={14} /></button> : null}</li>;
          })}</ul><p className="quiet">这是私人房间，只把链接发给想一起玩的朋友。</p></aside>
          <section className="play-panel panel">
            {room.idleWarning && <p className="warning">房间已闲置 14 分钟，继续操作可保留房间，否则将在一分钟内关闭。</p>}
            {waiting && <div className="waiting-content"><span className="eyebrow">开局前，热热身</span><div className="sample-prompt">马</div><h2>比如，带「马」字的四字成语？</h2><p>马到成功、一马当先、走马观花……</p><div className="rule-chips"><span>每人 2 条生命</span><span>每回合 12 秒起</span><span>成语不能重复</span></div><div className="start-area">{host ? <><button className="primary" disabled={!readyToStart || !connected || busy} onClick={() => command('match:start')}>人齐了，开一局 <Icon name="arrow" /></button><p>{room.members.filter(m => m.online).length < 2 ? '再邀请至少 1 位朋友，就能开始。' : !readyToStart ? '等待其他在线朋友点击准备。' : '全部就绪。房主点击后，3 秒开始。'}</p></> : <><button className={me?.ready ? 'secondary' : 'primary'} disabled={!connected || busy} onClick={() => command('room:ready', { ready: !me?.ready })}>{me?.ready ? '已准备 · 点击取消' : '我准备好了'} <Icon name="check" /></button><p>准备好后，等待房主开始。</p></>}</div></div>}
            {room.phase === 'COUNTDOWN' && <div className="countdown-content" role="status"><span className="eyebrow">全员就绪</span><strong>{Math.ceil(seconds)}</strong><h2>把成语装进脑袋。</h2><p>行动顺序即将随机生成</p></div>}
            {room.phase === 'PLAYING' && match && <div className="game-content"><div className="game-status"><span>{activeTurn ? '轮到你了' : `等待 ${turnName}`}</span><span>整局剩余 {Math.max(0, Math.ceil((match.endAt - now) / 1000))} 秒</span></div><div className={`turn-timer ${seconds <= 3 ? 'urgent' : ''}`} aria-label={`回合剩余 ${Math.ceil(seconds)} 秒`}><Icon name="clock" size={20} />{Math.ceil(seconds).toString().padStart(2, '0')}<small>秒</small></div><p className="prompt-instruction">说一个含有这个字的四字成语</p><div className="live-prompt">{match.prompt}</div>
              {match.stage === 'FEEDBACK' ? <div className="round-feedback" role="status">{match.feedback}</div> : activeTurn ? <form className="answer-form" onSubmit={submitAnswer}><label className="sr-only" htmlFor="answer">你的四字成语</label><input id="answer" autoFocus value={answer} onChange={e => setAnswer(e.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={e => { if (e.key === 'Enter' && (composing.current || e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault(); }} placeholder="输入成语，Enter 提交" maxLength={30} autoComplete="off" disabled={!connected || busy} /><button className="primary" disabled={!connected || busy || !answer.trim()}>提交 <Icon name="arrow" /></button><button type="button" className="text-button pass-button" disabled={!connected || busy} onClick={() => command('turn:pass', { matchId: match.matchId, roundId: match.roundId })}>这题放弃（失去 1 条生命）</button></form> : <div className="spectating"><span>{!myScore || myScore.lives === 0 ? '你正在观战，下局继续一起玩。' : '想想你的答案，下一个可能就是你。'}</span></div>}
              <button className="text-button missing-word" onClick={() => setModal('feedback')}>遇到未收录的成语？反馈缺词</button></div>}
            {room.phase === 'RESULTS' && room.result && <div className="results-content"><span className="eyebrow">本局结算</span><span className="result-symbol" aria-hidden="true">✳</span><h2>{room.result.winnerIds.length ? room.result.winnerIds.map(id => room.result!.rankings.find(s => s.playerId === id)?.nickname).join('、') + (room.result.winnerIds.length > 1 ? ' 并列获胜' : ' 获胜') : '谢谢每一次接招'}</h2><p>{reasonLabels[room.result.endReason]}</p><div className="score-table"><div className="score-row score-head"><span>玩家</span><span>生命</span><span>答对</span></div>{room.result.rankings.map(score => <div className="score-row" key={score.playerId}><strong>{score.nickname}{score.exited && <small> · 已退出</small>}</strong><span>{score.lives}</span><span>{score.correct}</span></div>)}</div>{host ? <button className="primary" disabled={!connected || busy} onClick={() => command('match:rematch')}>再来一局 <Icon name="arrow" /></button> : <p>等待房主开启下一局，无需重新加入。</p>}<button className="text-button" onClick={copyInvite}>邀请朋友来接招</button></div>}
          </section></div>
      </>}
    </main>
    <footer><div><strong>开一局</strong><span>快乐这件事，人齐就好。</span></div><nav><span className="test-label">开发试玩 · 扩展词库</span><button onClick={() => setModal('feedback')}>意见反馈</button><button onClick={() => setModal('privacy')}>隐私说明</button></nav></footer>
    {modal && <dialog onCancel={() => setModal(null)} onClick={e => { if (e.target === e.currentTarget) setModal(null); }}><div className="dialog-inner"><button className="dialog-close" onClick={() => setModal(null)} aria-label="关闭"><Icon name="close" /></button>
      {(modal === 'create' || modal === 'join') && <><span className="eyebrow">{modal === 'create' ? '成语炸弹 / 新房间' : '来和朋友碰个头'}</span><h2>{modal === 'create' ? '先认识一下你。' : '这局，算你一个。'}</h2><form onSubmit={e => enter(e, modal === 'create')}>{nicknameInput}{modal === 'join' && <label className="field">房间码<input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="6 位房间码" required minLength={6} maxLength={6} /></label>}<button className="primary" disabled={!connected || busy}>{busy ? '稍等一下…' : modal === 'create' ? '创建房间' : '加入房间'}<Icon name="arrow" /></button></form><p className="quiet">继续即表示你已了解本页的隐私说明。房间只在本次会话中保留。</p></>}
      {modal === 'rules' && <><span className="eyebrow">一分钟了解规则</span><h2>成语炸弹，怎么玩？</h2><ol className="rules-list"><li><strong>叫上 1–7 位朋友</strong><span>输入昵称建房，把邀请链接发给朋友。其他玩家准备后，房主开始。</span></li><li><strong>接住你的回合</strong><span>轮到你时，输入包含题面汉字的四字成语。前 60 秒每回合 12 秒，之后每回合 9 秒。</span></li><li><strong>守住 2 条生命</strong><span>超时或放弃会失去 1 条生命。答错可以继续尝试，时间不会重置；同一局不能重复成语。</span></li><li><strong>最后留下，或时间到</strong><span>只剩 1 人时结算。整局最多 180 秒，时间到后先比剩余生命，再比答对数，相同则并列。</span></li></ol><p className="warning">{contentSummary ? `当前收录 ${contentSummary.answerCount.toLocaleString('zh-CN')} 条成语词条。` : '按当前版本的成语词库判题。'}常用词用于控制出题难度，收录的其他成语也可以作答。词库持续校对，遇到遗漏可反馈。断线不会暂停计时，30 秒内可以回到原席位。</p></>}
      {modal === 'privacy' && <><span className="eyebrow">只为这一局</span><h2>隐私说明</h2><div className="prose"><p>无需账号或手机号。浏览器保存匿名访客凭证，用于恢复你自己的席位；昵称只作为显示名称，可在本机记住。</p><p>服务端保存凭证哈希和少量使用事件，保留 30 天后清理。默认不保存每次作答内容。你主动提交的缺词和意见反馈也保留 30 天。</p><p>房间状态保存在内存中，服务重启会结束房间。没有在线成员超过 30 秒或连续 15 分钟无人操作，房间会关闭。</p><p>邀请链接含房间码，请只分享给你的朋友。本版本为本地开发试玩版本。</p></div></>}
      {modal === 'feedback' && <><span className="eyebrow">让下一局更好玩</span><h2>说说你的发现。</h2><form onSubmit={async e => { e.preventDefault(); setBusy(true); try { const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: feedbackText }) }); if (!response.ok) throw new Error(); setModal(null); setFeedbackText(''); setNotice('反馈已保存，谢谢！缺词会在后续审核后考虑加入。'); } catch { setNotice('反馈暂未送达，请稍后再试。'); } finally { setBusy(false); } }}><label className="field">缺词或体验反馈<textarea autoFocus value={feedbackText} onChange={e => setFeedbackText(e.target.value)} placeholder="例如：题面是「马」，我输入的……暂未收录" required maxLength={300} rows={4} /></label><p className="quiet">请勿填写手机号等个人信息。反馈不会改变本局判定。</p><button className="primary" disabled={!connected || busy || !feedbackText.trim()}>提交反馈 <Icon name="arrow" /></button></form></>}
      {notice && <p className="dialog-notice" role="status">{notice}</p>}
    </div></dialog>}
  </div>;
}
