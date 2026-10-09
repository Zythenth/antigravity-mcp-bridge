import { App, PostMessageTransport, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps';

// Types corresponding to the backend contract
export interface PanelTask {
  taskId: string;
  label: string;
  status: 'queued' | 'starting' | 'running' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'timeout' | string;
  model: string | null;
  mode: 'write' | 'read-only';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  parentTaskId?: string;
  continuationTaskId?: string;
  deliveryMode: 'messages' | 'events';
  tokenUsage?: {
    available?: boolean;
    partial?: boolean;
    counters?: {
      totalTokens?: number | null;
    };
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface StepUpdateData {
  step_index?: number;
  step_type?: string;
  state?: 'running' | 'completed' | 'failed' | string;
  text_delta?: string;
}

export interface PanelEvent {
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
}

export interface PanelResponseChunk {
  text: string;
  offset: number;
  totalLength: number;
  nextOffset: number;
  hasMore: boolean;
  contentSha256?: string;
}

export interface PanelCapabilities {
  messaging: boolean;
  cancel?: boolean;
  undo?: boolean;
  preview?: boolean;
  deliveryMode: boolean;
  maxConcurrentTasks: number;
}

export interface PanelStateResult {
  tasks: PanelTask[];
  selectedTask: PanelTask | null;
  events: PanelEvent[];
  nextCursor?: number;
  oldestAvailable?: number;
  truncated?: boolean;
  response: PanelResponseChunk | null;
  capabilities: PanelCapabilities;
  callerMessages?: Array<{messageId: string; text: string; receivedAt: string; receipt: {state: string; error?: {code: string; message: string}}}>;
}

export interface SendMessageResult {
  receipt?: {
    messageId: string;
    taskId: string;
    state: 'queued' | 'sent' | 'failed' | 'cancelled';
    continuationTaskId?: string;
  };
}

// UI State Store
class PanelStore {
  tasks: PanelTask[] = [];
  callerMessages: NonNullable<PanelStateResult['callerMessages']> = [];
  changedFiles: Array<{status: string; path: string; insertions: number | null; deletions: number | null; binary: boolean}> = [];
  patchSha256: string | null = null;
  previewForTask: string | null = null;
  previewBusy: boolean = false;
  selectedTaskId: string | null = null;
  selectedFilter: 'active' | 'done' = 'active';

  // Task generation counter to guard asynchronous fetch races
  taskGeneration: number = 0;
  lastLiveSequence: number = 0;

  // Events & streaming
  events: PanelEvent[] = [];
  historyEvents: PanelEvent[] | null = null;
  historyNextCursor: number = 0;
  historyBusy: boolean = false;
  nextCursor: number | undefined = undefined;
  oldestAvailable: number | undefined = undefined;
  stickyTruncated: boolean = false;

  // Live public response streaming state: step_index -> { completed: boolean, text: string }
  liveStepResponses: Map<number, { completed: boolean; text: string }> = new Map();

  // Paginated backend final response
  backendResponseText: string = '';
  responseOffset: number = 0;
  responseTotalLength: number = 0;
  responseHasMore: boolean = false;
  responseSha256: string | undefined = undefined;

  // Capabilities & Host
  capabilities: PanelCapabilities = {
    messaging: false,
    deliveryMode: false,
    maxConcurrentTasks: 1
  };
  hasHostMessaging: boolean = false;
  hasServerTools: boolean = false;
  isConnected: boolean = false;
  isPolling: boolean = false;
  pollTimer: ReturnType<typeof setTimeout> | null = null;
  visibilityPaused: boolean = false;

  // Draft retention per task: taskId -> draft text
  composerDrafts: Map<string, string> = new Map();

  // Composer in-flight status: taskId -> messageId
  inFlightMessageId: Map<string, string> = new Map();
  inFlightText: Map<string, string> = new Map();
  isSubmittingMessage: boolean = false;
  followContinuations: Set<string> = new Set();
}

const store = new PanelStore();
let app: App | null = null;
let transport: PostMessageTransport | null = null;
let disposed = false;

// Async task fetch serializer
let currentFetchPromise: Promise<void> = Promise.resolve();

function serializeFetch<T>(fn: () => Promise<T>): Promise<T> {
  let result: T;
  const next = currentFetchPromise.then(async () => {
    result = await fn();
  });
  currentFetchPromise = next.catch(() => {});
  return next.then(() => result);
}

// DOM Elements cache helper
function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing expected DOM element: #${id}`);
  return el as T;
}

// Deterministic geometric avatar generator for task IDs


interface NativeAvatars { source: string; pairs: Array<{dark: string; light: string}>; icons?: Record<string,string> }
let cachedNativeAvatars: NativeAvatars | undefined;
function nativeAvatar(taskId: string): HTMLElement {
  const element = document.createElement('img'); element.width = 24; element.height = 24; element.alt = ''; element.draggable = false; element.setAttribute('aria-hidden', 'true');
  if (!cachedNativeAvatars) {
    try { cachedNativeAvatars = JSON.parse(document.getElementById('native-avatar-resources')?.textContent ?? '{}') as NativeAvatars; } catch { cachedNativeAvatars = {source: 'unavailable', pairs: []}; }
  }
  const resources = cachedNativeAvatars;
  if (!Array.isArray(resources.pairs) || !resources.pairs.length) {
    const placeholder = document.createElement('span'); placeholder.className = 'native-avatar-placeholder'; placeholder.setAttribute('aria-hidden', 'true'); return placeholder;
  }
  let hash = 0; for (const letter of taskId) hash = (hash * 31 + letter.charCodeAt(0)) % 2147483647;
  const pair = resources.pairs[hash % resources.pairs.length]!;
  const dark = document.documentElement.dataset.theme !== 'light';
  const source = dark ? pair.dark : pair.light;
  if (/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(source)) element.src = source;
  return element;
}

function nativeControl(name: string, fallback: string): HTMLElement {
  const icon = document.createElement('span'); icon.className = 'native-control-icon'; icon.setAttribute('aria-hidden','true');
  const source = cachedNativeAvatars?.icons?.[name];
  if (source && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(source)) { icon.style.maskImage = 'url(' + source + ')'; icon.style.webkitMaskImage = 'url(' + source + ')'; }
  else { icon.textContent = fallback; icon.classList.add('is-fallback'); }
  return icon;
}

function formatActiveElapsed(createdAt: string, startedAt?: string): string {
  const refTime = startedAt ? new Date(startedAt).getTime() : new Date(createdAt).getTime();
  if (isNaN(refTime)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - refTime) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  return `${diffHours} h`;
}

function formatCompletedElapsed(completedAt?: string, fallbackCreatedAt?: string): string {
  const ts = completedAt ? new Date(completedAt).getTime() : (fallbackCreatedAt ? new Date(fallbackCreatedAt).getTime() : NaN);
  if (isNaN(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'há menos de 1 min';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `há ${diffHours} h`;
  const diffDays = Math.floor(diffHours / 24);
  return `há ${diffDays} d`;
}

// Truthful status line text for active and completed tasks
function getTaskStatusLine(task: PanelTask): { text: string; isProcessing: boolean } {
  switch (task.status) {
    case 'running':
    case 'streaming':
      return { text: 'Processando', isProcessing: true };
    case 'starting':
      return { text: 'Iniciando...', isProcessing: true };
    case 'queued':
      return { text: 'Na fila', isProcessing: false };
    case 'completed':
      return { text: 'Finalizada (saída não verificada)', isProcessing: false };
    case 'failed':
      return { text: task.error ? `Falha: ${task.error.message}` : 'Falha', isProcessing: false };
    case 'cancelled':
      return { text: 'Cancelada', isProcessing: false };
    case 'timeout':
      return { text: 'Tempo limite excedido', isProcessing: false };
    default:
      return { text: task.status, isProcessing: false };
  }
}

// Safe Markdown DOM renderer (paragraphs, inline code, fenced code blocks)
// Strictly DOM nodes creation, NO innerHTML
function renderSafeMarkdown(container: HTMLElement, text: string): void {
  container.replaceChildren();
  if (!text) return;

  const lines = text.split(/\r?\n/);
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let currentParagraphLines: string[] = [];

  const flushParagraph = () => {
    if (currentParagraphLines.length === 0) return;
    const p = document.createElement('p');
    const joinedText = currentParagraphLines.join('\n');
    appendInlineContent(p, joinedText);
    container.appendChild(p);
    currentParagraphLines = [];
  };

  const flushCodeBlock = () => {
    const pre = document.createElement('pre');
    pre.className = 'markdown-code-block';
    const code = document.createElement('code');
    code.textContent = codeBlockLines.join('\n');
    pre.appendChild(code);
    const block = document.createElement('div'); block.className = 'technical-output';
    const header = document.createElement('div'); header.className = 'technical-output-header';
    const label = document.createElement('span'); label.append(nativeControl('code','‹›'),document.createTextNode('Texto simples'));
    const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'technical-output-action'; expand.replaceChildren(nativeControl('expand','↗')); expand.setAttribute('aria-label','Expandir saída');
    expand.onclick = () => { block.classList.toggle('is-expanded'); expand.setAttribute('aria-expanded',String(block.classList.contains('is-expanded'))); };
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'technical-output-action'; copy.replaceChildren(nativeControl('copy','⧉')); copy.setAttribute('aria-label','Copiar saída');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(code.textContent ?? ''); copy.setAttribute('aria-label','Saída copiada'); setComposerFeedback('Saída copiada.'); } catch { setComposerFeedback('A cópia não está disponível neste host.'); } };
    header.append(label,expand,copy); block.append(header,pre); container.appendChild(block);
    codeBlockLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        flushParagraph();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
    } else {
      currentParagraphLines.push(line);
    }
  }

  if (inCodeBlock) {
    flushCodeBlock();
  } else {
    flushParagraph();
  }
}

function appendInlineContent(element: HTMLElement, text: string): void {
  const parts = text.split(/(`[^`]+`)/g);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      const codeSpan = document.createElement('code');
      codeSpan.className = 'markdown-inline-code';
      codeSpan.textContent = part.slice(1, -1);
      element.appendChild(codeSpan);
    } else {
      element.appendChild(document.createTextNode(part));
    }
  }
}

// Initialization
async function init(): Promise<void> {
  const rootEl = getEl<HTMLDivElement>('app');
  const btnBack = getEl<HTMLButtonElement>('btn-back');
  const tabActive = document.getElementById('tab-active');
  const tabDone = document.getElementById('tab-done');
  const btnRetryBanner = getEl<HTMLButtonElement>('btn-retry-banner');
  const btnCancelTask = getEl<HTMLButtonElement>('btn-cancel-task');
  const selectDeliveryMode = getEl<HTMLSelectElement>('select-delivery-mode');
  const btnShareCodex = getEl<HTMLButtonElement>('btn-share-codex');
  const btnLoadMoreResponse = getEl<HTMLButtonElement>('btn-load-more-response');
  const btnLoadOlderEvents = getEl<HTMLButtonElement>('btn-load-older-events');
  const btnLiveEvents = getEl<HTMLButtonElement>('btn-live-events');
  const composerForm = getEl<HTMLFormElement>('composer-form');
  const composerInput = getEl<HTMLTextAreaElement>('composer-input');

  // Back button returns to task list view at every screen width
  btnBack.addEventListener('click', () => {
    rootEl.classList.remove('in-detail-view');
    rootEl.classList.add('in-tasks-view');
    btnBack.hidden = true;
    getEl<HTMLSpanElement>('detail-header-avatar').hidden = true;
    getEl<HTMLSpanElement>('detail-header-model').hidden = true;
    getEl<HTMLSpanElement>('panel-title').textContent = 'Antigravity';
  });

  // Preserve event wiring if tabs exist
  if (tabActive) {
    tabActive.addEventListener('click', () => {
      store.selectedFilter = 'active';
      renderTaskList();
    });
  }

  if (tabDone) {
    tabDone.addEventListener('click', () => {
      store.selectedFilter = 'done';
      renderTaskList();
    });
  }

  btnRetryBanner.addEventListener('click', async () => {
    hideGlobalBanner();
    if (!store.isConnected) {
      await setupSdkApp();
    } else {
      triggerPollImmediate();
    }
  });

  btnCancelTask.addEventListener('click', async () => {
    if (!store.selectedTaskId || !store.hasServerTools) return;
    btnCancelTask.disabled = true;
    setComposerFeedback('Solicitando cancelamento...');
    try {
      await callServerTool('antigravity_cancel', { taskId: store.selectedTaskId });
      setComposerFeedback('Cancelamento solicitado.');
      triggerPollImmediate();
    } catch (err: unknown) {
      setComposerFeedback(`Erro ao cancelar: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      updateControlStates();
    }
  });

  selectDeliveryMode.addEventListener('change', async () => {
    if (!store.selectedTaskId || !store.hasServerTools) return;
    const mode = selectDeliveryMode.value as 'messages' | 'events';
    try {
      await callServerTool('antigravity_set_delivery_mode', {
        taskId: store.selectedTaskId,
        deliveryMode: mode
      });
      triggerPollImmediate();
    } catch (err: unknown) {
      showGlobalBanner(`Erro ao alterar modo de entrega: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  btnShareCodex.addEventListener('click', async () => {
    const task = getCurrentSelectedTask();
    if (!task) return;
    if (!app || !store.hasHostMessaging) {
      showGlobalBanner('O host não suporta envio de mensagens ou está desconectado.');
      return;
    }

    const publicResp = getEffectivePublicResponse();
    const summaryLines = [
      `[Antigravity Resumo de Tarefa - Saída não verificada]`,
      `ID da Tarefa: ${task.taskId}`,
      `Título: ${task.label}`,
      `Status: ${task.status}`,
      `Modelo: ${task.model ?? 'Não informado'}`,
      `Tokens: ${task.tokenUsage?.counters?.totalTokens ?? 'Não informado'}`,
      `Referência: antigravity_read_result({taskId: "${task.taskId}"})`,
      `Trecho da Resposta:`,
      publicResp.slice(0, 1400)
    ];

    let fullText = summaryLines.join('\n');
    if (fullText.length > 2000) {
      fullText = fullText.slice(0, 1997) + '...';
    }

    btnShareCodex.disabled = true;
    try {
      const sent = await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: fullText }]
      });
      if (sent.isError) throw new Error('O host recusou o resumo.');
      setComposerFeedback('Resumo enviado ao Codex.');
    } catch (err: unknown) {
      showGlobalBanner(`Falha ao enviar resumo ao Codex: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      updateControlStates();
    }
  });

  btnLoadMoreResponse.addEventListener('click', async () => {
    if (!store.selectedTaskId || !store.responseHasMore || !store.hasServerTools) return;
    const targetTaskId = store.selectedTaskId;
    const expectedGeneration = store.taskGeneration;
    btnLoadMoreResponse.disabled = true;
    try {
      await serializeFetch(async () => {
        const state = await callServerTool<PanelStateResult>('antigravity_panel_state', {
          taskId: targetTaskId,
          responseOffset: store.responseOffset,
          expectedResponseSha256: store.responseSha256
        });
        if (state && store.selectedTaskId === targetTaskId && store.taskGeneration === expectedGeneration) {
          applyResponseChunk(state.response);
          renderSelectedTaskDetail();
        }
      });
    } catch (err: unknown) {
      showGlobalBanner(`Erro ao carregar mais dados da resposta: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      btnLoadMoreResponse.disabled = !store.responseHasMore;
    }
  });

  btnLiveEvents.addEventListener('click', () => {
    store.historyEvents = null;
    renderSelectedTaskDetail();
    updateControlStates();
  });

  btnLoadOlderEvents.addEventListener('click', async () => {
    if (!store.selectedTaskId || !store.hasServerTools || store.historyBusy) return;
    const targetTaskId = store.selectedTaskId;
    const generation = store.taskGeneration;
    const after = store.historyEvents ? store.historyNextCursor : Math.max(0, (store.oldestAvailable ?? 1) - 1);
    store.historyBusy = true;
    updateControlStates();
    try {
      await serializeFetch(async () => {
        const state = await callServerTool<PanelStateResult>('antigravity_panel_state', {
          taskId: targetTaskId, after, limit: 200, includeResponse: false
        });
        if (store.selectedTaskId !== targetTaskId || store.taskGeneration !== generation) return;
        store.historyEvents = state.events ?? [];
        store.historyNextCursor = state.nextCursor ?? after;
        if (state.truncated) store.stickyTruncated = true;
        renderSelectedTaskDetail();
      });
    } catch (err: unknown) {
      showGlobalBanner(`Erro ao carregar histórico: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store.historyBusy = false;
      updateControlStates();
    }
  });

  // Composer keyboard handling
  composerInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composerForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  });

  // Preserve draft on typing
  composerInput.addEventListener('input', () => {
    if (store.selectedTaskId) {
      store.composerDrafts.set(store.selectedTaskId, composerInput.value);
    }
  });

  composerForm.addEventListener('submit', async (e: Event) => {
    e.preventDefault();
    if (store.isSubmittingMessage) return;
    const targetTaskId = store.selectedTaskId;
    if (!targetTaskId) return;

    let text = composerInput.value.trim();
    if (!text) return;

    if (!store.capabilities.messaging || !store.hasServerTools) {
      setComposerFeedback('Envio de mensagens desabilitado para este backend.');
      return;
    }

    let messageId = store.inFlightMessageId.get(targetTaskId);
    if (messageId) text = store.inFlightText.get(targetTaskId) ?? text;
    if (!messageId) {
      messageId = crypto.randomUUID();
      store.inFlightMessageId.set(targetTaskId, messageId);
      store.inFlightText.set(targetTaskId, text);
    }

    store.isSubmittingMessage = true;
    const btnSend = getEl<HTMLButtonElement>('btn-send-message');
    btnSend.disabled = true;
    composerInput.disabled = true;
    setComposerFeedback('Enviando...');

    try {
      const result = await callServerTool<SendMessageResult>('antigravity_send_message', {
        taskId: targetTaskId,
        messageId,
        text
      });

      const receipt = result?.receipt;
      if (!receipt) {
        throw new Error('Servidor não retornou recibo de mensagem.');
      }

      const receiptState = receipt.state;
      setComposerFeedback(`Recibo: ${receiptState}`);

      if (receiptState === 'queued' || receiptState === 'sent') {
        if (receiptState === 'queued') store.followContinuations.add(targetTaskId);
        store.inFlightMessageId.delete(targetTaskId);
        store.inFlightText.delete(targetTaskId);
        if (store.composerDrafts.get(targetTaskId)?.trim() === text) store.composerDrafts.delete(targetTaskId);

        if (store.selectedTaskId === targetTaskId && composerInput.value.trim() === text) {
          composerInput.value = '';
        }

        if (store.selectedTaskId === targetTaskId && receipt.continuationTaskId && receipt.continuationTaskId !== targetTaskId) {
          selectTaskById(receipt.continuationTaskId);
        } else {
          triggerPollImmediate();
        }
      } else {
        store.inFlightMessageId.delete(targetTaskId);
        store.inFlightText.delete(targetTaskId);
        setComposerFeedback(`Envio não concluído (${receiptState}). Rascunho mantido.`);
      }
    } catch (err: unknown) {
      setComposerFeedback(`Falha no envio: ${err instanceof Error ? err.message : String(err)}. Rascunho mantido.`);
    } finally {
      store.isSubmittingMessage = false;
      updateControlStates();
      if (store.selectedTaskId === targetTaskId) {
        composerInput.focus();
      }
    }
  });

  // Visibility change handling for polling pause
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      store.visibilityPaused = true;
      if (store.pollTimer) clearTimeout(store.pollTimer);
    } else {
      store.visibilityPaused = false;
      triggerPollImmediate();
    }
  });

  // Teardown cleanup
  window.addEventListener('beforeunload', () => {
    if (store.pollTimer) clearTimeout(store.pollTimer);
    if (app) {
      disposed = true;
      store.isConnected = false;
      void transport?.close();
    }
  });

  // Connect SDK
  await setupSdkApp();
}

async function setupSdkApp(): Promise<void> {
  const hostStatusEl = getEl<HTMLSpanElement>('host-status');

  try {
    if (disposed) return;
    await transport?.close();
    transport = new PostMessageTransport(window.parent, window.parent);
    app = new App({ name: 'Antigravity', version: '0.7.0' }, {});

    app.ontoolinput = (params) => {
      const args = (params as { arguments?: { taskId?: string; state?: string } })?.arguments;
      if (args?.taskId) {
        selectTaskById(args.taskId);
      }
      return args;
    };

    app.ontoolresult = (params) => {
      const sc = (params as { structuredContent?: unknown })?.structuredContent;
      if (sc && typeof sc === 'object' && 'tasks' in sc) {
        applyStateResult(sc as PanelStateResult);
      }
      return sc;
    };

    app.onhostcontextchanged = (ctx) => {
      if (ctx?.theme) {
        applyDocumentTheme(ctx.theme);
      }
      if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
      if (ctx?.styles?.variables) {
        applyHostStyleVariables(ctx.styles.variables);
      }
    };

    app.onteardown = async () => {
      disposed = true;
      store.isConnected = false;
      store.taskGeneration++;
      if (store.pollTimer) clearTimeout(store.pollTimer);
      updateControlStates();
      return {};
    };

    await app.connect(transport, { timeout: 15000 });
    store.isConnected = true;

    const hostCaps = app.getHostCapabilities();
    store.hasHostMessaging = Boolean(hostCaps?.message?.text);
    store.hasServerTools = Boolean(hostCaps?.serverTools);

    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);

    hostStatusEl.textContent = 'Conectado';
    hostStatusEl.className = 'status-badge is-online';
    hideGlobalBanner();

    updateControlStates();
    scheduleNextPoll(0);
  } catch (err: unknown) {
    store.isConnected = false;
    store.hasServerTools = false;
    store.hasHostMessaging = false;
    hostStatusEl.textContent = 'Desconectado';
    hostStatusEl.className = 'status-badge is-offline';
    updateControlStates();
    showGlobalBanner(`Falha ao conectar com o MCP App Host: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function callServerTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!app) throw new Error('SDK App não inicializado');
  if (!store.hasServerTools) throw new Error('Host não possui capacidade serverTools.');

  const res = await app.callServerTool({ name, arguments: args }, { timeout: 30000 });
  if (res.isError) {
    let msg = 'Erro retornado pela ferramenta do servidor';
    if (res.content && Array.isArray(res.content)) {
      const textItem = res.content.find((c: { type?: string; text?: string }) => c.type === 'text');
      if (textItem && 'text' in textItem) msg = String(textItem.text);
    }
    throw new Error(msg);
  }

  if (res.structuredContent !== undefined) {
    return res.structuredContent as T;
  }

  if (res.content && Array.isArray(res.content)) {
    const textItem = res.content.find((c: { type?: string; text?: string }) => c.type === 'text');
    if (textItem && 'text' in textItem && typeof textItem.text === 'string') {
      try {
        return JSON.parse(textItem.text) as T;
      } catch {
        return textItem.text as unknown as T;
      }
    }
  }

  return {} as T;
}

function triggerPollImmediate(): void {
  if (store.pollTimer) clearTimeout(store.pollTimer);
  scheduleNextPoll(0);
}

function scheduleNextPoll(delayMs: number): void {
  if (disposed || store.visibilityPaused || !store.isConnected || !store.hasServerTools) return;
  store.pollTimer = setTimeout(async () => {
    if (store.isPolling) return;
    store.isPolling = true;
    let isLiveTask = false;

    const currentTaskId = store.selectedTaskId;
    const currentGeneration = store.taskGeneration;

    try {
      await serializeFetch(async () => {
        const state = await callServerTool<PanelStateResult>('antigravity_panel_state', {
          taskId: currentTaskId ?? undefined,
          after: store.nextCursor,
          includeResponse: !store.responseSha256
        });

        if (state && (store.selectedTaskId === currentTaskId && store.taskGeneration === currentGeneration)) {
          applyStateResult(state);
        }
      });

      const task = getCurrentSelectedTask();
      if (task) {
        const liveStatuses = ['queued', 'starting', 'running', 'streaming'];
        isLiveTask = liveStatuses.includes(task.status);
      }
    } catch (err: unknown) {
      showGlobalBanner(`Erro de sincronização: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store.isPolling = false;
      const nextDelay = isLiveTask ? 1500 : 5000;
      scheduleNextPoll(nextDelay);
    }
  }, delayMs);
}

function applyStateResult(result: PanelStateResult): void {
  store.tasks = result.tasks || [];
  store.capabilities = result.capabilities || { messaging: false, deliveryMode: false, maxConcurrentTasks: 1 };

  if (result.selectedTask && !store.selectedTaskId) {
    store.selectedTaskId = result.selectedTask.taskId;
  }

  store.callerMessages = result.callerMessages ?? [];
  const continuation = result.selectedTask?.continuationTaskId;
  if (result.selectedTask?.taskId === store.selectedTaskId && continuation && store.followContinuations.has(result.selectedTask.taskId)) {
    store.followContinuations.delete(result.selectedTask!.taskId);
    selectTaskById(continuation);
    return;
  }

  if (result.events && result.events.length > 0) {
    mergeEvents(result.events);
  }

  if (result.nextCursor !== undefined) {
    store.nextCursor = result.nextCursor;
  }
  if (result.oldestAvailable !== undefined) {
    store.oldestAvailable = result.oldestAvailable;
  }
  if (result.truncated) {
    store.stickyTruncated = true;
  }

  if (result.response) {
    applyResponseChunk(result.response);
  }

  renderTaskList();
  renderSelectedTaskDetail();
  updateControlStates();
  void refreshChangedFiles();
}

function mergeEvents(incoming: PanelEvent[]): void {
  const existingMap = new Map<number, PanelEvent>();
  for (const evt of store.events) {
    existingMap.set(evt.sequence, evt);
  }

  for (const evt of incoming) {
    existingMap.set(evt.sequence, evt);
    if (evt.sequence > store.lastLiveSequence) {
      processEventForLiveResponse(evt);
      store.lastLiveSequence = evt.sequence;
    }
  }

  const sorted = Array.from(existingMap.values()).sort((a, b) => a.sequence - b.sequence);
  if (sorted.length > 200) store.stickyTruncated = true;
  store.events = sorted.slice(-200);
}

function processEventForLiveResponse(evt: PanelEvent): void {
  if (evt.type === 'response.chunk' || evt.type === 'step.update') {
    const data = evt.data as StepUpdateData | undefined;
    if (data && typeof data === 'object') {
      const stepIndex = data.step_index ?? 0;
      const isAgentResponse = !data.step_type || data.step_type === 'agent_response';

      if (isAgentResponse) {
        let entry = store.liveStepResponses.get(stepIndex);
        if (!entry) {
          entry = { completed: false, text: '' };
          store.liveStepResponses.set(stepIndex, entry);
        }

        if (data.state === 'DONE') {
          entry.completed = true;
          if (data.text_delta) {
            entry.text = data.text_delta;
          }
        } else if (data.text_delta) {
          entry.text += data.text_delta;
        }
      }
    }
  }
}

function applyResponseChunk(chunk: PanelResponseChunk | null): void {
  if (!chunk) return;
  if (chunk.offset === 0) {
    if (store.responseSha256 === chunk.contentSha256 && store.responseOffset > chunk.nextOffset) return;
    store.backendResponseText = chunk.text;
  } else {
    if (!store.responseSha256 || store.responseSha256 !== chunk.contentSha256 || chunk.offset !== store.responseOffset) {
      throw new Error('A resposta mudou ou a página não é contínua. Selecione a tarefa novamente para recarregar.');
    }
    store.backendResponseText += chunk.text;
  }
  store.responseOffset = chunk.nextOffset;
  store.responseTotalLength = chunk.totalLength;
  store.responseHasMore = chunk.hasMore;
  store.responseSha256 = chunk.contentSha256;
}

function getEffectivePublicResponse(): string {
  if (store.backendResponseText) {
    return store.backendResponseText;
  }

  if (store.liveStepResponses.size > 0) {
    const sortedSteps = Array.from(store.liveStepResponses.entries()).sort(([a], [b]) => a - b);
    return sortedSteps.map(([, v]) => v.text).join('\n\n');
  }

  return '';
}

function getCurrentSelectedTask(): PanelTask | null {
  if (!store.selectedTaskId) return null;
  return store.tasks.find((t) => t.taskId === store.selectedTaskId) ?? null;
}

function selectTaskById(taskId: string): void {
  const root = getEl<HTMLDivElement>('app');
  const btnBack = getEl<HTMLButtonElement>('btn-back');

  store.selectedTaskId = taskId;
  store.taskGeneration++;

  // Reset cursors and stream buffers
  store.events = [];
  store.callerMessages = [];
  store.changedFiles = []; store.patchSha256 = null; store.previewForTask = null;
  store.historyEvents = null;
  store.historyNextCursor = 0;
  store.nextCursor = undefined;
  store.lastLiveSequence = 0;
  store.oldestAvailable = undefined;
  store.stickyTruncated = false;
  store.liveStepResponses.clear();
  store.backendResponseText = '';
  store.responseOffset = 0;
  store.responseHasMore = false;
  store.responseSha256 = undefined;

  // Restore composer draft
  const input = getEl<HTMLTextAreaElement>('composer-input');
  input.value = store.composerDrafts.get(taskId) || '';

  // Switch to detail view
  root.classList.add('in-detail-view');
  root.classList.remove('in-tasks-view');
  btnBack.hidden = false;

  renderTaskList();
  renderSelectedTaskDetail();
  triggerPollImmediate();
}

function renderTaskList(): void {
  const loadingEl = getEl<HTMLDivElement>('tasks-loading');
  const emptyEl = getEl<HTMLDivElement>('tasks-empty');
  const listEl = getEl<HTMLDivElement>('task-list');

  loadingEl.hidden = true;

  if (store.tasks.length === 0) {
    emptyEl.hidden = false;
    listEl.replaceChildren();
    return;
  }
  emptyEl.hidden = true;

  const terminalStatuses = ['completed', 'failed', 'cancelled', 'timeout'];
  const activeTasks: PanelTask[] = [];
  const concludedTasks: PanelTask[] = [];

  const conversations = new Map<string, PanelTask[]>();
  for (const task of store.tasks) {
    const key = task.sessionId ?? task.taskId; const turns = conversations.get(key) ?? []; turns.push(task); conversations.set(key,turns);
  }
  for (const turns of conversations.values()) {
    turns.sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    const first = turns[0]!, latest = turns.at(-1)!;
    const task = {...latest,label:first.label};
    if (terminalStatuses.includes(task.status)) {
      concludedTasks.push(task);
    } else {
      activeTasks.push(task);
    }
  }

  const activeElId = document.activeElement instanceof HTMLElement ? document.activeElement.id : null;
  const fragment = document.createDocumentFragment();

  // Active Tasks Group
  if (activeTasks.length > 0) {
    const activeGroup = document.createElement('div');
    activeGroup.className = 'task-group';

    const groupHeader = document.createElement('div');
    groupHeader.className = 'task-group-header';
    groupHeader.textContent = `Ativo · ${activeTasks.length}`;
    activeGroup.appendChild(groupHeader);

    const itemsList = document.createElement('ul');
    itemsList.className = 'task-group-items';

    for (const task of activeTasks) {
      itemsList.appendChild(createTaskRowElement(task, true));
    }

    activeGroup.appendChild(itemsList);
    fragment.appendChild(activeGroup);
  }

  // Concluded Tasks Group
  if (concludedTasks.length > 0) {
    const concludedGroup = document.createElement('div');
    concludedGroup.className = 'task-group';

    const groupHeader = document.createElement('div');
    groupHeader.className = 'task-group-header';
    groupHeader.textContent = `Concluído · ${concludedTasks.length}`;
    concludedGroup.appendChild(groupHeader);

    const itemsList = document.createElement('ul');
    itemsList.className = 'task-group-items';

    for (const task of concludedTasks) {
      itemsList.appendChild(createTaskRowElement(task, false));
    }

    concludedGroup.appendChild(itemsList);
    fragment.appendChild(concludedGroup);
  }

  listEl.replaceChildren(fragment);

  if (activeElId) {
    const target = document.getElementById(activeElId);
    if (target) target.focus();
  }
}

function createTaskRowElement(task: PanelTask, isActive: boolean): HTMLElement {
  const li = document.createElement('li');
  li.id = `task-item-${task.taskId}`;
  li.className = `task-row ${isActive ? 'task-row-active' : 'task-row-completed'} ${task.taskId === store.selectedTaskId && getEl<HTMLDivElement>('app').classList.contains('in-detail-view') ? 'is-selected' : ''}`;
  li.setAttribute('role', 'button');
  li.setAttribute('tabindex', '0');
  li.setAttribute('aria-label', `${task.label || task.taskId}, ${task.status}`);

  // Avatar left
  const avatarSpan = document.createElement('span');
  avatarSpan.className = 'task-row-avatar';
  avatarSpan.replaceChildren(nativeAvatar(task.sessionId ?? task.taskId));

  // Content middle (starts at x67px)
  const contentDiv = document.createElement('div');
  contentDiv.className = 'task-row-content';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'task-row-title';
  titleDiv.textContent = task.label || task.taskId;
  contentDiv.appendChild(titleDiv);

  const statusLine = getTaskStatusLine(task);
  const statusDiv = document.createElement('div');
  statusDiv.className = `task-row-status-line ${statusLine.isProcessing ? 'is-processing' : ''}`;
  statusDiv.textContent = statusLine.text;
  if (task.status !== 'completed') contentDiv.appendChild(statusDiv);

  // Elapsed right
  const elapsedSpan = document.createElement('span');
  elapsedSpan.className = 'task-row-elapsed';
  if (isActive) {
    elapsedSpan.textContent = formatActiveElapsed(task.createdAt, task.startedAt);
  } else {
    elapsedSpan.textContent = formatCompletedElapsed(task.completedAt, task.createdAt);
  }

  li.appendChild(avatarSpan);
  li.appendChild(contentDiv);
  li.appendChild(elapsedSpan);

  li.addEventListener('click', () => {
    selectTaskById(task.taskId);
  });

  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectTaskById(task.taskId);
    }
  });

  return li;
}


async function refreshChangedFiles(): Promise<void> {
  const taskId = store.selectedTaskId;
  if (!taskId || !store.hasServerTools || !store.capabilities.preview || store.previewBusy || store.previewForTask === taskId) return;
  const generation = store.taskGeneration; store.previewBusy = true;
  try {
    const preview = await serializeFetch(() => callServerTool<{sha256: string; fileSummaries: typeof store.changedFiles}>('antigravity_preview',{taskId,includePatch:false}));
    if (store.selectedTaskId !== taskId || store.taskGeneration !== generation) return;
    store.patchSha256 = preview.sha256; store.changedFiles = preview.fileSummaries; store.previewForTask = taskId;
    renderSelectedTaskDetail();
  } catch (error) { if (store.selectedTaskId === taskId) setComposerFeedback('Não foi possível consultar as alterações: ' + String(error)); }
  finally { store.previewBusy = false; }
}

function renderChangedFiles(): void {
  const container = getEl<HTMLDivElement>('changed-files');
  if (container.dataset.rendered === store.selectedTaskId + ':' + store.patchSha256 + ':' + store.capabilities.undo) return;
  container.dataset.rendered = store.selectedTaskId + ':' + store.patchSha256 + ':' + store.capabilities.undo;
  container.replaceChildren();
  const taskId = store.selectedTaskId, sha256 = store.patchSha256, generation = store.taskGeneration;
  if (!taskId || !sha256) return;
  for (const file of store.changedFiles) {
    const card = document.createElement('div'); card.className = 'file-change-card';
    const icon = document.createElement('span'); icon.className = 'file-change-icon'; icon.replaceChildren(nativeControl('file','⊞')); icon.setAttribute('aria-hidden','true');
    const info = document.createElement('div'); info.className = 'file-change-info';
    const title = document.createElement('strong'); title.textContent = (file.status === 'A' ? 'Adicionado ' : file.status === 'D' ? 'Removido ' : 'Editado ') + file.path;
    const stats = document.createElement('div'); stats.className = 'file-change-stats';
    const added = document.createElement('span'); added.className = 'diff-added'; added.textContent = file.binary ? 'Binário' : '+' + file.insertions;
    const removed = document.createElement('span'); removed.className = 'diff-removed'; removed.textContent = file.binary ? '' : '−' + file.deletions;
    stats.append(added,removed); info.append(title,stats);
    const actions = document.createElement('div'); actions.className = 'file-change-actions';
    const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'button-secondary button-small'; undo.append(document.createTextNode('Desfazer'),nativeControl('undo','↶')); undo.disabled = !store.capabilities.undo;
    undo.onclick = async () => {
      undo.disabled = true;
      try {
        await callServerTool('antigravity_panel_undo',{taskId,expectedSha256:sha256,path:file.path});
        if (store.selectedTaskId === taskId && store.taskGeneration === generation) { store.previewForTask = null; store.patchSha256 = null; store.changedFiles = []; container.removeAttribute('data-rendered'); await refreshChangedFiles(); triggerPollImmediate(); }
      } catch (error) { if (store.selectedTaskId === taskId) { setComposerFeedback('Não foi possível desfazer: ' + String(error)); store.previewForTask = null; void refreshChangedFiles(); } }
      finally { undo.disabled = !store.capabilities.undo; }
    };
    const view = document.createElement('button'); view.type = 'button'; view.className = 'button-secondary button-small'; view.textContent = 'Visualizar alterações';
    view.onclick = async () => {
      view.disabled = true;
      try {
        let text = '', offset = 0;
        for (;;) {
          const page = await callServerTool<{text: string; nextOffset: number; hasMore: boolean}>('antigravity_read_patch',{taskId,expectedSha256:sha256,path:file.path,offset,limit:50000});
          if (store.selectedTaskId !== taskId || store.taskGeneration !== generation) return;
          text += page.text; if (!page.hasMore) break; offset = page.nextOffset;
        }
        const dialog = getEl<HTMLDialogElement>('patch-dialog'); getEl<HTMLPreElement>('patch-dialog-body').textContent = text; getEl<HTMLHeadingElement>('patch-dialog-title').textContent = file.path;
        dialog.showModal(); getEl<HTMLButtonElement>('patch-dialog-close').onclick = () => dialog.close();
      } catch (error) { if (store.selectedTaskId === taskId) setComposerFeedback('Não foi possível ler o diff: ' + String(error)); }
      finally { view.disabled = false; }
    };
    actions.append(undo,view); card.append(icon,info,actions); container.append(card);
  }
}

function renderSelectedTaskDetail(): void {
  const task = getCurrentSelectedTask();
  const noSelectedEl = getEl<HTMLDivElement>('no-task-selected');
  const contentEl = getEl<HTMLDivElement>('task-content');
  const detailAvatar = getEl<HTMLSpanElement>('detail-header-avatar');
  const detailTitle = getEl<HTMLSpanElement>('panel-title');
  const detailModel = getEl<HTMLSpanElement>('detail-header-model');
  const btnBack = getEl<HTMLButtonElement>('btn-back');

  if (!task) {
    noSelectedEl.hidden = false;
    contentEl.hidden = true;
    detailAvatar.hidden = true;
    detailModel.hidden = true;
    detailTitle.textContent = 'Antigravity';
    return;
  }

  noSelectedEl.hidden = true;
  contentEl.hidden = false;

  // The selected turn can continue polling while the user views the task list.
  const inDetailView = getEl<HTMLDivElement>('app').classList.contains('in-detail-view');
  detailAvatar.hidden = !inDetailView;
  detailAvatar.replaceChildren(nativeAvatar(task.sessionId ?? task.taskId));
  detailTitle.textContent = inDetailView ? task.label || task.taskId : 'Antigravity';
  detailModel.hidden = !inDetailView;
  detailModel.textContent = task.model || 'Padrão';
  btnBack.hidden = !inDetailView;
  btnBack.replaceChildren(nativeControl('back','←'));

  // Header meta inside detail workspace
  getEl<HTMLHeadingElement>('selected-task-title').textContent = task.label || task.taskId;
  getEl<HTMLSpanElement>('selected-task-model').textContent = task.model ? `Modelo: ${task.model}` : 'Modelo: Padrão';

  const statusEl = getEl<HTMLSpanElement>('selected-task-status');
  statusEl.textContent = `Status: ${task.status}`;

  const modeEl = getEl<HTMLSpanElement>('selected-task-mode');
  modeEl.textContent = task.mode === 'write' ? 'Escrita' : 'Somente leitura';

  // Task error display
  const errorBox = getEl<HTMLDivElement>('selected-task-error-banner');
  const errorText = getEl<HTMLSpanElement>('selected-task-error-text');
  if (task.error) {
    errorBox.hidden = false;
    errorText.textContent = `Erro (${task.error.code}): ${task.error.message}`;
  } else {
    errorBox.hidden = true;
    errorText.textContent = '';
  }

  const parentButton = getEl<HTMLButtonElement>('btn-parent-task');
  parentButton.hidden = !task.parentTaskId;
  parentButton.onclick = () => { if (task.parentTaskId) selectTaskById(task.parentTaskId); };

  const callerList = getEl<HTMLDivElement>('caller-messages');
  const callerFragment = document.createDocumentFragment();
  for (const row of store.callerMessages) {
    const item = document.createElement('div');
    item.className = 'caller-message-item';
    const label = document.createElement('div');
    label.className = 'text-subtle';
    label.textContent = 'Você · ' + row.receipt.state + (row.receipt.error ? ' · ' + row.receipt.error.code : '');
    const body = document.createElement('div');
    body.className = 'markdown-body';
    renderSafeMarkdown(body, row.text);
    item.append(label, body);
    callerFragment.append(item);
  }
  callerList.replaceChildren(callerFragment);
  getEl<HTMLDivElement>('caller-messages-section').hidden = store.callerMessages.length === 0;

  // Delivery mode select
  const selectDelivery = getEl<HTMLSelectElement>('select-delivery-mode');
  selectDelivery.value = task.deliveryMode || 'messages';

  // Public Response Viewport with Safe Markdown rendering
  const viewport = getEl<HTMLDivElement>('conversation-viewport');
  const isScrolledToBottom = viewport.scrollHeight - viewport.scrollTop <= viewport.clientHeight + 25;

  const responseBody = getEl<HTMLDivElement>('public-response-body');
  const effectiveText = getEffectivePublicResponse();
  const visibleResponse = effectiveText || '(Nenhuma resposta até o momento)';
  if (responseBody.dataset.renderedText !== visibleResponse) {
    renderSafeMarkdown(responseBody, visibleResponse);
    responseBody.dataset.renderedText = visibleResponse;
  }

  const paginationFooter = getEl<HTMLDivElement>('response-pagination');
  const pageInfo = getEl<HTMLSpanElement>('response-page-info');
  if (store.responseHasMore) {
    paginationFooter.hidden = false;
    pageInfo.textContent = `Mostrando ${store.responseOffset} de ${store.responseTotalLength} caracteres.`;
  } else {
    paginationFooter.hidden = true;
  }

  renderChangedFiles();
  const processing = getEl<HTMLDivElement>('processing-status');
  const processingText = getEl<HTMLSpanElement>('processing-status-text');
  const actionText = getEl<HTMLSpanElement>('processing-action');
  const active = ['queued','starting','running','streaming'].includes(task.status);
  processing.hidden = !active;
  processingText.textContent = task.status === 'queued' ? 'Na fila' : 'Processando há ' + formatActiveElapsed(task.createdAt,task.startedAt);
  const currentTools = new Map<number,string>();
  for (const event of store.events) {
    const data = event.data as {step_index?: number; tool_name?: string} | undefined;
    if (!data || data.step_index === undefined) continue;
    if (event.type === 'tool.started' && typeof data.tool_name === 'string') currentTools.set(data.step_index,data.tool_name);
    else if (event.type === 'tool.completed') currentTools.delete(data.step_index);
  }
  const tool = [...currentTools.values()].at(-1);
  actionText.textContent = tool === 'write_to_file' ? '✎ Editando arquivos' : tool === 'view_file' ? 'Lendo arquivos' : tool === 'run_command' ? 'Executando comando' : tool ? 'Usando ' + tool : '';

  // Truncated events notice
  const truncatedNotice = getEl<HTMLDivElement>('notice-truncated');
  truncatedNotice.hidden = !store.stickyTruncated;

  // Activity accordion
  const summaryTitle = getEl<HTMLSpanElement>('activity-summary-title');
  const activityPaginationBar = getEl<HTMLDivElement>('activity-pagination-bar');
  const cursorInfo = getEl<HTMLSpanElement>('activity-cursor-info');

  const visibleEvents = store.historyEvents ?? store.events;
  summaryTitle.textContent = (store.historyEvents ? 'Histórico' : 'Atividade recente') + ` (${visibleEvents.length} eventos)`;
  activityPaginationBar.hidden = false;
  const firstSequence = visibleEvents[0]?.sequence;
  const lastSequence = visibleEvents.at(-1)?.sequence;
  cursorInfo.textContent = firstSequence === undefined ? 'Nenhum evento nesta página.' : `Sequências ${firstSequence}–${lastSequence}. Mais antigo retido: ${store.oldestAvailable ?? 1}.`;
  getEl<HTMLButtonElement>('btn-load-older-events').textContent = store.historyEvents ? 'Próxima página' : 'Ver início';
  getEl<HTMLButtonElement>('btn-live-events').hidden = store.historyEvents === null;

  const streamContainer = getEl<HTMLDivElement>('events-stream');
  const frag = document.createDocumentFragment();

  for (const evt of visibleEvents) {
    const entry = document.createElement('div');
    entry.className = 'event-entry';

    const head = document.createElement('div');
    head.className = 'event-entry-head';

    const typeSpan = document.createElement('span');
    typeSpan.className = 'event-entry-type';
    typeSpan.textContent = evt.type;

    const timeSpan = document.createElement('span');
    timeSpan.textContent = new Date(evt.timestamp).toLocaleTimeString();

    head.appendChild(typeSpan);
    head.appendChild(timeSpan);

    const body = document.createElement('div');
    body.className = 'event-entry-body';
    body.textContent = typeof evt.data === 'string' ? evt.data : JSON.stringify(evt.data, null, 2);

    entry.appendChild(head);
    entry.appendChild(body);
    frag.appendChild(entry);
  }

  streamContainer.replaceChildren(frag);

  // Auto-scroll only if previously at bottom
  if (isScrolledToBottom) {
    viewport.scrollTop = viewport.scrollHeight;
  }

  // Token counters
  const tokenCounter = getEl<HTMLSpanElement>('token-usage-counter');
  const tokens = task.tokenUsage?.counters?.totalTokens;
  if (tokens !== undefined && tokens !== null) {
    tokenCounter.textContent = tokens.toLocaleString('pt-BR');
  } else {
    tokenCounter.textContent = 'Não informado';
  }
}

function updateControlStates(): void {
  const task = getCurrentSelectedTask();
  const terminalStatuses = ['completed', 'failed', 'cancelled', 'timeout'];
  const isTerminal = task ? terminalStatuses.includes(task.status) : true;

  // Cancel button
  const btnCancel = getEl<HTMLButtonElement>('btn-cancel-task');
  btnCancel.hidden = !task || isTerminal;
  btnCancel.disabled = !store.capabilities.cancel || !store.hasServerTools;

  // Delivery mode select
  const selectDelivery = getEl<HTMLSelectElement>('select-delivery-mode');
  selectDelivery.disabled = !store.capabilities.deliveryMode || !store.hasServerTools;

  // Share Codex button
  const btnShare = getEl<HTMLButtonElement>('btn-share-codex');
  btnShare.disabled = !store.hasHostMessaging || !task;
  if (!store.hasHostMessaging) {
    btnShare.title = 'Host não suporta envio de mensagens ou está desconectado.';
  } else {
    btnShare.title = 'Envia um resumo compacto (metadados e ref) ao Codex';
  }

  // Load more button
  const btnLoadMore = getEl<HTMLButtonElement>('btn-load-more-response');
  btnLoadMore.disabled = !store.responseHasMore || !store.hasServerTools;

  // Load older events
  const btnLoadOlder = getEl<HTMLButtonElement>('btn-load-older-events');
  btnLoadOlder.disabled = !store.hasServerTools || store.historyBusy || (store.historyEvents !== null && store.historyNextCursor >= (store.nextCursor ?? 0));

  // Composer
  const btnSend = getEl<HTMLButtonElement>('btn-send-message');
  const composerInput = getEl<HTMLTextAreaElement>('composer-input');

  if (!store.hasServerTools) {
    btnSend.disabled = true;
    composerInput.disabled = true;
    composerInput.placeholder = 'Aguardando capacidade de ferramentas do servidor...';
  } else if (!store.capabilities.messaging) {
    btnSend.disabled = true;
    composerInput.disabled = true;
    composerInput.placeholder = 'Envio de mensagens desabilitado pelo servidor.';
  } else if (store.isSubmittingMessage) {
    btnSend.disabled = true;
    composerInput.disabled = true;
  } else {
    btnSend.disabled = false;
    composerInput.disabled = false;
    composerInput.placeholder = 'Digite sua mensagem (Enter envia, Shift+Enter nova linha)...';
  }
}

function showGlobalBanner(message: string): void {
  const banner = getEl<HTMLDivElement>('global-banner');
  const text = getEl<HTMLSpanElement>('global-banner-text');
  text.textContent = message;
  banner.hidden = false;
}

function hideGlobalBanner(): void {
  const banner = getEl<HTMLDivElement>('global-banner');
  banner.hidden = true;
}

function setComposerFeedback(msg: string): void {
  const el = getEl<HTMLSpanElement>('composer-feedback');
  el.textContent = msg;
}

// Bootstrap on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void init();
  });
} else {
  void init();
}
