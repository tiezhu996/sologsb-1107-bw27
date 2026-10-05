import { create } from 'zustand'
import type { BinScanFile, PaperSample, PaperSampleInput, ReconcileSummary } from '../types/paper-sample'
import { db, plain } from '../utils/db'
import { reconcileScanFile, resolveConflictKeepLocal, resolveConflictKeepScanned, updateLocalBin } from '../utils/reconcile'

interface SampleStore {
  paperSamples: PaperSample[]
  isLoading: boolean
  loaded: boolean
  error: string | null
  notice: string | null
  loadSamples: () => Promise<void>
  addSample: (input: PaperSampleInput) => Promise<PaperSample | null>
  changeLocalBin: (id: number, bin: string) => Promise<boolean>
  importScanFile: (file: BinScanFile) => Promise<{ summary: ReconcileSummary; idempotent: boolean } | null>
  settleConflictKeepLocal: (id: number) => Promise<void>
  settleConflictKeepScanned: (id: number) => Promise<void>
  clearNotice: () => void
}

export const useSampleStore = create<SampleStore>((set, get) => ({
  paperSamples: [],
  isLoading: false,
  loaded: false,
  error: null,
  notice: null,
  loadSamples: async () => {
    if (get().loaded) return
    set({ isLoading: true, error: null })
    try {
      const paperSamples = await db.paperSamples.orderBy('sampleNo').toArray()
      set({ paperSamples, isLoading: false, loaded: true })
    } catch {
      set({ isLoading: false, error: '样本档案读取失败，请检查浏览器存储权限' })
    }
  },
  addSample: async (input) => {
    set({ error: null })
    try {
      const archiveBin = plain(input).archiveBin
      const payload: PaperSample = {
        ...plain(input),
        archiveBin,
        baseBin: input.baseBin ?? archiveBin,
        binConflict: false,
        relocationBatch: input.relocationBatch ?? '',
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
  changeLocalBin: async (id, bin) => {
    set({ error: null })
    try {
      await updateLocalBin(id, bin)
      set((state) => ({
        paperSamples: state.paperSamples.map((sample) =>
          sample.id === id ? { ...sample, archiveBin: bin.trim(), binConflict: false, conflictBin: undefined } : sample,
        ),
      }))
      return true
    } catch {
      set({ error: '本机柜位调整失败' })
      return false
    }
  },
  importScanFile: async (file) => {
    set({ error: null, notice: null })
    try {
      const result = await reconcileScanFile(file)
      const paperSamples = await db.paperSamples.orderBy('sampleNo').toArray()
      const s = result.summary
      const tail = result.idempotent ? '该批次扫描结果已对过账，未重复占格。' : '对账写入完成。'
      set({
        paperSamples,
        notice: `批次 ${s.batch}：接收新位 ${s.accepted} 条，保留本机 ${s.localKept} 条，争议 ${s.conflicts} 条，漏扫留柜 ${s.missed} 条${s.unknown.length ? `，未登记编号 ${s.unknown.length} 个` : ''}。${tail}`,
      })
      return result
    } catch {
      // 事务回滚后重新拉取，恢复搬迁前状态
      const paperSamples = await db.paperSamples.orderBy('sampleNo').toArray().catch(() => get().paperSamples)
      set({ paperSamples, error: '扫描对账写入失败，已恢复到搬迁前状态，本批未占用任何柜格' })
      return null
    }
  },
  settleConflictKeepLocal: async (id) => {
    set({ error: null })
    try {
      await resolveConflictKeepLocal(id)
      set((state) => ({
        paperSamples: state.paperSamples.map((sample) =>
          sample.id === id ? { ...sample, baseBin: sample.archiveBin, conflictBin: undefined, binConflict: false } : sample,
        ),
      }))
    } catch {
      set({ error: '争议处理失败，请稍后重试' })
    }
  },
  settleConflictKeepScanned: async (id) => {
    set({ error: null })
    try {
      await resolveConflictKeepScanned(id)
      const paperSamples = await db.paperSamples.orderBy('sampleNo').toArray()
      set({ paperSamples })
    } catch {
      set({ error: '争议处理失败，请稍后重试' })
    }
  },
  clearNotice: () => set({ notice: null }),
}))
