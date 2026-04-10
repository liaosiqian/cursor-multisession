import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

declare const vscode: {
	postMessage(msg: any): void;
	getState(): any;
	setState(state: any): void;
};

interface SessionInfo {
	id: string;
	name: string;
	alive: boolean;
}

interface AccountInfo {
	id: string;
	name: string;
	isPrimary: boolean;
	state: 'idle' | 'logging_in' | 'connecting' | 'connected' | 'error';
	active: boolean;
	qrDataUrl?: string;
	bindingSessions: string[];
}

const STATE_LABELS: Record<string, string> = {
	idle: '未连接',
	logging_in: '登录中...',
	connecting: '连接中...',
	connected: '已连接',
	error: '错误',
};

function post(type: string, data?: Record<string, any>) {
	vscode.postMessage({ type, ...data });
}

function AccountCard({ account, sessions, allAccounts }: { account: AccountInfo; sessions: SessionInfo[]; allAccounts: AccountInfo[] }) {
	const { id, state, isPrimary, active, name, qrDataUrl, bindingSessions } = account;
	const showQr = !!qrDataUrl && state === 'logging_in';
	const showLogin = state === 'idle' || state === 'error';
	const showDisconnect = state === 'connected';
	const [showBindings, setShowBindings] = useState(false);

	const handleRemove = useCallback(() => {
		if (confirm('确定删除?')) post('removeAccount', { accountId: id });
	}, [id]);

	const getOtherBoundAccount = useCallback((sessionId: string): AccountInfo | undefined => {
		return allAccounts.find(a => a.id !== id && a.bindingSessions.includes(sessionId));
	}, [id, allAccounts]);

	return (
		<div className={`account-card${isPrimary ? ' primary' : ''}`}>
			<div className="account-header">
				<div className={`dot ${state}`} />
				<span className="account-name">{name}</span>
				{isPrimary && <span className="badge">主渠道</span>}
				{active && <span className="badge active">活跃</span>}
			</div>
			<div className="state-label">{STATE_LABELS[state] || state}</div>
			{showQr && (
				<div className="qr-box">
					<img src={qrDataUrl} alt="QR" />
					<p>请用微信扫码</p>
				</div>
			)}
			<div className="account-actions">
				{showLogin && (
					<button className="btn sm" onClick={() => post('login', { accountId: id })}>
						扫码登录
					</button>
				)}
				{showDisconnect && (
					<button className="btn sm secondary" onClick={() => post('disconnect', { accountId: id })}>
						断开
					</button>
				)}
				{!isPrimary && state !== 'logging_in' && (
					<button className="btn sm secondary" onClick={() => post('setPrimary', { accountId: id })}>
						设为主渠道
					</button>
				)}
				<button className="btn sm secondary" onClick={() => setShowBindings(!showBindings)}>
					绑定 Session ({bindingSessions.length})
				</button>
				{state === 'idle' && (
					<button className="btn sm danger" onClick={handleRemove}>
						删除
					</button>
				)}
			</div>
			{showBindings && (
				<div className="binding-section">
					<div className="binding-title">SESSION 绑定</div>
					{(() => {
						const visibleSessions = sessions.filter(s => s.alive || bindingSessions.includes(s.id));
						return visibleSessions.length === 0 ? (
						<p className="binding-empty">暂无可用 Session</p>
					) : (
						<div className="binding-list">
							{visibleSessions.map(s => {
								const bound = bindingSessions.includes(s.id);
								const otherAccount = getOtherBoundAccount(s.id);
								const hasBound = bindingSessions.length > 0;
								const canBind = s.alive && !(otherAccount && !bound);
								return (
									<label key={s.id} className={`binding-item${!canBind && !bound ? ' disabled' : ''}${otherAccount && !bound ? ' other-bound' : ''}`}>
										<input
											type="radio"
											name={`binding-${id}`}
											checked={bound}
											disabled={!s.alive && !bound}
											onChange={() => {
												if (bound) {
													post('unbindSession', { accountId: id, sessionId: s.id });
												} else if (!s.alive) {
													return;
												} else if (otherAccount) {
													post('confirmBindSteal', {
														accountId: id,
														sessionId: s.id,
														sessionName: s.name || s.id.substring(0, 8),
														otherAccountId: otherAccount.id,
														otherAccountName: otherAccount.name,
														currentSessionId: hasBound ? bindingSessions[0] : null,
													});
												} else if (hasBound) {
													post('confirmBindSwitch', {
														accountId: id,
														sessionId: s.id,
														sessionName: s.name || s.id.substring(0, 8),
														currentSessionId: bindingSessions[0],
													});
												} else {
													post('bindSession', { accountId: id, sessionId: s.id });
												}
											}}
										/>
										<span className="binding-name">{s.name || s.id.substring(0, 8)}</span>
										{!s.alive && <span className="binding-tag inactive">已关闭</span>}
										{otherAccount && !bound && <span className="binding-tag other">已绑定 {otherAccount.name}</span>}
									</label>
								);
							})}
						</div>
					);
					})()}
					<p className="binding-hint">仅绑定的会话会收发微信消息，可通过微信 /use 命令切换</p>
				</div>
			)}
		</div>
	);
}

function App() {
	const [accounts, setAccounts] = useState<AccountInfo[]>([]);
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [newName, setNewName] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const msg = e.data;
			if (msg.type === 'fullState') {
				setAccounts(msg.accounts || []);
				setSessions(msg.sessions || []);
			}
		};
		window.addEventListener('message', handler);
		post('requestState');
		return () => window.removeEventListener('message', handler);
	}, []);

	const handleAdd = useCallback(() => {
		const name = newName.trim();
		post('addAccount', { name: name || undefined });
		setNewName('');
		inputRef.current?.focus();
	}, [newName]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter') handleAdd();
		},
		[handleAdd]
	);

	return (
		<div className="wechat-panel">
			<div className="section-title">微信账号</div>

			<div className="account-list">
				{accounts.length === 0 ? (
					<p className="empty-hint">尚未添加微信账号</p>
				) : (
					accounts.map((a) => (
						<AccountCard key={a.id} account={a} sessions={sessions} allAccounts={accounts} />
					))
				)}
			</div>

			<div className="add-section">
				<div className="add-row">
					<input
						ref={inputRef}
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="账号名称（如：工作微信）"
					/>
					<button className="btn sm" onClick={handleAdd}>
						+ 添加
					</button>
				</div>
			</div>

			<p className="info">
				• 标记为"主渠道"的账号默认接收所有未绑定 session 的消息
				<br />
				• 微信 30 分钟内无消息则暂停推送 AI 回复
				<br />
				• 点击"绑定 Session"可将 session 路由到指定微信账号
			</p>
		</div>
	);
}

try {
	const el = document.getElementById('root');
	if (!el) throw new Error('root element not found');
	const root = createRoot(el);
	root.render(<App />);
} catch (err: any) {
	const el = document.getElementById('root') || document.body;
	el.innerHTML = `<div style="padding:16px;color:#f44;font-size:13px;font-family:monospace;">
		<p><strong>WeChat render error</strong></p>
		<pre style="white-space:pre-wrap;">${err?.message || err}</pre>
		<pre style="white-space:pre-wrap;font-size:11px;opacity:0.7;">${err?.stack || ''}</pre>
	</div>`;
}
