export const EVENNESS_LEVELS = ['均匀', '略花', '花'] as const
export type EvennessLevel = (typeof EVENNESS_LEVELS)[number]

/** 搬迁批次中的样本对账状态：未决（漏扫）、争议、已落实（已占新格） */
export const RELOC_STATUS = ['missed', 'disputed', 'settled'] as const
export type RelocationStatus = (typeof RELOC_STATUS)[number]

/** 争议来源：本机改过柜位 / 新格已被占用 / 扫描文件中同一样本给了不同柜格 */
export const DISPUTE_REASONS = ['bin-edited-locally', 'bin-already-taken', 'scan-duplicate'] as const
export type DisputeReason = (typeof DISPUTE_REASONS)[number]

/** 旧柜记录升级时回填的搬迁批次（尚无搬迁动作，仅标注批次来源） */
export const LEGACY_RELOCATION_BATCH_ID = 1
export const LEGACY_RELOCATION_BATCH_NO = 'BQ-0000-存量旧柜'

export interface PaperSample {
  id?: number
  sampleNo: string
  runId: number
  sizeMm: number
  stripeCount: number
  evenness: EvennessLevel
  archiveBin: string
  /** 搬迁前柜位（漏扫时样本仍留在原柜；争议时保留本机侧位置） */
  previousBin?: string | null
  /** 扫描器给出的新柜格，仅在争议未决期间保留 */
  scannedBin?: string | null
  /** 搬迁批次号（RelocationBatch.batchNo），存量记录升级时回填 */
  relocationBatchId?: number | null
  /** 对账状态：未决/争议/已落实；已落实或未参与搬迁时为 null */
  relocationStatus?: RelocationStatus | null
  /** 争议原因，relocationStatus 为 disputed 时存在 */
  disputeReason?: DisputeReason | null
  /** 本机是否改过柜位（对账时据此决定是否直接接受扫描位置） */
  positionDirty?: boolean
  /** 已落实占格的扫描批次指纹，用于重扫去重 */
  appliedScanId?: string | null
  schemaRev?: number
}

export type PaperSampleInput = Omit<
  PaperSample,
  'id' | 'schemaRev' | 'previousBin' | 'scannedBin' | 'relocationBatchId' | 'relocationStatus' | 'disputeReason' | 'positionDirty' | 'appliedScanId'
>
