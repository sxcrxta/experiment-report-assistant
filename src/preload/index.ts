/**
 * preload — 렌더러가 외부 세계에 닿는 유일한 통로.
 *
 * 여기에 로직을 넣지 않는다. 메인 프로세스 핸들러를 그대로 노출하기만 한다.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  AnchorDecision,
  SectionOverride,
  StagedReviewInput,
} from '../shared/feedback.js'
import type { FirstRunGuide } from '../shared/first-run.js'
import {
  CHANNELS,
  type AgentBridge,
  type AiSettingsResult,
  type AppInfo,
  type CancelDeepReviewResult,
  type ClaudeModeResult,
  type ReReviewResultView,
  type ChooseDocumentResult,
  type ConfirmRubricResult,
  type ApplyRubricTemplateResult,
  type DeleteRubricTemplateResult,
  type RubricLibraryResult,
  type SaveRubricTemplateResult,
  type DecideSentenceAnchorResult,
  type DeleteResult,
  type AnalyzeOutlineResult,
  type SetDocumentKindResult,
  type RunCheckResult,
  type GetCheckResult,
  type PolishRequest,
  type PolishResult,
  type DeleteOpenRouterKeyResult,
  type DiscardRubricDraftResult,
  type DocumentEvent,
  type DocumentSummary,
  type DocumentWorkspaceResult,
  type MarkCheckpointResult,
  type ReconnectDocumentResult,
  type RestoreCheckpointResult,
  type ReviewPanelResult,
  type RubricEditorResult,
  type RubricItemInput,
  type SaveOpenRouterKeyResult,
  type SaveSectionBoundariesResult,
  type SetSubjectResult,
  type StagedReviewResultView,
  type SuggestRubricDraftResult,
} from '../shared/ipc.js'

const bridge: AgentBridge = {
  getDocumentPreview: documentId => ipcRenderer.invoke(CHANNELS.getDocumentPreview, documentId) as ReturnType<AgentBridge['getDocumentPreview']>,
  getGrowth: () => ipcRenderer.invoke(CHANNELS.getGrowth) as ReturnType<AgentBridge['getGrowth']>,
  getPersonalRecords: documentId => ipcRenderer.invoke(CHANNELS.getPersonalRecords,documentId) as ReturnType<AgentBridge['getPersonalRecords']>,
  savePersonalRecord: input => ipcRenderer.invoke(CHANNELS.savePersonalRecord,input) as ReturnType<AgentBridge['savePersonalRecord']>,
  deletePersonalRecord: input => ipcRenderer.invoke(CHANNELS.deletePersonalRecord,input) as ReturnType<AgentBridge['deletePersonalRecord']>,
  summarizeGrowth: depth => ipcRenderer.invoke(CHANNELS.summarizeGrowth,depth) as ReturnType<AgentBridge['summarizeGrowth']>,
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CHANNELS.appInfo) as Promise<AppInfo>,
  getFirstRun: (): Promise<FirstRunGuide> => ipcRenderer.invoke(CHANNELS.getFirstRun) as Promise<FirstRunGuide>,
  chooseDocument: (subject: string): Promise<ChooseDocumentResult> =>
    ipcRenderer.invoke(CHANNELS.chooseDocument, subject) as Promise<ChooseDocumentResult>,
  listDocuments: (): Promise<DocumentSummary[]> =>
    ipcRenderer.invoke(CHANNELS.listDocuments) as Promise<DocumentSummary[]>,
  getDocumentWorkspace: (documentId: string): Promise<DocumentWorkspaceResult> =>
    ipcRenderer.invoke(CHANNELS.getDocumentWorkspace, documentId) as Promise<DocumentWorkspaceResult>,
  refreshDocument: (documentId: string): Promise<DocumentWorkspaceResult> =>
    ipcRenderer.invoke(CHANNELS.refreshDocument, documentId) as Promise<DocumentWorkspaceResult>,
  reconnectDocument: (documentId: string): Promise<ReconnectDocumentResult> =>
    ipcRenderer.invoke(CHANNELS.reconnectDocument, documentId) as Promise<ReconnectDocumentResult>,
  markCheckpoint: (documentId: string, label: string): Promise<MarkCheckpointResult> =>
    ipcRenderer.invoke(CHANNELS.markCheckpoint, documentId, label) as Promise<MarkCheckpointResult>,
  restoreCheckpoint: (checkpointId: string): Promise<RestoreCheckpointResult> =>
    ipcRenderer.invoke(CHANNELS.restoreCheckpoint, checkpointId) as Promise<RestoreCheckpointResult>,
  deleteCheckpoint: (checkpointId: string): Promise<DeleteResult> =>
    ipcRenderer.invoke(CHANNELS.deleteCheckpoint, checkpointId) as Promise<DeleteResult>,
  deleteDocument: (documentId: string): Promise<DeleteResult> =>
    ipcRenderer.invoke(CHANNELS.deleteDocument, documentId) as Promise<DeleteResult>,
  deleteFeedback: (documentId: string, feedbackId: string): Promise<DeleteResult> =>
    ipcRenderer.invoke(CHANNELS.deleteFeedback, documentId, feedbackId) as Promise<DeleteResult>,
  runCheck: (documentId: string): Promise<RunCheckResult> =>
    ipcRenderer.invoke(CHANNELS.runCheck, documentId) as Promise<RunCheckResult>,
  getCheck: (documentId: string): Promise<GetCheckResult> =>
    ipcRenderer.invoke(CHANNELS.getCheck, documentId) as Promise<GetCheckResult>,
  setDocumentKind: (documentId: string, kind: string): Promise<SetDocumentKindResult> =>
    ipcRenderer.invoke(CHANNELS.setDocumentKind, documentId, kind) as Promise<SetDocumentKindResult>,
  analyzeOutline: (documentId: string): Promise<AnalyzeOutlineResult> =>
    ipcRenderer.invoke(CHANNELS.analyzeOutline, documentId) as Promise<AnalyzeOutlineResult>,
  setCompactWindow: (on: boolean): Promise<{ compact: boolean }> =>
    ipcRenderer.invoke(CHANNELS.setCompactWindow, on) as Promise<{ compact: boolean }>,
  polishText: (request: PolishRequest): Promise<PolishResult> =>
    ipcRenderer.invoke(CHANNELS.polishText, request) as Promise<PolishResult>,
  setSubject: (documentId: string, subject: string): Promise<SetSubjectResult> =>
    ipcRenderer.invoke(CHANNELS.setSubject, documentId, subject) as Promise<SetSubjectResult>,
  getRubric: (documentId: string): Promise<RubricEditorResult> =>
    ipcRenderer.invoke(CHANNELS.getRubric, documentId) as Promise<RubricEditorResult>,
  saveRubricDraft: (documentId: string, items: RubricItemInput[]): Promise<RubricEditorResult> =>
    ipcRenderer.invoke(CHANNELS.saveRubricDraft, documentId, items) as Promise<RubricEditorResult>,
  confirmRubric: (documentId: string, items: RubricItemInput[]): Promise<ConfirmRubricResult> =>
    ipcRenderer.invoke(CHANNELS.confirmRubric, documentId, items) as Promise<ConfirmRubricResult>,
  discardRubricDraft: (documentId: string): Promise<DiscardRubricDraftResult> =>
    ipcRenderer.invoke(CHANNELS.discardRubricDraft, documentId) as Promise<DiscardRubricDraftResult>,
  suggestRubricDraft: (documentId: string): Promise<SuggestRubricDraftResult> =>
    ipcRenderer.invoke(CHANNELS.suggestRubricDraft, documentId) as Promise<SuggestRubricDraftResult>,
  listRubricTemplates: (query: { documentId?: string; subject?: string }): Promise<RubricLibraryResult> =>
    ipcRenderer.invoke(CHANNELS.listRubricTemplates, query) as Promise<RubricLibraryResult>,
  createRubricTemplate: (name: string, items: RubricItemInput[]): Promise<SaveRubricTemplateResult> =>
    ipcRenderer.invoke(CHANNELS.createRubricTemplate, name, items) as Promise<SaveRubricTemplateResult>,
  updateRubricTemplate: (id: string, name: string, items: RubricItemInput[]): Promise<SaveRubricTemplateResult> =>
    ipcRenderer.invoke(CHANNELS.updateRubricTemplate, id, name, items) as Promise<SaveRubricTemplateResult>,
  deleteRubricTemplate: (id: string): Promise<DeleteRubricTemplateResult> =>
    ipcRenderer.invoke(CHANNELS.deleteRubricTemplate, id) as Promise<DeleteRubricTemplateResult>,
  applyRubricTemplate: (documentId: string, templateId: string): Promise<ApplyRubricTemplateResult> =>
    ipcRenderer.invoke(CHANNELS.applyRubricTemplate, documentId, templateId) as Promise<ApplyRubricTemplateResult>,
  saveDocumentRubricToLibrary: (documentId: string, name: string): Promise<SaveRubricTemplateResult> =>
    ipcRenderer.invoke(CHANNELS.saveDocumentRubricToLibrary, documentId, name) as Promise<SaveRubricTemplateResult>,
  getAiSettings: (): Promise<AiSettingsResult> =>
    ipcRenderer.invoke(CHANNELS.getAiSettings) as Promise<AiSettingsResult>,
  saveOpenRouterKey: (key: string): Promise<SaveOpenRouterKeyResult> =>
    ipcRenderer.invoke(CHANNELS.saveOpenRouterKey, key) as Promise<SaveOpenRouterKeyResult>,
  deleteOpenRouterKey: (): Promise<DeleteOpenRouterKeyResult> =>
    ipcRenderer.invoke(CHANNELS.deleteOpenRouterKey) as Promise<DeleteOpenRouterKeyResult>,
  recheckClaudeMode: (): Promise<ClaudeModeResult> =>
    ipcRenderer.invoke(CHANNELS.recheckClaudeMode) as Promise<ClaudeModeResult>,
  saveClaudeCliPath: (path: string): Promise<ClaudeModeResult> =>
    ipcRenderer.invoke(CHANNELS.saveClaudeCliPath, path) as Promise<ClaudeModeResult>,
  clearClaudeCliPath: (): Promise<ClaudeModeResult> =>
    ipcRenderer.invoke(CHANNELS.clearClaudeCliPath) as Promise<ClaudeModeResult>,
  requestReReview: (documentId: string, feedbackId: string): Promise<ReReviewResultView> =>
    ipcRenderer.invoke(CHANNELS.requestReReview, documentId, feedbackId) as Promise<ReReviewResultView>,
  cancelDeepReview: (): Promise<CancelDeepReviewResult> =>
    ipcRenderer.invoke(CHANNELS.cancelDeepReview) as Promise<CancelDeepReviewResult>,
  getReviewPanel: (documentId: string, includeAll?: boolean): Promise<ReviewPanelResult> =>
    ipcRenderer.invoke(CHANNELS.getReviewPanel, documentId, includeAll === true) as Promise<ReviewPanelResult>,
  requestStagedReview: (input: StagedReviewInput): Promise<StagedReviewResultView> =>
    ipcRenderer.invoke(CHANNELS.requestStagedReview, input) as Promise<StagedReviewResultView>,
  saveSectionBoundaries: (
    documentId: string,
    overrides: SectionOverride[],
  ): Promise<SaveSectionBoundariesResult> =>
    ipcRenderer.invoke(
      CHANNELS.saveSectionBoundaries,
      documentId,
      overrides,
    ) as Promise<SaveSectionBoundariesResult>,
  decideSentenceAnchor: (
    anchorId: string,
    decision: AnchorDecision,
  ): Promise<DecideSentenceAnchorResult> =>
    ipcRenderer.invoke(
      CHANNELS.decideSentenceAnchor,
      anchorId,
      decision,
    ) as Promise<DecideSentenceAnchorResult>,
  onDocumentEvent: (listener: (event: DocumentEvent) => void): (() => void) => {
    // 렌더러에 IpcRendererEvent(보낸 쪽 정보)를 넘기지 않는다. 알림 내용만 전달한다.
    const handler = (_event: IpcRendererEvent, payload: DocumentEvent): void => listener(payload)
    ipcRenderer.on(CHANNELS.documentEvent, handler)
    return () => {
      ipcRenderer.removeListener(CHANNELS.documentEvent, handler)
    }
  },
}

contextBridge.exposeInMainWorld('agent', bridge)
