import {
  DISPUTE_REASONS,
  LEGACY_RELOCATION_BATCH_ID,
  type DisputeReason,
  type PaperSample,
  type RelocationStatus,
} from '../types/paper-sample'
import type {
  ReconcileSummary,
  RelocationBatch,
  SampleReconcileResult,
  ScannedBinRecord,
  ScanFile,
} from '../types/relocation-batch'

export const SCHEMA_REV = 3

/** 稳定指纹：同一份扫描结果重出（文件名/时间变化）指纹不变，用于去重 */
export function computeScanFingerprint(records: ScannedBinRecord[]): string {
  const canonical = records
    .map((record) => `${record.sampleNo.trim()}=>${record.archiveBin.trim()}`)
    .sort()
    .join('\n')
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0')
  return `scan-${hex}-${canonical.length}`
}

function asRecord(value: unknown): { sampleNo?: unknown; archiveBin?: unknown } {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const sampleNo = record.sampleNo ?? record.code ?? record.no ?? record['样本编号'] ?? record['编号']
  const archiveBin =
    record.archiveBin ?? record.bin ?? record.cabinetBin ?? record.cell ?? record['柜格'] ?? record['存档位']
  return { sampleNo, archiveBin }
}

/** 解析离线清点器导出的 JSON：支持 {records:[...]} 或直接数组，字段名兼容常见别名 */
export function parseScanFile(text: string): ScanFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('扫描文件不是合法 JSON，请确认离线清点器导出未损坏')
  }
  const root = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const rawRecords = Array.isArray(data) ? data : root.records
  const scanBatchId = typeof root.scanBatchId === 'string' ? root.scanBatchId.trim() : ''
  const scannedAt = typeof root.scannedAt === 'string' ? root.scannedAt.trim() : ''
  if (!Array.isArray(rawRecords)) {
    throw new Error('扫描文件缺少 records 柜格记录列表')
  }
  const records: ScannedBinRecord[] = []
  for (const raw of rawRecords) {
    const { sampleNo, archiveBin } = asRecord(raw)
    if (typeof sampleNo === 'string' && typeof archiveBin === 'string' && sampleNo.trim() && archiveBin.trim()) {
      records.push({ sampleNo: sampleNo.trim(), archiveBin: archiveBin.trim() })
    }
  }
  return { scanBatchId, scannedAt, records }
}

export function nextBatchNo(existingBatches: RelocationBatch[], now = new Date()): string {
  const year = String(now.getFullYear()).slice(2)
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `BQ-${year}${month}-`
  const sequence = existingBatches
    .map((batch) => (batch.batchNo.startsWith(prefix) ? Number(batch.batchNo.slice(prefix.length)) : 0))
    .reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0)
  return `${prefix}${String(sequence + 1).padStart(2, '0')}`
}

export interface ReconcilePlanInput {
  samples: PaperSample[]
  /** 占用冲突检测视角：通常为全库样本；samples 本身是其中一个子集 */
  occupiedSamples?: PaperSample[]
  records: ScannedBinRecord[]
  scanBatchId: string
  scannedAt: string
  fingerprint: string
  batchId: number
  batchNo: string
  importedAt: string
  /** 同一扫描批次号的既有批次行；存在表示这是补导/重导 */
  existingBatch?: RelocationBatch
}

export interface ReconcilePlan {
  /** 需 bulkPut 的完整样本记录 */
  samplesToPut: PaperSample[]
  batch: RelocationBatch
  summary: ReconcileSummary
  /** 本次对账后所有批次的最新计数（含成员改挂后需要刷新的旧批次） */
  batchStatsById: Map<number, { settledCount: number; missedCount: number; disputedCount: number }>
}

function withRev3(sample: PaperSample): PaperSample {
  return { ...sample, schemaRev: SCHEMA_REV }
}

/**
 * 纯函数对账：按样本编号认记录。
 * - 只接受本机未改过位置（positionDirty 非真）的扫描位置；
 * - 两边改过同一张样本且位置不同 → disputed，保留双方柜格，不占新格；
 * - 扫描目标格已被其他已落实样本占用 → disputed（bin-already-taken）；
 * - 同一份扫描里同一样本给了不同格 → disputed（scan-duplicate）；
 * - 批次成员漏扫 → missed，样本仍留在原柜；
 * - 已落实/已应用的样本直接跳过，重导不重复占格。
 */
export function planReconciliation(input: ReconcilePlanInput): ReconcilePlan {
  const { samples, records, scanBatchId, scannedAt, fingerprint, batchId, batchNo, importedAt, existingBatch } = input
  const occupiedScope = input.occupiedSamples ?? samples

  const results: SampleReconcileResult[] = []
  const nextById = new Map<number, PaperSample>()

  const getNext = (sample: PaperSample): PaperSample => {
    const id = sample.id as number
    return nextById.get(id) ?? sample
  }
  const saveNext = (sample: PaperSample) => {
    nextById.set(sample.id as number, sample)
  }

  // 当前新库房中已落实占用的柜格：只有 settled 样本真正占格（用全库视角检测跨批次占用）
  const occupiedBins = new Map<string, number>()
  for (const sample of occupiedScope) {
    if (sample.relocationStatus === 'settled') occupiedBins.set(sample.archiveBin, sample.id as number)
  }

  // 扫描记录按编号归并，检出同一文件内的重复/冲突行
  const scanByNo = new Map<string, { bins: string[]; conflict: boolean }>()
  for (const record of records) {
    const entry = scanByNo.get(record.sampleNo) ?? { bins: [], conflict: false }
    if (!entry.bins.includes(record.archiveBin)) {
      if (entry.bins.length > 0) entry.conflict = true
      entry.bins.push(record.archiveBin)
    }
    scanByNo.set(record.sampleNo, entry)
  }

  const sampleByNo = new Map(samples.map((sample) => [sample.sampleNo, sample]))
  const matchedNos = new Set<string>()
  let settledCount = 0
  let disputedCount = 0
  let unknownCount = 0
  let alreadyAppliedCount = 0

  const markStatus = (sample: PaperSample, status: RelocationStatus | null, patch: Partial<PaperSample>): PaperSample => {
    const next: PaperSample = { ...withRev3(getNext(sample)), relocationStatus: status, ...patch }
    saveNext(next)
    return next
  }

  for (const [sampleNo, scan] of scanByNo.entries()) {
    const sample = sampleByNo.get(sampleNo)
    if (!sample) {
      unknownCount += 1
      results.push({ sampleId: -1, sampleNo, outcome: 'unknown', scannedBin: scan.bins[0] })
      continue
    }
    matchedNos.add(sampleNo)
    const current = getNext(sample)
    const scannedBin = scan.bins[0]

    // 已落实（含同一扫描结果已应用）：跳过，不重复占格
    if (current.relocationStatus === 'settled' || current.appliedScanId === fingerprint) {
      alreadyAppliedCount += 1
      results.push({
        sampleId: current.id as number,
        sampleNo,
        outcome: 'already-applied',
        archiveBin: current.archiveBin,
        previousBin: current.previousBin ?? current.archiveBin,
      })
      continue
    }

    let reason: DisputeReason | null = null
    if (scan.conflict) {
      reason = DISPUTE_REASONS[2] // scan-duplicate
    } else {
      const occupant = occupiedBins.get(scannedBin)
      if (occupant !== undefined && occupant !== (current.id as number)) {
        reason = DISPUTE_REASONS[1] // bin-already-taken
      } else if (current.positionDirty && scannedBin !== current.archiveBin) {
        reason = DISPUTE_REASONS[0] // bin-edited-locally
      }
    }

    if (reason) {
      disputedCount += 1
      markStatus(sample, 'disputed', {
        previousBin: current.archiveBin,
        scannedBin,
        disputeReason: reason,
        appliedScanId: null,
        relocationBatchId: batchId,
      })
      results.push({ sampleId: current.id as number, sampleNo, outcome: 'disputed', disputeReason: reason, scannedBin, previousBin: current.archiveBin })
      continue
    }

    // 接受扫描位置：原柜位记入 previousBin，样本占上新格
    const previousBin = current.archiveBin
    const settled: PaperSample = {
      ...withRev3(current),
      previousBin,
      archiveBin: scannedBin,
      scannedBin: null,
      disputeReason: null,
      positionDirty: false,
      relocationStatus: 'settled',
      relocationBatchId: batchId,
      appliedScanId: fingerprint,
    }
    saveNext(settled)
    occupiedBins.set(scannedBin, settled.id as number)
    settledCount += 1
    results.push({ sampleId: settled.id as number, sampleNo, outcome: 'settled', archiveBin: scannedBin, previousBin })
  }

  // 批次成员中漏扫的：仍留在原柜，不占新格。
  // 已存在批次只维护它自己的成员；
  // 新批次只纳入未落实、且不属于其他真实批次的样本（存量旧柜记录与未挂批记录可被新批吸纳）。
  const memberOf = (sample: PaperSample): boolean => {
    if (existingBatch) return sample.relocationBatchId === (existingBatch.id as number)
    if (sample.relocationStatus === 'settled') return false
    return (
      sample.relocationBatchId === null ||
      sample.relocationBatchId === undefined ||
      sample.relocationBatchId === LEGACY_RELOCATION_BATCH_ID
    )
  }
  let missedCount = 0
  for (const sample of samples) {
    const current = getNext(sample)
    if (matchedNos.has(sample.sampleNo)) continue
    if (current.relocationStatus === 'settled') continue
    if (!memberOf(current)) continue
    // 补扫重导时仍是漏扫的成员：状态本来就一致，不产生写入，保证整批重导幂等
    if (
      current.relocationStatus === 'missed' &&
      current.relocationBatchId === batchId &&
      current.previousBin === current.archiveBin &&
      !current.scannedBin &&
      !current.disputeReason
    ) {
      results.push({ sampleId: current.id as number, sampleNo: sample.sampleNo, outcome: 'missed', previousBin: current.archiveBin })
      continue
    }
    markStatus(sample, 'missed', {
      previousBin: current.archiveBin,
      scannedBin: null,
      disputeReason: null,
      relocationBatchId: batchId,
    })
    missedCount += 1
    results.push({ sampleId: current.id as number, sampleNo: sample.sampleNo, outcome: 'missed', previousBin: current.archiveBin })
  }

  // 批次行统计以最终全量表为准（争议可能在补扫后转为已落实；成员也可能改挂新批次）
  const finalSamples = occupiedScope.map((sample) => nextById.get(sample.id as number) ?? sample)
  const batchMembers = finalSamples.filter((sample) => sample.relocationBatchId === batchId)
  const finalSettled = batchMembers.filter((sample) => sample.relocationStatus === 'settled').length
  const finalMissed = batchMembers.filter((sample) => sample.relocationStatus === 'missed').length
  const finalDisputed = batchMembers.filter((sample) => sample.relocationStatus === 'disputed').length

  /** 供编排层重算所有受影响批次：成员改挂别的批次后，旧批次计数也要同步 */
  const batchStatsById = new Map<number, { settledCount: number; missedCount: number; disputedCount: number }>()
  for (const sample of finalSamples) {
    if (sample.relocationBatchId === null || sample.relocationBatchId === undefined) continue
    const stats = batchStatsById.get(sample.relocationBatchId) ?? { settledCount: 0, missedCount: 0, disputedCount: 0 }
    if (sample.relocationStatus === 'settled') stats.settledCount += 1
    else if (sample.relocationStatus === 'missed') stats.missedCount += 1
    else if (sample.relocationStatus === 'disputed') stats.disputedCount += 1
    batchStatsById.set(sample.relocationBatchId, stats)
  }

  const batch: RelocationBatch = {
    id: batchId,
    batchNo: existingBatch?.batchNo ?? batchNo,
    scanBatchId,
    scanFingerprint: fingerprint,
    // 重导同一扫描批次：保留首次导入时记录的扫描时间
    scannedAt: existingBatch?.scannedAt || scannedAt || importedAt,
    // 重导不产生实际变化时保留首次导入时间，保证重出扫描结果整体幂等
    importedAt: existingBatch?.importedAt || importedAt,
    settledCount: finalSettled,
    missedCount: finalMissed,
    disputedCount: finalDisputed,
    unknownCount,
  }

  // 仅写出实际变化的样本（nextById 中的对象由原记录链式派生，字段完整）
  const samplesToPut = Array.from(nextById.values())

  const summary: ReconcileSummary = {
    scanBatchId,
    scanFingerprint: fingerprint,
    scannedAt: batch.scannedAt,
    total: records.length,
    settledCount,
    missedCount,
    disputedCount,
    unknownCount,
    alreadyAppliedCount,
    results,
  }

  return { samplesToPut, batch, summary, batchStatsById }
}
