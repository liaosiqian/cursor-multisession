import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';

declare const vscode: {
	postMessage(msg: any): void;
	getState(): any;
	setState(state: any): void;
};

function renderMarkdown(md: string): string {
	let html = md
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');

	html = html.replace(/```[\s\S]*?```/g, (block) => {
		const inner = block.slice(3, -3).replace(/^\w*\n/, '');
		return `<pre class="md-code-block"><code>${inner}</code></pre>`;
	});
	html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
	html = html.replace(/^### (.+)$/gm, '<strong class="md-h3">$1</strong>');
	html = html.replace(/^## (.+)$/gm, '<strong class="md-h2">$1</strong>');
	html = html.replace(/^# (.+)$/gm, '<strong class="md-h1">$1</strong>');
	html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/^[-*] (.+)$/gm, '<span class="md-li">$1</span>');
	html = html.replace(/\n/g, '<br/>');

	return html;
}

// ── types ──

interface SessionMeta {
	id: string;
	name: string;
	workspace: string;
	alive: boolean;
	lastActiveAt: number;
}

interface ChatMessage {
	role: string;
	text: string;
	ts: number | string;
}

interface PendingItem {
	id: string;
	type: string;
	content: string;
	timestamp: string;
}

interface InquiryQuestion {
	question: string;
	options: { id: string; label: string }[];
	allow_multiple?: boolean;
}

interface InquiryData {
	id: string;
	questions: InquiryQuestion[];
	ts: number;
	answered: boolean;
}

interface SummaryData {
	text: string;
	ts: number;
}

// ── App ──

function App() {
	const savedState = vscode.getState() ?? {};

	const [sessions, setSessions] = useState<SessionMeta[]>(savedState.sessions ?? []);
	const [activeSessionId, setActiveSessionId] = useState<string>(savedState.activeSessionId ?? '');
	const [logsMap, setLogsMap] = useState<Record<string, ChatMessage[]>>(savedState.logsMap ?? {});
	const [pendingMap, setPendingMap] = useState<Record<string, PendingItem[]>>(savedState.pendingMap ?? {});
	const [mcpConfigured, setMcpConfigured] = useState<boolean>(savedState.mcpConfigured ?? false);
	const [rulePrompt, setRulePrompt] = useState<string>(savedState.rulePrompt ?? '');
	const [inputText, setInputText] = useState('');
	const [sharedFiles, setSharedFiles] = useState<{ path: string; name: string }[]>([]);
	const [images, setImages] = useState<{ name: string; dataUrl: string }[]>([]);
	const [inquiryMap, setInquiryMap] = useState<Record<string, InquiryData>>(savedState.inquiryMap ?? {});
	const [summaryMap, setSummaryMap] = useState<Record<string, SummaryData>>(savedState.summaryMap ?? {});
	const [inquirySelections, setInquirySelections] = useState<Record<string, string[]>>({});
	const [inquiryTexts, setInquiryTexts] = useState<Record<string, string>>({});
	const [extVersion, setExtVersion] = useState<string>((window as any).__EXT_VERSION__ || '?');

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messageLogRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const userScrolledUp = useRef(false);
	const prevLogCountRef = useRef(0);

	// persist state
	useEffect(() => {
		vscode.setState({ sessions, activeSessionId, logsMap, pendingMap, mcpConfigured, rulePrompt, inquiryMap, summaryMap });
	}, [sessions, activeSessionId, logsMap, pendingMap, mcpConfigured, rulePrompt, inquiryMap, summaryMap]);

	// track user scroll position
	useEffect(() => {
		const el = messageLogRef.current;
		if (!el) return;
		const onScroll = () => {
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
			userScrolledUp.current = !atBottom;
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	}, []);

	// auto-scroll only when new messages arrive AND user is at bottom
	useEffect(() => {
		const logs = logsMap[activeSessionId] || [];
		const newCount = logs.length;
		const hadNewMessages = newCount > prevLogCountRef.current;
		prevLogCountRef.current = newCount;

		if (hadNewMessages && !userScrolledUp.current) {
			messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
		}
	}, [logsMap, activeSessionId]);

	// reset scroll tracking on session switch
	useEffect(() => {
		userScrolledUp.current = false;
		prevLogCountRef.current = (logsMap[activeSessionId] || []).length;
		messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
	}, [activeSessionId]);

	// auto-select first session
	useEffect(() => {
		if (!activeSessionId && sessions.length > 0) {
			setActiveSessionId(sessions[0].id);
		}
	}, [sessions, activeSessionId]);

	// message handler
	useEffect(() => {
		const handler = (e: MessageEvent) => {
			const msg = e.data;
			switch (msg.type) {
				case 'sessions':
					setSessions(msg.data || []);
					break;
				case 'syncLogs':
					setLogsMap(prev => ({ ...prev, [msg.sessionId]: msg.data }));
					break;
				case 'pendingCount':
					setPendingMap(prev => ({ ...prev, [msg.sessionId]: msg.items || [] }));
					break;
				case 'mcpConfigured':
					setMcpConfigured(msg.data);
					break;
				case 'rulePrompt':
					setRulePrompt(msg.data);
					break;
				case 'sharedFile':
					setSharedFiles(prev => [...prev, msg.data]);
					break;
				case 'inquiry':
					if (msg.data && !msg.data.answered) {
						setInquiryMap(prev => ({ ...prev, [msg.sessionId]: msg.data }));
					} else {
						setInquiryMap(prev => { const n = { ...prev }; delete n[msg.sessionId]; return n; });
					}
					break;
			case 'summary':
				if (msg.data?.text) {
					setSummaryMap(prev => ({ ...prev, [msg.sessionId]: msg.data }));
				}
				break;
			case 'slashResult':
				setLogsMap(prev => {
					const logs = [...(prev[msg.sessionId] || [])];
					logs.push({ role: 'system', text: msg.text, ts: Date.now() });
					return { ...prev, [msg.sessionId]: logs };
				});
				break;
			case 'extensionInfo':
				if (msg.version) setExtVersion(msg.version);
				break;
			}
		};
		window.addEventListener('message', handler);
		vscode.postMessage({ type: 'init' });
		return () => window.removeEventListener('message', handler);
	}, []);

	const handleSend = useCallback(() => {
		const text = inputText.trim();
		const fileTexts = sharedFiles.map(f => `[file: ${f.path}]`).join('\n');
		const fullText = [text, fileTexts].filter(Boolean).join('\n');
		if (!fullText && images.length === 0) return;

		vscode.postMessage({
			type: 'text',
			text: fullText,
			sessionId: activeSessionId || 'default',
			images: images.map(img => ({ name: img.name, dataUrl: img.dataUrl })),
		});
		setInputText('');
		setSharedFiles([]);
		setImages([]);
		textareaRef.current?.focus();
	}, [inputText, sharedFiles, activeSessionId, images]);

	const fileInputRef = useRef<HTMLInputElement>(null);

	const addImageFromFile = useCallback((file: File) => {
		if (!file.type.startsWith('image/')) return;
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			setImages(prev => [...prev, { name: file.name, dataUrl }]);
		};
		reader.readAsDataURL(file);
	}, []);

	const handlePaste = useCallback((e: React.ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (let i = 0; i < items.length; i++) {
			if (items[i].type.startsWith('image/')) {
				e.preventDefault();
				const file = items[i].getAsFile();
				if (file) addImageFromFile(file);
				return;
			}
		}
	}, [addImageFromFile]);

	const handleImagePick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (!files) return;
		for (let i = 0; i < files.length; i++) {
			addImageFromFile(files[i]);
		}
		e.target.value = '';
	}, [addImageFromFile]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter') {
			if (e.shiftKey || e.ctrlKey || e.metaKey) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			handleSend();
		}
	}, [handleSend]);

	const handleReconnect = useCallback(() => {
		vscode.postMessage({ type: 'reconnect' });
	}, []);

	const handleCopyRule = useCallback(() => {
		vscode.postMessage({ type: 'copyRule' });
	}, []);

	const handleCloseSession = useCallback((sid: string) => {
		vscode.postMessage({ type: 'closeSession', sessionId: sid });
		if (activeSessionId === sid) {
			const remaining = sessions.filter(s => s.id !== sid && s.alive);
			setActiveSessionId(remaining.length > 0 ? remaining[0].id : '');
		}
	}, [activeSessionId, sessions]);

	const [summaryCollapsed, setSummaryCollapsed] = useState(false);
	const [editingPendingId, setEditingPendingId] = useState<string | null>(null);
	const [editingPendingText, setEditingPendingText] = useState('');
	const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
	const [renameText, setRenameText] = useState('');
	const renameInputRef = useRef<HTMLInputElement>(null);

	const handleStartRename = useCallback((sid: string, currentName: string) => {
		setRenamingSessionId(sid);
		setRenameText(currentName);
		setTimeout(() => renameInputRef.current?.select(), 50);
	}, []);

	const handleConfirmRename = useCallback(() => {
		if (!renamingSessionId) return;
		const name = renameText.trim();
		if (name) {
			vscode.postMessage({ type: 'renameSession', sessionId: renamingSessionId, newName: name });
		}
		setRenamingSessionId(null);
		setRenameText('');
	}, [renamingSessionId, renameText]);

	const handleCancelRename = useCallback(() => {
		setRenamingSessionId(null);
		setRenameText('');
	}, []);

	const handleAnswerInquiry = useCallback((sid: string, inquiry: InquiryData) => {
		const answers = inquiry.questions.map((q, qi) => {
			const key = `${qi}`;
			return {
				question: q.question,
				selected: inquirySelections[key] || [],
				text: inquiryTexts[key] || '',
			};
		});
		vscode.postMessage({ type: 'answerInquiry', sessionId: sid, answers });
		setInquiryMap(prev => { const n = { ...prev }; delete n[sid]; return n; });
		setInquirySelections({});
		setInquiryTexts({});
	}, [inquirySelections, inquiryTexts]);

	const toggleSelection = useCallback((qIdx: string, optId: string, multiple: boolean) => {
		setInquirySelections(prev => {
			const current = prev[qIdx] || [];
			if (multiple) {
				return { ...prev, [qIdx]: current.includes(optId) ? current.filter(x => x !== optId) : [...current, optId] };
			}
			return { ...prev, [qIdx]: [optId] };
		});
	}, []);

	const dismissSummary = useCallback((sid: string) => {
		setSummaryMap(prev => { const n = { ...prev }; delete n[sid]; return n; });
		setSummaryCollapsed(false);
	}, []);

	const handleDeletePending = useCallback((itemId: string) => {
		vscode.postMessage({
			type: 'deletePending',
			sessionId: activeSessionId || 'default',
			itemId,
		});
	}, [activeSessionId]);

	const handleResendPending = useCallback((itemId: string) => {
		vscode.postMessage({
			type: 'resendPending',
			sessionId: activeSessionId || 'default',
			itemId,
		});
	}, [activeSessionId]);

	const handleStartEditPending = useCallback((item: PendingItem) => {
		setEditingPendingId(item.id);
		setEditingPendingText(item.content);
	}, []);

	const handleSaveEditPending = useCallback(() => {
		if (!editingPendingId) return;
		const text = editingPendingText.trim();
		if (!text) {
			handleDeletePending(editingPendingId);
		} else {
			vscode.postMessage({
				type: 'editPending',
				sessionId: activeSessionId || 'default',
				itemId: editingPendingId,
				newContent: text,
			});
		}
		setEditingPendingId(null);
		setEditingPendingText('');
	}, [editingPendingId, editingPendingText, activeSessionId, handleDeletePending]);

	const handleCancelEditPending = useCallback(() => {
		setEditingPendingId(null);
		setEditingPendingText('');
	}, []);

	const aliveSessions = sessions.filter(s => s.alive);
	const currentLogs = logsMap[activeSessionId] || [];
	const currentPending = pendingMap[activeSessionId] || [];
	const totalPending = Object.values(pendingMap).reduce((sum, items) => sum + items.length, 0);

	return (
		<div className="app">
			{/* TopBar */}
			<div className="topbar">
				<div className="topbar-left">
					<span className={`status-dot ${aliveSessions.length > 0 ? 'connected' : 'disconnected'}`} />
					<span className="topbar-title">MultiSession</span>
				</div>
				<div className="topbar-right">
					<button className="btn-small" onClick={handleCopyRule} title="复制通信规则">
						规则
					</button>
					<button className="btn-small btn-accent" onClick={handleReconnect} title="重连 Composer">
						重连
					</button>
					{totalPending > 0 && (
						<span className="badge">{totalPending}</span>
					)}
				</div>
			</div>

			{/* MCP not configured - prompt user to install */}
			{!mcpConfigured && (
				<div className="notice">
					<span>MCP 未配置，需要安装后才能使用。</span>
					<button className="btn-install" onClick={() => vscode.postMessage({ type: 'installMcp' })}>
						安装 MCP + 通信规则
					</button>
				</div>
			)}

			{/* Session Tabs */}
		{aliveSessions.length > 0 && (
			<div className="session-tabs">
				{aliveSessions.map(s => (
					<div
						key={s.id}
						className={`session-tab ${s.id === activeSessionId ? 'active' : ''}`}
						onClick={() => setActiveSessionId(s.id)}
						onDoubleClick={(e) => { e.stopPropagation(); handleStartRename(s.id, s.name); }}
						title="双击重命名"
					>
						{renamingSessionId === s.id ? (
							<input
								ref={renameInputRef}
								className="tab-rename-input"
								value={renameText}
								onChange={e => setRenameText(e.target.value)}
								onBlur={handleConfirmRename}
								onKeyDown={e => {
									if (e.key === 'Enter') { e.preventDefault(); handleConfirmRename(); }
									if (e.key === 'Escape') handleCancelRename();
								}}
								onClick={e => e.stopPropagation()}
								autoFocus
							/>
						) : (
							<span className="tab-name">{s.name}</span>
						)}
						{(pendingMap[s.id]?.length || 0) > 0 && (
							<span className="tab-badge">{pendingMap[s.id].length}</span>
						)}
						<button
							className="tab-close"
							onClick={(e) => { e.stopPropagation(); handleCloseSession(s.id); }}
							title="关闭会话"
						>
							×
						</button>
					</div>
				))}
			</div>
		)}

			{/* Summary Toast (non-blocking, above message log) */}
			{summaryMap[activeSessionId] && (
				<div className="summary-toast">
					<div className="summary-header">
						<span>AI 总结</span>
						<div className="summary-actions">
							<button
								className="tab-close"
								onClick={() => setSummaryCollapsed(c => !c)}
								title={summaryCollapsed ? '展开' : '折叠'}
							>
								{summaryCollapsed ? '▼' : '▲'}
							</button>
							<button className="tab-close" onClick={() => dismissSummary(activeSessionId)} title="关闭">×</button>
						</div>
					</div>
					{!summaryCollapsed && (
						<div
							className="summary-body"
							dangerouslySetInnerHTML={{ __html: renderMarkdown(summaryMap[activeSessionId].text) }}
						/>
					)}
				</div>
			)}

			{/* Message Log */}
			<div className="message-log" ref={messageLogRef}>
				{aliveSessions.length === 0 && (
					<div className="empty-state">
						<p>暂无活跃会话</p>
						<p className="hint">在 Composer 中粘贴通信规则并发送消息以创建会话</p>
						<button className="btn-primary" onClick={handleCopyRule}>复制通信规则</button>
					</div>
				)}
			{currentLogs.map((msg, i) => (
				<div key={i} className={`message message-${msg.role}`}>
					<div className="message-role">{msg.role === 'user' ? '你' : msg.role === 'system' ? '系统' : 'AI'}</div>
						<div className="message-text">
							{msg.text.split(/(\[image: [^\]]+\])/).map((part, pi) => {
								const imgMatch = part.match(/^\[image: (.+)\]$/);
								if (imgMatch) {
									return <span key={pi} className="msg-image-ref" title={imgMatch[1]}>📷 图片</span>;
								}
								return <span key={pi}>{part}</span>;
							})}
						</div>
						<div className="message-time">
							{new Date(msg.ts).toLocaleTimeString()}
						</div>
					</div>
				))}
				{currentPending.length > 0 && (
					<div className="pending-section">
						<div className="pending-label">待处理 ({currentPending.length})</div>
						{currentPending.map(item => (
							<div key={item.id} className="message message-pending">
								{editingPendingId === item.id ? (
									<div className="pending-edit">
										<textarea
											className="pending-edit-textarea"
											value={editingPendingText}
											onChange={e => setEditingPendingText(e.target.value)}
											onKeyDown={e => {
												if (e.key === 'Enter' && !e.shiftKey) {
													e.preventDefault();
													handleSaveEditPending();
												}
												if (e.key === 'Escape') handleCancelEditPending();
											}}
											rows={3}
											autoFocus
										/>
										<div className="pending-edit-actions">
											<button className="btn-small btn-accent" onClick={handleSaveEditPending}>保存</button>
											<button className="btn-small" onClick={handleCancelEditPending}>取消</button>
										</div>
									</div>
								) : (
									<>
										<div className="message-text">{item.content}</div>
										<div className="pending-actions">
											<button
												className="pending-action-btn pending-action-send"
												onClick={() => handleResendPending(item.id)}
												title="立即发送"
											>
												▶
											</button>
											<button
												className="pending-action-btn"
												onClick={() => handleStartEditPending(item)}
												title="编辑"
											>
												✎
											</button>
											<button
												className="pending-action-btn pending-action-delete"
												onClick={() => handleDeletePending(item.id)}
												title="删除"
											>
												×
											</button>
										</div>
									</>
								)}
							</div>
						))}
					</div>
				)}
				<div ref={messagesEndRef} />
			</div>

			{/* Inquiry Form */}
			{inquiryMap[activeSessionId] && !inquiryMap[activeSessionId].answered && (
				<div className="inquiry-section">
					<div className="inquiry-label">AI 提问</div>
					{inquiryMap[activeSessionId].questions.map((q, qi) => (
						<div key={qi} className="inquiry-question">
							<div className="inquiry-q-text">{q.question}</div>
							<div className="inquiry-options">
								{q.options.map(opt => {
									const key = `${qi}`;
									const selected = (inquirySelections[key] || []).includes(opt.id);
									return (
										<button
											key={opt.id}
											className={`inquiry-option ${selected ? 'selected' : ''}`}
											onClick={() => toggleSelection(key, opt.id, !!q.allow_multiple)}
										>
											{opt.label}
										</button>
									);
								})}
							</div>
							<input
								className="inquiry-text-input"
								placeholder="补充说明（可选）"
								value={inquiryTexts[`${qi}`] || ''}
								onChange={e => setInquiryTexts(prev => ({ ...prev, [`${qi}`]: e.target.value }))}
							/>
						</div>
					))}
					<button
						className="btn-primary"
						onClick={() => handleAnswerInquiry(activeSessionId, inquiryMap[activeSessionId])}
					>
						提交回答
					</button>
				</div>
			)}

			{/* Shared Files */}
			{sharedFiles.length > 0 && (
				<div className="shared-files">
					{sharedFiles.map((f, i) => (
						<span key={i} className="file-tag">
							{f.name}
							<button onClick={() => setSharedFiles(prev => prev.filter((_, j) => j !== i))}>×</button>
						</span>
					))}
				</div>
			)}

			{/* Image Preview */}
			{images.length > 0 && (
				<div className="image-preview-bar">
					{images.map((img, i) => (
						<div key={i} className="image-preview-item">
							<img src={img.dataUrl} alt={img.name} className="image-preview-thumb" />
							<button
								className="image-preview-remove"
								onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
							>×</button>
						</div>
					))}
				</div>
			)}

			{/* Input Area */}
			<div className="input-area">
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					multiple
					style={{ display: 'none' }}
					onChange={handleImagePick}
				/>
				<button
					className="btn-image"
					onClick={() => fileInputRef.current?.click()}
					title="添加图片"
				>
					🖼
				</button>
				<textarea
					ref={textareaRef}
					className="input-textarea"
					value={inputText}
					onChange={e => setInputText(e.target.value)}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					placeholder="输入消息... (Enter 发送, Shift+Enter 换行, 可粘贴图片)"
					rows={2}
				/>
				<button
					className="btn-send"
					onClick={handleSend}
					disabled={!inputText.trim() && sharedFiles.length === 0 && images.length === 0}
				>
					发送
				</button>
			</div>
			<div className="version-footer">v{extVersion}</div>
		</div>
	);
}

// ── mount ──

try {
	const el = document.getElementById('root');
	if (!el) throw new Error('root element not found');
	const root = createRoot(el);
	root.render(<App />);
} catch (err: any) {
	const el = document.getElementById('root') || document.body;
	el.innerHTML = `<div style="padding:16px;color:#f44;font-size:13px;font-family:monospace;">
		<p><strong>MultiSession render error</strong></p>
		<pre style="white-space:pre-wrap;">${err?.message || err}</pre>
		<pre style="white-space:pre-wrap;font-size:11px;opacity:0.7;">${err?.stack || ''}</pre>
	</div>`;
}
