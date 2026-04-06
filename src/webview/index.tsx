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
	const [acItems, setAcItems] = useState<{ id: string; label: string; desc?: string }[]>([]);
	const [acMode, setAcMode] = useState<'skill' | 'history' | null>(null);
	const [acIndex, setAcIndex] = useState(0);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const settingsRef = useRef<HTMLDivElement>(null);

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messageLogRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const userScrolledUp = useRef(false);
	const prevLogCountRef = useRef(0);

	// persist state
	useEffect(() => {
		vscode.setState({ sessions, activeSessionId, logsMap, pendingMap, mcpConfigured, rulePrompt, inquiryMap, summaryMap });
	}, [sessions, activeSessionId, logsMap, pendingMap, mcpConfigured, rulePrompt, inquiryMap, summaryMap]);

	// close settings dropdown on outside click
	useEffect(() => {
		if (!settingsOpen) return;
		const onClick = (e: MouseEvent) => {
			if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
				setSettingsOpen(false);
			}
		};
		document.addEventListener('click', onClick, true);
		return () => document.removeEventListener('click', onClick, true);
	}, [settingsOpen]);

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
			case 'skillContent':
				setInputText(prev => {
					const prefix = prev ? prev + '\n' : '';
					return prefix + `[skill: ${msg.skillName}]\n${msg.content}`;
				});
				setAcMode(null);
				setAcItems([]);
				break;
			case 'skillList':
				setAcItems((msg.skills || []).map((s: any) => ({ id: s.name, label: s.name, desc: s.desc })));
				setAcMode('skill');
				setAcIndex(0);
				break;
			case 'historyList':
				setAcItems(prev => {
					const files = prev.filter(i => i.id.startsWith('file:'));
					const histItems = (msg.items || []).map((h: any) => ({ id: h.id, label: h.label || h.name || h.id, desc: h.desc || '', group: 'history' }));
					return [...files, ...histItems];
				});
				setAcMode('history');
				setAcIndex(0);
				break;
			case 'openFilesList':
				setAcItems(prev => {
					const nonFiles = prev.filter(i => !i.id.startsWith('file:'));
					const fileItems = (msg.files || []).map((f: any) => ({ id: `file:${f.path}`, label: f.name, desc: f.path, group: 'file' }));
					return [...fileItems, ...nonFiles];
				});
				if (acMode !== 'history') {
					setAcMode('history');
					setAcIndex(0);
				}
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

	const handleDeleteMessage = useCallback((msgIndex: number) => {
		const sid = activeSessionId || 'default';
		vscode.postMessage({ type: 'deleteMessage', sessionId: sid, msgIndex });
		setLogsMap(prev => {
			const logs = [...(prev[sid] || [])];
			logs.splice(msgIndex, 1);
			return { ...prev, [sid]: logs };
		});
	}, [activeSessionId]);

	const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const val = e.target.value;
		setInputText(val);
		if (val === '/') {
			vscode.postMessage({ type: 'requestSkills' });
		} else if (val === '@') {
			vscode.postMessage({ type: 'requestHistory' });
			vscode.postMessage({ type: 'requestOpenFiles' });
		} else if (!val.startsWith('/') && !val.startsWith('@')) {
			setAcMode(null);
			setAcItems([]);
		}
		setAcIndex(0);
	}, []);

	const filteredAcItems = useMemo(() => {
		if (!acMode || acItems.length === 0) return [];
		if (acMode === 'skill' && inputText.startsWith('/')) {
			const q = inputText.slice(1).toLowerCase();
			if (!q) return acItems;
			return acItems.filter(i => i.label.toLowerCase().includes(q));
		}
		if (acMode === 'history' && inputText.startsWith('@')) {
			const q = inputText.slice(1).toLowerCase();
			if (!q) return acItems;
			return acItems.filter(i => i.label.toLowerCase().includes(q) || (i.desc || '').toLowerCase().includes(q));
		}
		return acItems;
	}, [acMode, acItems, inputText]);

	const selectAcItem = useCallback((item: { id: string; label: string }) => {
		if (acMode === 'skill') {
			setSharedFiles(prev => [...prev, { path: `@skill:${item.label}`, name: `skill: ${item.label}` }]);
		} else if (item.id.startsWith('file:')) {
			const filePath = item.id.slice(5);
			setSharedFiles(prev => [...prev, { path: filePath, name: item.label }]);
		} else if (acMode === 'history') {
			setSharedFiles(prev => [...prev, { path: `@history:${item.id}`, name: `chat: ${item.label}` }]);
		}
		setInputText('');
		setAcMode(null);
		setAcItems([]);
		setTimeout(() => textareaRef.current?.focus(), 50);
	}, [acMode]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (acMode && filteredAcItems.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setAcIndex(prev => Math.min(prev + 1, filteredAcItems.length - 1));
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setAcIndex(prev => Math.max(prev - 1, 0));
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				selectAcItem(filteredAcItems[acIndex]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setAcMode(null);
				setAcItems([]);
				return;
			}
		}
		if (e.key === 'Enter') {
			if (e.shiftKey || e.ctrlKey || e.metaKey) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			handleSend();
		}
	}, [handleSend, acMode, filteredAcItems, acIndex, selectAcItem]);

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

	const handleCopyResumeRule = useCallback((sid: string) => {
		vscode.postMessage({ type: 'copyResumeRule', sessionId: sid });
	}, []);

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
	const closedSessions = sessions.filter(s => !s.alive);
	const [showClosed, setShowClosed] = useState(false);
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
			<button className="btn-small" onClick={handleCopyRule} data-tooltip="复制通信规则到剪贴板（粘贴到新 Composer 启动会话）" data-tooltip-pos="left">
				规则
			</button>
			<button className="btn-small btn-accent" onClick={handleReconnect} data-tooltip="重连 Composer（断开时使用）" data-tooltip-pos="left">
				重连
			</button>
				{totalPending > 0 && (
					<span className="badge">{totalPending}</span>
				)}
				<div className="settings-wrapper" ref={settingsRef}>
					<button
						className="btn-small btn-icon"
						onClick={() => setSettingsOpen(prev => !prev)}
						data-tooltip="设置"
						data-tooltip-pos="left"
					>
						⚙
					</button>
					{settingsOpen && (
						<div className="settings-dropdown">
							<button className="dropdown-item" onClick={() => { vscode.postMessage({ type: 'installMcp' }); setSettingsOpen(false); }}>
								重新安装 MCP + 规则 + Hooks
							</button>
						{closedSessions.length > 0 && (
							<button className="dropdown-item" onClick={() => { setShowClosed(prev => !prev); setSettingsOpen(false); }}>
								{showClosed ? '隐藏' : '打开'}已关闭会话 ({closedSessions.length})
							</button>
						)}
						<button className="dropdown-item dropdown-item-danger" onClick={() => { vscode.postMessage({ type: 'uninstallMcp' }); setSettingsOpen(false); }}>
							卸载 MCP 配置
						</button>
						<div className="dropdown-divider" />
						<div className="dropdown-version">v{extVersion}</div>
						</div>
					)}
				</div>
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
						data-tooltip="双击重命名"
						data-tooltip-pos="below"
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
						className="tab-action"
						onClick={(e) => { e.stopPropagation(); handleCopyResumeRule(s.id); }}
						data-tooltip="复制恢复规则（粘贴到新 Composer 恢复此会话）"
						data-tooltip-pos="below"
					>
						↻
					</button>
					<button
						className="tab-close"
						onClick={(e) => { e.stopPropagation(); handleCloseSession(s.id); }}
						data-tooltip="关闭会话"
						data-tooltip-pos="below"
					>
						×
					</button>
					</div>
				))}
			</div>
		)}

			{/* Closed sessions panel */}
			{showClosed && closedSessions.length > 0 && (
				<div className="closed-sessions-panel">
					<div className="closed-sessions-header">
						<span>已关闭会话</span>
						<button className="tab-close" onClick={() => setShowClosed(false)}>×</button>
					</div>
					<div className="closed-sessions-list">
						{closedSessions.map(s => (
							<div key={s.id} className="closed-session-item">
								<span className="closed-session-name">{s.name}</span>
								<button
									className="btn-small"
									onClick={() => {
										vscode.postMessage({ type: 'reopenSession', sessionId: s.id });
										setActiveSessionId(s.id);
									}}
								>
									打开
								</button>
							</div>
						))}
					</div>
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
					<div className="onboarding-icon">⟐</div>
					<div className="onboarding-title">MultiSession</div>
					<div className="onboarding-subtitle">等待 AI 连接 <span className="dot-pulse" /></div>
					<div className="onboarding-steps">
						<div className="step"><span className="step-num">1</span><span>在 Cursor 设置中启用 MultiSession MCP</span></div>
						<div className="step"><span className="step-num">2</span><span>点击下方「复制规则」按钮复制通信规则</span></div>
						<div className="step"><span className="step-num">3</span><span>在 Cursor 聊天窗口粘贴规则并发送</span></div>
						<div className="step"><span className="step-num">4</span><span>Cursor 发完消息后此插件会展示会话 Tab</span></div>
						<div className="step"><span className="step-num">5</span><span>会话 Tab 可双击或右击编辑标题，点击关闭按钮可删除会话</span></div>
					</div>
					<div className="onboarding-actions">
						{!mcpConfigured && (
							<button className="btn-primary btn-onboard" onClick={() => vscode.postMessage({ type: 'installMcp' })}>
								一键安装 MCP
							</button>
						)}
						<button className="btn-primary btn-onboard" onClick={handleCopyRule}>
							复制规则
						</button>
					</div>
					<p className="onboarding-hint">请参考下方「使用教程」了解更多</p>
				</div>
			)}
		{currentLogs.map((msg, i) => (
			<div key={i} className={`message message-${msg.role}`}>
				<div className="message-header">
					<div className="message-role">{msg.role === 'user' ? '你' : msg.role === 'system' ? '系统' : 'AI'}</div>
					<button className="msg-delete" onClick={() => handleDeleteMessage(i)} title="删除此消息">×</button>
				</div>
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
				<div className="input-toolbar">
					<button
						className="btn-toolbar"
						onClick={() => fileInputRef.current?.click()}
						title="添加图片"
					>
						🖼
					</button>
					<button
						className="btn-toolbar"
						onClick={() => vscode.postMessage({ type: 'pickFile' })}
						title="附加文件 (@file)"
					>
						📎
					</button>
					<button
						className="btn-toolbar"
						onClick={() => vscode.postMessage({ type: 'pickFolder' })}
						title="附加文件夹"
					>
						📁
					</button>
				</div>
				<div className="input-wrapper">
				{acMode && filteredAcItems.length > 0 && (
					<div className="ac-popup">
						{acMode === 'skill' && <div className="ac-title">Skills</div>}
						{acMode === 'history' && (() => {
							const files = filteredAcItems.filter((i: any) => i.id.startsWith('file:'));
							const chats = filteredAcItems.filter((i: any) => !i.id.startsWith('file:'));
							let globalIdx = -1;
							return <>
								{files.length > 0 && <>
									<div className="ac-title">Open Files</div>
									{files.map(item => {
										globalIdx++;
										const idx = globalIdx;
										return <div key={item.id} className={`ac-item${idx === acIndex ? ' active' : ''}`}
											onMouseDown={e => { e.preventDefault(); selectAcItem(item); }}
											onMouseEnter={() => setAcIndex(idx)}>
											<span className="ac-icon">📄</span>
											<span className="ac-label">{item.label}</span>
											{item.desc && <span className="ac-desc">{item.desc}</span>}
										</div>;
									})}
								</>}
								{chats.length > 0 && <>
									<div className="ac-title">Past Chats</div>
									{chats.map(item => {
										globalIdx++;
										const idx = globalIdx;
										return <div key={item.id} className={`ac-item${idx === acIndex ? ' active' : ''}`}
											onMouseDown={e => { e.preventDefault(); selectAcItem(item); }}
											onMouseEnter={() => setAcIndex(idx)}>
											<span className="ac-icon">💬</span>
											<span className="ac-label">{item.label}</span>
											{item.desc && <span className="ac-desc">{item.desc}</span>}
										</div>;
									})}
								</>}
							</>;
						})()}
						{acMode === 'skill' && filteredAcItems.map((item, i) => (
							<div key={item.id} className={`ac-item${i === acIndex ? ' active' : ''}`}
								onMouseDown={e => { e.preventDefault(); selectAcItem(item); }}
								onMouseEnter={() => setAcIndex(i)}>
								<span className="ac-label">{item.label}</span>
								{item.desc && <span className="ac-desc">{item.desc}</span>}
							</div>
						))}
					</div>
				)}
					<textarea
						ref={textareaRef}
						className="input-textarea"
						value={inputText}
						onChange={handleInputChange}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						placeholder="输入消息... (Enter 发送, / Skills, @ History)"
						rows={2}
					/>
				</div>
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
