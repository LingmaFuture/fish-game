export type Phase = 'WAITING' | 'COUNTDOWN' | 'PLAYING' | 'RESULTS' | 'CLOSED';
export type GameKey = 'idiom' | 'initials' | 'vote';
export interface ContentSummary { version: string; answerCount: number; promptCount: number; status: 'draft' | 'approved' }
export interface Member {
  playerId: string; nickname: string; joinedAt: number; online: boolean; ready: boolean;
}
export interface Score {
  playerId: string; nickname: string; lives: number; correct: number; exited: boolean; eliminatedAt?: number;
}
export interface MatchView {
  matchId: string; roundId: string; prompt: string; turnPlayerId: string;
  stage: 'TURN' | 'FEEDBACK'; deadline: number; endAt: number;
  scores: Score[]; feedback?: string; packVersion: string;
}
export interface Result {
  endReason: 'last_standing' | 'time_limit' | 'content_exhausted' | 'opponents_left' | 'no_players';
  winnerIds: string[]; rankings: Score[];
}
export interface Snapshot {
  roomCode: string; roomId: string; hostId: string; phase: Phase; version: number;
  serverNow: number; members: Member[]; gameKey: GameKey;
  me: string; countdownAt?: number; match?: MatchView; result?: Result;
  idleWarning: boolean;
}
export interface Command {
  actionId: string; roomCode?: string; nickname?: string; ready?: boolean;
  gameKey?: GameKey; playerId?: string; matchId?: string; roundId?: string; answer?: string;
}
export interface Ack { actionId: string; ok: boolean; errorCode?: string; message?: string; stateVersion?: number; roomCode?: string }
export const errorMessages: Record<string, string> = {
  BAD_INPUT: '输入格式不正确，请检查后重试。', NICKNAME_INVALID: '昵称需要 2–12 个可见字符。',
  ROOM_NOT_FOUND: '房间已结束，可能因长时间无人在线或服务重启。你可以新建一间。',
  ROOM_FULL: '房间已满（最多 8 人，包含观战者）。', FORBIDDEN: '你当前没有操作权限。',
  BANNED: '你已被房主移出这个房间。', WRONG_PHASE: '当前阶段不能进行此操作。',
  NOT_READY: '需要至少 2 人在线，且其他在线玩家全部准备。',
  NOT_YOUR_TURN: '还没轮到你，先看看朋友的表现吧。', STALE_ROUND: '这一回合已经结束。',
  TIMEOUT: '时间到了，本次提交未计入。', ANSWER_FORMAT: '请输入四个汉字，不含空格、标点或数字。',
  NOT_INCLUDED: '这个词暂未收录在当前题库中，试试其他成语。',
  PROMPT_MISMATCH: '成语中需要包含题面上的字。', ALREADY_USED: '这个成语本局已经用过了。',
  ACTION_CONFLICT: '请求标识重复但内容不同，请重新操作。', RATE_LIMITED: '操作太快了，稍等一下再试。',
  GAME_UNAVAILABLE: '这个玩法正在准备中，先来一局成语炸弹吧。',
  CONNECTION_REPLACED: '你的另一个页面已接管操作，请在那个页面继续。',
  ALREADY_IN_ROOM: '你已经在一个房间里，请先退出再创建或加入。',
  CONTENT_UNAVAILABLE: '题库暂不可用，请稍后再试。',
};
