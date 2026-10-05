import type { DisputeReason } from './paper-sample'

export interface RelocationBatch {
  id?: number
  /** 批次编号，如 BQ-2610-01 */
  batchNo: string
  /** 离线清点器扫描批次号（设备侧编号，可重复导入同一批） */
  scanBatchId: string
  /** 扫描文件内容指纹：同一份扫描结果重出再导不会重复占格 */
  scanFingerprint: string
  scannedAt: string
  importedAt: string
  /** 批次内已落实（已占新格）样本数 */
  settledCount: number
  /** 漏扫、仍留在原柜的样本数 */
  missedCount: number
  /** 存在争议、未占新格的样本数 */
  disputedCount: number
  /** 扫描到但台账中没有的样本编号数 */
  unknownCount: number
}

/** 离线清点器扫回的单条柜格记录 */
export interface ScannedBinRecord {
  sampleNo: string
  archiveBin: string
}

export interface ScanFile {
  scanBatchId?: string
  scannedAt?: string
  records: ScannedBinRecord[]
}

export type ReconcileOutcome =
  | 'settled'
  | 'missed'
  | 'disputed'
  | 'unknown'
  | 'already-applied'

export interface SampleReconcileResult {
  sampleId: number
  sampleNo: string
  outcome: ReconcileOutcome
  /** 争议原因 */
  disputeReason?: DisputeReason
  /** 最终占用的新柜格 */
  archiveBin?: string
  /** 争议时扫描器侧柜格 */
  scannedBin?: string
  /** 争议或漏扫时保留的本机/原柜柜格 */
  previousBin?: string
}

export interface ReconcileSummary {
  scanBatchId: string
  scanFingerprint: string
  scannedAt: string
  total: number
  settledCount: number
  missedCount: number
  disputedCount: number
  unknownCount: number
  alreadyAppliedCount: number
  results: SampleReconcileResult[]
}
