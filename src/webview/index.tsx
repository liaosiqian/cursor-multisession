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
	urgent?: boolean;
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
	const [draftsMap, setDraftsMap] = useState<Record<string, string>>(savedState.draftsMap ?? {});
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
	const [keepAlive, setKeepAlive] = useState(false);
	const [undeliveredSessions, setUndeliveredSessions] = useState<Set<string>>(new Set());
	const [agentStatusMap, setAgentStatusMap] = useState<Record<string, { status: string; since: number; preview?: string }>>({});
	const [totalCountMap, setTotalCountMap] = useState<Record<string, number>>({});
	const loadingMoreRef = useRef(false);
	const [isRecording, setIsRecording] = useState(false);
	const [isTranscribing, setIsTranscribing] = useState(false);
	const [recordingDuration, setRecordingDuration] = useState(0);
	const [voiceMode, setVoiceMode] = useState(false);
	const [isSpeaking, setIsSpeaking] = useState(false);
	const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const voiceModeRef = useRef(false);
	const lastSpokenTextRef = useRef<string>('');
	const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const lastUserActivityRef = useRef(Date.now());
	const settingsRef = useRef<HTMLDivElement>(null);

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const messageLogRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const editorRef = useRef<HTMLDivElement>(null);
	const userScrolledUp = useRef(false);
	const prevLogCountRef = useRef(0);

	useEffect(() => { voiceModeRef.current = voiceMode; }, [voiceMode]);

	// persist state
	useEffect(() => {
		vscode.setState({ sessions, activeSessionId, logsMap, pendingMap, mcpConfigured, rulePrompt, inquiryMap, summaryMap, draftsMap });
	}, [sessions, activeSessionId, logsMap, pendingMap, mcpConfigured, rulePrompt, inquiryMap, summaryMap, draftsMap]);

	// keep-alive: send a time query every 5 min when user is idle
	useEffect(() => {
		if (keepAliveRef.current) {
			clearInterval(keepAliveRef.current);
			keepAliveRef.current = null;
		}
		if (!keepAlive || !activeSessionId) return;

		const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000;
		const IDLE_THRESHOLD = 4 * 60 * 1000;

		keepAliveRef.current = setInterval(() => {
			const idle = Date.now() - lastUserActivityRef.current;
			const hasPending = (pendingMap[activeSessionId] || []).length > 0;
			const isProcessing = agentStatusMap[activeSessionId]?.status === 'processing';
			if (idle >= IDLE_THRESHOLD && !hasPending && !isProcessing) {
				vscode.postMessage({
					type: 'text',
					text: '[keep-alive] 请只回复当前时间，格式：HH:MM:SS',
					sessionId: activeSessionId,
					images: [],
				});
			}
		}, KEEP_ALIVE_INTERVAL);

		return () => {
			if (keepAliveRef.current) {
				clearInterval(keepAliveRef.current);
				keepAliveRef.current = null;
			}
		};
	}, [keepAlive, activeSessionId, pendingMap, agentStatusMap]);

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

	// track user scroll position + load more on scroll to top
	useEffect(() => {
		const el = messageLogRef.current;
		if (!el) return;
		const onScroll = () => {
			const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
			userScrolledUp.current = !atBottom;
			if (el.scrollTop < 60 && !loadingMoreRef.current) {
				const currentLogs = logsMap[activeSessionId] || [];
				const total = totalCountMap[activeSessionId] || 0;
				if (currentLogs.length < total) {
					loadingMoreRef.current = true;
					vscode.postMessage({ type: 'loadMoreLogs', sessionId: activeSessionId, currentCount: currentLogs.length });
				}
			}
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	}, [activeSessionId, logsMap, totalCountMap]);

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

	const prevSessionRef = useRef(activeSessionId);
	useEffect(() => {
		const prev = prevSessionRef.current;
		if (prev && prev !== activeSessionId) {
			setDraftsMap(d => ({ ...d, [prev]: inputText }));
		}
		setInputText(draftsMap[activeSessionId] ?? '');
		prevSessionRef.current = activeSessionId;

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
					setSessions(prev => {
						const next = msg.data || [];
						if (prev.length === next.length && prev.every((s: SessionMeta, i: number) =>
							s.id === next[i].id && s.name === next[i].name && s.alive === next[i].alive && s.lastActiveAt === next[i].lastActiveAt
						)) return prev;
						return next;
					});
					break;
				case 'syncLogs': {
				const newLogs: ChatMessage[] = msg.data || [];
				if (msg.totalCount !== undefined) {
					setTotalCountMap(prev => {
						if (prev[msg.sessionId] === msg.totalCount) return prev;
						return { ...prev, [msg.sessionId]: msg.totalCount };
					});
				}
				setLogsMap(prev => {
					const prevLogs = prev[msg.sessionId] || [];
					if (prevLogs.length === newLogs.length && prevLogs.length > 0) {
						const lastOld = prevLogs[prevLogs.length - 1];
						const lastNew = newLogs[newLogs.length - 1];
						if (lastOld.ts === lastNew.ts && lastOld.text === lastNew.text && lastOld.role === lastNew.role) {
							return prev;
						}
					}
					if (voiceModeRef.current && msg.sessionId === activeSessionId && newLogs.length > prevLogs.length) {
						const latest = newLogs[newLogs.length - 1];
						if (latest && latest.role === 'assistant' && latest.text && latest.text !== lastSpokenTextRef.current) {
							lastSpokenTextRef.current = latest.text;
							vscode.postMessage({ type: 'speakText', text: latest.text });
						}
					}
					return { ...prev, [msg.sessionId]: newLogs };
				});
				break;
			}
			case 'prependLogs': {
				const older: ChatMessage[] = msg.data || [];
				if (msg.totalCount !== undefined) {
					setTotalCountMap(prev => {
						if (prev[msg.sessionId] === msg.totalCount) return prev;
						return { ...prev, [msg.sessionId]: msg.totalCount };
					});
				}
				setLogsMap(prev => {
					const existing = prev[msg.sessionId] || [];
					return { ...prev, [msg.sessionId]: [...older, ...existing] };
				});
				loadingMoreRef.current = false;
				break;
			}
			case 'pendingCount':
				setPendingMap(prev => {
					const items = msg.items || [];
					const prevItems = prev[msg.sessionId] || [];
					if (prevItems.length === items.length && prevItems.length === 0) return prev;
					return { ...prev, [msg.sessionId]: items };
				});
				if (!msg.items || msg.items.length === 0) {
					setUndeliveredSessions(prev => {
						if (!prev.has(msg.sessionId)) return prev;
						const next = new Set(prev);
						next.delete(msg.sessionId);
						return next;
					});
				}
				break;
				case 'mcpConfigured':
					setMcpConfigured(msg.data);
					break;
				case 'rulePrompt':
					setRulePrompt(msg.data);
					break;
				case 'sharedFile': {
					const f = msg.data;
					if (f?.path && editorRef.current) {
						const editor = editorRef.current;
						editor.focus();
						const chip = document.createElement('span');
						chip.contentEditable = 'false';
						chip.dataset.chipPath = f.path;
						chip.dataset.chipName = f.name;
						chip.className = 'inline-chip chip-file';
						chip.textContent = `📄 ${f.name}`;
						const sel = window.getSelection();
						if (sel && sel.rangeCount) {
							const range = sel.getRangeAt(0);
							range.collapse(false);
							range.insertNode(chip);
							const space = document.createTextNode('\u00A0');
							chip.after(space);
							const r = document.createRange();
							r.setStartAfter(space);
							r.collapse(true);
							sel.removeAllRanges();
							sel.addRange(r);
						} else {
							editor.appendChild(chip);
							editor.appendChild(document.createTextNode('\u00A0'));
						}
						setInputText(editor.textContent || '');
					}
					break;
				}
				case 'inquiry':
					if (msg.data && !msg.data.answered) {
						setInquiryMap(prev => {
							const old = prev[msg.sessionId];
							if (old && old.id === msg.data.id && old.answered === msg.data.answered) return prev;
							return { ...prev, [msg.sessionId]: msg.data };
						});
					} else {
						setInquiryMap(prev => {
							if (!(msg.sessionId in prev)) return prev;
							const n = { ...prev }; delete n[msg.sessionId]; return n;
						});
					}
					break;
			case 'summary':
				if (msg.data?.text) {
					setSummaryMap(prev => {
						const old = prev[msg.sessionId];
						if (old && old.text === msg.data.text && old.ts === msg.data.ts) return prev;
						return { ...prev, [msg.sessionId]: msg.data };
					});
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
					const nonFiles = prev.filter(i => !i.id.startsWith('file:') && !i.id.startsWith('recent:'));
					const fileItems = (msg.files || []).map((f: any) => ({ id: `file:${f.path}`, label: f.name, desc: f.path }));
					const recentItems = (msg.recentFiles || []).map((f: any) => ({ id: `recent:${f.path}`, label: f.name, desc: f.path }));
					return [...fileItems, ...recentItems, ...nonFiles];
				});
				if (acMode !== 'history') {
					setAcMode('history');
					setAcIndex(0);
				}
				break;
		case 'extensionInfo':
			if (msg.version) setExtVersion(msg.version);
			break;
		case 'agentStatus':
			if (msg.data) {
				setAgentStatusMap(prev => {
					const old = prev[msg.sessionId];
					if (old && old.status === msg.data.status && old.since === msg.data.since) return prev;
					return { ...prev, [msg.sessionId]: msg.data };
				});
			}
			break;
		case 'messageNotDelivered':
			setUndeliveredSessions(prev => new Set(prev).add(msg.sessionId));
			break;
		case 'recordingState':
			setIsRecording(!!msg.recording);
			setIsTranscribing(!!msg.transcribing);
			if (msg.recording) {
				setRecordingDuration(0);
				if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
				recordingTimerRef.current = setInterval(() => setRecordingDuration(d => d + 1), 1000);
			} else {
				if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
			}
			break;
		case 'transcription':
			setIsTranscribing(false);
			setIsRecording(false);
			if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null; }
			if (msg.error) {
				setLogsMap(prev => {
					const sid = activeSessionId || 'default';
					const logs = [...(prev[sid] || [])];
					logs.push({ role: 'system', text: `🎤 ${msg.error}`, ts: Date.now() });
					return { ...prev, [sid]: logs };
				});
				break;
			}
			if (msg.text) {
				if (voiceModeRef.current) {
					vscode.postMessage({
						type: 'text',
						text: msg.text,
						sessionId: activeSessionId || 'default',
						images: [],
					});
				} else if (editorRef.current) {
					const editor = editorRef.current;
					editor.focus();
					const sel = window.getSelection();
					if (sel && sel.rangeCount) {
						const range = sel.getRangeAt(0);
						range.collapse(false);
						const textNode = document.createTextNode(msg.text);
						range.insertNode(textNode);
						const r = document.createRange();
						r.setStartAfter(textNode);
						r.collapse(true);
						sel.removeAllRanges();
						sel.addRange(r);
					} else {
						editor.appendChild(document.createTextNode(msg.text));
					}
					setInputText(editor.textContent || '');
				}
			}
			break;
		case 'ttsState':
			setIsSpeaking(!!msg.speaking);
			break;
			}
		};
		window.addEventListener('message', handler);
		vscode.postMessage({ type: 'init' });
		return () => window.removeEventListener('message', handler);
	}, []);

	const extractEditorContent = useCallback(() => {
		const editor = editorRef.current;
		if (!editor) return { text: '', files: [] as { path: string; name: string }[] };
		const parts: string[] = [];
		const files: { path: string; name: string }[] = [];
		const walk = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				parts.push(node.textContent || '');
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				const el = node as HTMLElement;
				if (el.dataset.chipPath) {
					files.push({ path: el.dataset.chipPath, name: el.dataset.chipName || el.textContent || '' });
					parts.push(`[file: ${el.dataset.chipPath}]`);
				} else if (el.tagName === 'BR') {
					parts.push('\n');
				} else if (el.tagName === 'DIV' || el.tagName === 'P') {
					if (parts.length > 0 && parts[parts.length - 1] !== '\n') parts.push('\n');
					el.childNodes.forEach(walk);
					if (parts.length > 0 && parts[parts.length - 1] !== '\n') parts.push('\n');
				} else {
					el.childNodes.forEach(walk);
				}
			}
		};
		editor.childNodes.forEach(walk);
		return { text: parts.join('').trim(), files };
	}, []);

	const handleSend = useCallback(() => {
		const { text, files } = extractEditorContent();
		const imgList = images;
		if (!text && files.length === 0 && imgList.length === 0) return;
		lastUserActivityRef.current = Date.now();

		vscode.postMessage({
			type: 'text',
			text,
			sessionId: activeSessionId || 'default',
			images: imgList.map(img => ({ name: img.name, dataUrl: img.dataUrl })),
		});
		if (editorRef.current) editorRef.current.innerHTML = '';
		setInputText('');
		setDraftsMap(d => { const n = { ...d }; delete n[activeSessionId || 'default']; return n; });
		setSharedFiles([]);
		setImages([]);
		editorRef.current?.focus();
	}, [extractEditorContent, activeSessionId, images]);

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

	const getTextBeforeCursor = useCallback((): string => {
		const sel = window.getSelection();
		if (!sel || !sel.rangeCount || !editorRef.current) return '';
		const range = sel.getRangeAt(0);
		const preRange = document.createRange();
		preRange.setStart(editorRef.current, 0);
		preRange.setEnd(range.startContainer, range.startOffset);
		const frag = preRange.cloneContents();
		const div = document.createElement('div');
		div.appendChild(frag);
		return div.textContent || '';
	}, []);

	const handleEditorInput = useCallback(() => {
		const editor = editorRef.current;
		if (!editor) return;
		const plainText = editor.textContent || '';
		setInputText(plainText);

		const beforeCursor = getTextBeforeCursor();
		const lastSlash = beforeCursor.lastIndexOf('/');
		const lastAt = beforeCursor.lastIndexOf('@');

		const isSlashTrigger = lastSlash >= 0
			&& (lastSlash === 0 || /\s/.test(beforeCursor[lastSlash - 1]))
			&& !beforeCursor.slice(lastSlash + 1).includes(' ');
		const isAtTrigger = lastAt >= 0
			&& (lastAt === 0 || /\s/.test(beforeCursor[lastAt - 1]))
			&& !beforeCursor.slice(lastAt + 1).includes(' ');

		if (isSlashTrigger) {
			vscode.postMessage({ type: 'requestSkills' });
		} else if (isAtTrigger) {
			vscode.postMessage({ type: 'requestHistory' });
			vscode.postMessage({ type: 'requestOpenFiles' });
		} else {
			setAcMode(null);
			setAcItems([]);
		}
		setAcIndex(0);
	}, [getTextBeforeCursor]);

	const acQuery = useMemo(() => {
		const trigger = acMode === 'skill' ? '/' : acMode === 'history' ? '@' : null;
		if (!trigger) return '';
		const beforeCursor = getTextBeforeCursor();
		const lastIdx = beforeCursor.lastIndexOf(trigger);
		if (lastIdx < 0) return '';
		const after = beforeCursor.slice(lastIdx + 1);
		return after.includes(' ') ? '' : after.toLowerCase();
	}, [acMode, inputText, getTextBeforeCursor]);

	const filteredAcItems = useMemo(() => {
		if (!acMode || acItems.length === 0) return [];
		if (acMode === 'skill') {
			if (!acQuery) return acItems;
			return acItems.filter(i => i.label.toLowerCase().includes(acQuery));
		}
		if (acMode === 'history') {
			if (!acQuery) return acItems;
			return acItems.filter(i => i.label.toLowerCase().includes(acQuery) || (i.desc || '').toLowerCase().includes(acQuery));
		}
		return acItems;
	}, [acMode, acItems, acQuery]);

	const insertChipAtCursor = useCallback((chipPath: string, chipName: string, chipType: 'skill' | 'file' | 'chat') => {
		const editor = editorRef.current;
		if (!editor) return;
		const sel = window.getSelection();
		if (!sel || !sel.rangeCount) return;

		const range = sel.getRangeAt(0);
		const trigger = chipType === 'skill' ? '/' : '@';
		const beforeText = getTextBeforeCursor();
		const triggerIdx = beforeText.lastIndexOf(trigger);
		if (triggerIdx < 0) return;

		const charsToDelete = beforeText.length - triggerIdx;
		for (let i = 0; i < charsToDelete; i++) {
			const r = sel.getRangeAt(0);
			r.setStart(r.startContainer, Math.max(0, r.startOffset - 1));
			r.deleteContents();
		}

		const chip = document.createElement('span');
		chip.contentEditable = 'false';
		chip.dataset.chipPath = chipPath;
		chip.dataset.chipName = chipName;
		const colorClass = chipType === 'skill' ? 'chip-skill' : chipType === 'chat' ? 'chip-chat' : 'chip-file';
		chip.className = `inline-chip ${colorClass}`;
		const icon = chipType === 'skill' ? '⚡' : chipType === 'chat' ? '💬' : '📄';
		chip.textContent = `${icon} ${chipName}`;

		const newRange = sel.getRangeAt(0);
		newRange.insertNode(chip);

		const space = document.createTextNode('\u00A0');
		chip.after(space);
		const afterRange = document.createRange();
		afterRange.setStartAfter(space);
		afterRange.collapse(true);
		sel.removeAllRanges();
		sel.addRange(afterRange);

		setInputText(editor.textContent || '');
	}, [getTextBeforeCursor]);

	const selectAcItem = useCallback((item: { id: string; label: string }) => {
		let chipPath = '';
		let chipName = '';
		let chipType: 'skill' | 'file' | 'chat' = 'file';

		if (acMode === 'skill') {
			chipPath = `@skill:${item.label}`;
			chipName = item.label;
			chipType = 'skill';
		} else if (item.id.startsWith('file:')) {
			chipPath = item.id.slice(5);
			chipName = item.label;
			chipType = 'file';
		} else if (item.id.startsWith('recent:')) {
			chipPath = item.id.slice(7);
			chipName = item.label;
			chipType = 'file';
		} else if (acMode === 'history') {
			chipPath = `@history:${item.id}`;
			chipName = item.label;
			chipType = 'chat';
		}

		insertChipAtCursor(chipPath, chipName, chipType);
		setAcMode(null);
		setAcItems([]);
		setTimeout(() => editorRef.current?.focus(), 50);
	}, [acMode, insertChipAtCursor]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
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
		vscode.postMessage({ type: 'reconnect', sessionId: activeSessionId || 'default' });
	}, [activeSessionId]);

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

	const handleMicToggle = useCallback(() => {
		if (isTranscribing) return;
		if (isRecording) {
			vscode.postMessage({ type: 'stopRecording' });
		} else {
			vscode.postMessage({ type: 'startRecording' });
		}
	}, [isRecording, isTranscribing]);

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
			<button className="btn-small" onClick={handleCopyRule} data-tooltip="复制通信规则到剪贴板" data-tooltip-pos="below">
				规则
			</button>
			<button
				className={`btn-small ${keepAlive ? 'btn-active' : ''}`}
				onClick={() => { setKeepAlive(prev => !prev); lastUserActivityRef.current = Date.now(); }}
				data-tooltip={keepAlive ? '保活已开启' : '开启保活'}
				data-tooltip-pos="below"
			>
				{keepAlive ? '♥' : '♡'}
			</button>
			<button className="btn-small btn-accent" onClick={handleReconnect} data-tooltip="重连 Composer" data-tooltip-pos="below">
				重连
			</button>
				{totalPending > 0 && (
					<span className="badge" data-tooltip={`${totalPending} 条待处理`} data-tooltip-pos="below">{totalPending}</span>
				)}
				<div className="settings-wrapper" ref={settingsRef}>
					<button
						className="btn-small btn-icon"
						onClick={() => setSettingsOpen(prev => !prev)}
						data-tooltip="设置"
						data-tooltip-pos="below"
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
		{currentLogs.length < (totalCountMap[activeSessionId] || 0) && (
				<div className="load-more-hint" onClick={() => {
					if (!loadingMoreRef.current) {
						loadingMoreRef.current = true;
						vscode.postMessage({ type: 'loadMoreLogs', sessionId: activeSessionId, currentCount: currentLogs.length });
					}
				}}>
					↑ 加载更多历史消息 ({(totalCountMap[activeSessionId] || 0) - currentLogs.length} 条)
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
			{undeliveredSessions.has(activeSessionId) && currentPending.length > 0 && (
				<div className="delivery-warning">
					<span>AI 可能已断开连接，消息未被消费</span>
					<button className="btn-small btn-accent" onClick={() => {
						vscode.postMessage({ type: 'reconnect', sessionId: activeSessionId });
						setUndeliveredSessions(prev => { const n = new Set(prev); n.delete(activeSessionId); return n; });
					}}>重连</button>
				</div>
			)}
			{currentPending.length > 0 && (
				<div className="pending-section">
					<div className="pending-label">待处理 ({currentPending.length})</div>
						{currentPending.map(item => (
							<div key={item.id} className={`message message-pending${item.urgent ? ' message-urgent' : ''}`}>
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
										<div className="message-text">
											{item.urgent && <span className="urgent-badge">urgent</span>}
											{item.content}
										</div>
										<div className="pending-actions">
											<button
												className={`pending-action-btn pending-action-send${item.urgent ? ' active' : ''}`}
												onClick={() => handleResendPending(item.id)}
												title={item.urgent ? '已标记为优先' : '立即发送'}
											>
												{item.urgent ? '⚡' : '▶'}
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
				{agentStatusMap[activeSessionId]?.status === 'processing' && (
					<div className="agent-processing">
						<span className="agent-processing-dot" />
						<span>Agent 正在处理中...</span>
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

			{/* Image Preview */}
			{images.length > 0 && (
				<div className="image-preview-bar">
					{images.map((img, i) => (
						<div key={i} className="image-preview-item">
							<img src={img.dataUrl} alt={img.name} className="image-preview-thumb" />
							<button className="image-preview-remove" onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}>×</button>
						</div>
					))}
				</div>
			)}

			{/* Recording / Speaking Indicator */}
			{(isRecording || isTranscribing || isSpeaking) && (
				<div className={`recording-bar${isTranscribing ? ' transcribing' : ''}${isSpeaking ? ' speaking' : ''}`}>
					<span className="recording-bar-dot" />
					<span>{isSpeaking ? '播报中...' : isTranscribing ? '识别中...' : `录音中 ${Math.floor(recordingDuration / 60).toString().padStart(2, '0')}:${(recordingDuration % 60).toString().padStart(2, '0')}`}{voiceMode ? ' · 语音模式' : ''}</span>
					{isRecording && (
						<button className="recording-bar-stop" onClick={handleMicToggle}>停止</button>
					)}
					{isSpeaking && (
						<button className="recording-bar-stop" onClick={() => vscode.postMessage({ type: 'stopSpeaking' })}>停止播报</button>
					)}
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
				<div className="input-wrapper">
				{acMode && filteredAcItems.length > 0 && (
					<div className="ac-popup">
						{acMode === 'skill' && <div className="ac-title">Skills</div>}
						{acMode === 'history' && (() => {
							const files = filteredAcItems.filter((i: any) => i.id.startsWith('file:'));
							const recent = filteredAcItems.filter((i: any) => i.id.startsWith('recent:'));
							const chats = filteredAcItems.filter((i: any) => !i.id.startsWith('file:') && !i.id.startsWith('recent:'));
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
								{recent.length > 0 && <>
									<div className="ac-title">Recent Files</div>
									{recent.map(item => {
										globalIdx++;
										const idx = globalIdx;
										return <div key={item.id} className={`ac-item${idx === acIndex ? ' active' : ''}`}
											onMouseDown={e => { e.preventDefault(); selectAcItem(item); }}
											onMouseEnter={() => setAcIndex(idx)}>
											<span className="ac-icon">🕐</span>
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
					<div
						ref={editorRef}
						className="input-editor"
						contentEditable
						onInput={handleEditorInput}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						data-placeholder="输入消息... (Enter 发送, / Skills, @ History)"
						role="textbox"
						aria-multiline="true"
					/>
					<div className="input-bottom-bar">
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
								title="附加文件"
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
							<button
								className={`btn-toolbar btn-mic${isRecording ? ' recording' : ''}${isTranscribing ? ' transcribing' : ''}`}
								onClick={handleMicToggle}
								title={isTranscribing ? '识别中...' : isRecording ? '点击停止录音' : '语音输入'}
								disabled={isTranscribing}
							>
								{isTranscribing ? '⏳' : '🎤'}
							</button>
							<button
								className={`btn-toolbar btn-voice-mode${voiceMode ? ' active' : ''}`}
								onClick={() => {
									const next = !voiceMode;
									setVoiceMode(next);
									voiceModeRef.current = next;
									if (!next) {
										lastSpokenTextRef.current = '';
										if (isSpeaking) vscode.postMessage({ type: 'stopSpeaking' });
									}
								}}
								title={voiceMode ? '关闭语音模式（自动发送+播报）' : '开启语音模式（自动发送+播报）'}
							>
								{voiceMode ? '🔊' : '🔇'}
							</button>
						</div>
						<button
							className="btn-send"
							onClick={handleSend}
							disabled={!inputText.trim() && images.length === 0}
							title="发送 (Enter)"
						>
							↑
						</button>
					</div>
				</div>
			</div>
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
