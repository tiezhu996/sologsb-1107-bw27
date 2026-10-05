export const EVENNESS_LEVELS = ['均匀', '略花', '花'] as const
export type EvennessLevel = (typeof EVENNESS_LEVELS)[number]

/** 搬迁批次，形如 BQ-20261005-01 */
export type RelocationBatch = string

export interface PaperSample {
  id?: number
  sampleNo: string
  runId: number
  sizeMm: number
  stripeCount: number
  evenness: EvennessLevel
  archiveBin: string
  /** 上次对账确认的柜位基准（三方合并的 base） */
  baseBin: string
  /** 最近一次清点器扫到的柜位 */
  scannedBin?: string
  /** 本机与清点器同时改位且不一致时为 true */
  binConflict: boolean
  /** 争议时清点器主张的新柜位 */
  conflictBin?: string
  /** 已并入台账的搬迁批次；未搬迁过的旧记录为空串 */
  relocationBatch: RelocationBatch
  /** 最近一次清点的搬迁批次（无论是否落实） */
  lastScanBatch?: RelocationBatch
  schemaRev?: number
}

export type PaperSampleInput = Omit<
  PaperSample,
  'id' | 'schemaRev' | 'baseBin' | 'scannedBin' | 'binConflict' | 'conflictBin' | 'relocationBatch' | 'lastScanBatch'
> &
  Partial<Pick<PaperSample, 'baseBin' | 'relocationBatch'>>

/** 离线清点器扫回的单条柜格记录 */
export interface BinScanRecord {
  sampleNo: string
  bin: string
}

/** 清点器导出的扫描结果文件 */
export interface BinScanFile {
  batch: string
  scannedAt: string
  scannerId?: string
  records: BinScanRecord[]
}

export interface ReconcileSummary {
  batch: string
  scannedAt: string
  /** 扫描机未改位、直接接受新柜位的样本数 */
  accepted: number
  /** 仅本机改过、保留本机柜位的样本数 */
  localKept: number
  /** 双方都改过、产生争议的样本数 */
  conflicts: number
  /** 扫描中没有、仍留在原柜的样本数 */
  missed: number
  /** 扫描里有、台账查不到的样本编号 */
  unknown: string[]
  /** 同一批扫描结果重复导入，未重复占格 */
  idempotent: boolean
}
