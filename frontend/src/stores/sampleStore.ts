import { create } from 'zustand'
import type { PaperSample, PaperSampleInput } from '../types/paper-sample'
import type { ReconcileSummary, RelocationBatch } from '../types/relocation-batch'
import { db, plain } from '../utils/db'
import {
  importScanFile,
  resolveDispute as resolveDisputeIo,
  updateSampleBin,
  type DisputeChoice,
  type ImportResult,
} from '../utils/relocation-io'

interface SampleStore {
  paperSamples: PaperSample[]
  relocationBatches: RelocationBatch[]
  isLoading: boolean
  loaded: boolean
  error: string | null
  lastSummary: ReconcileSummary | null
  loadSamples: () => Promise<void>
  addSample: (input: PaperSampleInput) => Promise<PaperSample | null>
  importScan: (text: string) => Promise<ImportResult>
  resolveDispute: (sampleId: number, choice: DisputeChoice) => Promise<boolean>
  changeBin: (sampleId: number, bin: string) => Promise<boolean>
}

export const useSampleStore = create<SampleStore>((set, get) => ({
  paperSamples: [],
  relocationBatches: [],
  isLoading: false,
  loaded: false,
  error: null,
  lastSummary: null,
  loadSamples: async () => {
    if (get().loaded) return
    set({ isLoading: true, error: null })
    try {
      const [paperSamples, relocationBatches] = await Promise.all([
        db.paperSamples.orderBy('sampleNo').toArray(),
        db.relocationBatches.orderBy('id').toArray(),
      ])
      set({ paperSamples, relocationBatches, isLoading: false, loaded: true })
    } catch {
      set({ isLoading: false, error: '样本档案读取失败，请检查浏览器存储权限' })
    }
  },
  addSample: async (input) => {
    set({ error: null })
    try {
      const payload: PaperSample = {
        ...plain(input),
        previousBin: null,
        scannedBin: null,
        relocationBatchId: null,
        relocationStatus: null,
        disputeReason: null,
        positionDirty: false,
        appliedScanId: null,
        schemaRev: 3,
      }
      const id = Number(await db.paperSamples.add(payload))
      const created: PaperSample = { ...payload, id }
      set((state) => ({ paperSamples: [created, ...state.paperSamples] }))
      return created
    } catch {
      set({ error: '样本登记失败，请检查样本编号是否重复' })
      return null
    }
  },
  importScan: async (text) => {
    set({ error: null })
    const result = await importScanFile(text)
    if (result.ok) {
      const [paperSamples, relocationBatches] = await Promise.all([
        db.paperSamples.orderBy('sampleNo').toArray(),
        db.relocationBatches.orderBy('id').toArray(),
      ])
      set({ paperSamples, relocationBatches, lastSummary: result.summary ?? get().lastSummary })
    } else {
      set({ error: result.error ?? '对账失败' })
    }
    return result
  },
  resolveDispute: async (sampleId, choice) => {
    set({ error: null })
    const result = await resolveDisputeIo(sampleId, choice)
    if (result.ok) {
      const [paperSamples, relocationBatches] = await Promise.all([
        db.paperSamples.orderBy('sampleNo').toArray(),
        db.relocationBatches.orderBy('id').toArray(),
      ])
      set({ paperSamples, relocationBatches })
    } else {
      set({ error: result.error ?? '争议处理失败' })
    }
    return result.ok
  },
  changeBin: async (sampleId, bin) => {
    set({ error: null })
    const result = await updateSampleBin(sampleId, bin)
    if (result.ok && result.sample) {
      const updated = result.sample
      set((state) => ({
        paperSamples: state.paperSamples.map((sample) => (sample.id === sampleId ? updated : sample)),
      }))
    } else {
      set({ error: result.error ?? '柜位更新失败' })
    }
    return result.ok
  },
}))
