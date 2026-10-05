import type { BinScanFile, PaperSample, ReconcileSummary } from '../types/paper-sample'
import { APP_META_APPLIED_SCAN_BATCHES, db } from './db'

/** 未落实：存在柜位争议，或最近一批清点没扫到（仍留在原柜） */
export function isSampleUnsettled(sample: PaperSample, latestBatch?: string): boolean {
  if (sample.binConflict) return true
  if (latestBatch && sample.lastScanBatch !== latestBatch) return true
  return false
}

/** 从清点器导出的 JSON 文本解析扫描结果，并做基本校验 */
export function parseScanFile(text: string): BinScanFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('扫描结果不是有效的 JSON 文件')
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('扫描结果内容格式不正确')
  const file = raw as Partial<BinScanFile>
  if (typeof file.batch !== 'string' || !file.batch.trim()) throw new Error('扫描结果缺少搬迁批次号')
  if (typeof file.scannedAt !== 'string' || !file.scannedAt.trim()) throw new Error('扫描结果缺少扫描时间')
  if (!Array.isArray(file.records)) throw new Error('扫描结果缺少柜格记录列表')
  const records = file.records.map((record, index) => {
    if (typeof record !== 'object' || record === null) throw new Error(`第 ${index + 1} 条柜格记录格式不正确`)
    const item = record as Partial<{ sampleNo: unknown; bin: unknown }>
    if (typeof item.sampleNo !== 'string' || !item.sampleNo.trim()) throw new Error(`第 ${index + 1} 条柜格记录缺少样本编号`)
    if (typeof item.bin !== 'string' || !item.bin.trim()) throw new Error(`第 ${index + 1} 条柜格记录缺少柜格位置`)
    return { sampleNo: item.sampleNo.trim(), bin: item.bin.trim() }
  })
  return { batch: file.batch.trim(), scannedAt: file.scannedAt.trim(), scannerId: typeof file.scannerId === 'string' ? file.scannerId : undefined, records }
}

async function getAppliedBatches(): Promise<string[]> {
  const meta = await db.appMeta.get(APP_META_APPLIED_SCAN_BATCHES)
  return meta?.value ?? []
}

/**
 * 把离线清点器扫回的柜格记录与成纸样本台账对账。
 *
 * 以 baseBin（上次对账基准位）为三方合并的 base：
 * - 本机未改（archiveBin === baseBin）：接受扫描新柜位；
 * - 仅本机改过（scanBin === baseBin，archiveBin !== baseBin）：保留本机柜位；
 * - 两边都改（archiveBin !== baseBin 且 scanBin !== baseBin）：
 *   - 两边一致则自动消解；不一致则保留双方位置并标出争议，争议样本不占新格。
 *
 * 整个合并在一个读写事务里完成，任一写入失败则全部回滚到搬迁前状态。
 * 同一搬迁批次重复导入直接幂等返回，不会重复占格。
 */
export async function reconcileScanFile(file: BinScanFile): Promise<{ summary: ReconcileSummary; idempotent: boolean }> {
  const applied = await getAppliedBatches()
  if (applied.includes(file.batch)) {
    const samples = await db.paperSamples.toArray()
    const scannedNos = new Set(file.records.map((record) => record.sampleNo))
    return {
      idempotent: true,
      summary: {
        batch: file.batch,
        scannedAt: file.scannedAt,
        accepted: 0,
        localKept: 0,
        conflicts: samples.filter((sample) => sample.binConflict && sample.lastScanBatch === file.batch).length,
        missed: samples.filter((sample) => sample.relocationBatch && !scannedNos.has(sample.sampleNo) && sample.lastScanBatch !== file.batch).length,
        unknown: [],
        idempotent: true,
      },
    }
  }

  const summary: ReconcileSummary = {
    batch: file.batch,
    scannedAt: file.scannedAt,
    accepted: 0,
    localKept: 0,
    conflicts: 0,
    missed: 0,
    unknown: [],
    idempotent: false,
  }

  await db.transaction('rw', db.paperSamples, db.appMeta, async () => {
    const samples = await db.paperSamples.toArray()
    const sampleByNo = new Map(samples.map((sample) => [sample.sampleNo, sample]))
    // 同一编号被扫到多次时，以最后一条扫描记录为准
    const scanByNo = new Map(file.records.map((record) => [record.sampleNo, record.bin]))

    for (const [sampleNo, scannedBin] of scanByNo) {
      const sample = sampleByNo.get(sampleNo)
      if (!sample) {
        summary.unknown.push(sampleNo)
        continue
      }
      if (sample.id === undefined) continue
      const base = sample.baseBin || sample.archiveBin
      const localChanged = sample.archiveBin !== base
      const remoteChanged = scannedBin !== base

      if (!localChanged) {
        // 本机未改过：接受清点器位置（扫描与基准相同也算确认到位）
        await db.paperSamples.update(sample.id, {
          archiveBin: scannedBin,
          baseBin: scannedBin,
          scannedBin,
          conflictBin: undefined,
          binConflict: false,
          relocationBatch: file.batch,
          lastScanBatch: file.batch,
        })
        summary.accepted += 1
      } else if (!remoteChanged) {
        // 只有本机改过：保留本机柜位，不采用扫描位置
        await db.paperSamples.update(sample.id, {
          scannedBin,
          conflictBin: undefined,
          binConflict: false,
          lastScanBatch: file.batch,
        })
        summary.localKept += 1
      } else if (sample.archiveBin === scannedBin) {
        // 两边都改但改成同一格：争议自动消解，共同位置落实
        await db.paperSamples.update(sample.id, {
          baseBin: scannedBin,
          scannedBin,
          conflictBin: undefined,
          binConflict: false,
          relocationBatch: file.batch,
          lastScanBatch: file.batch,
        })
        summary.accepted += 1
      } else {
        // 两边都改且不一致：保留双方位置并标出争议，archiveBin 不占新格
        await db.paperSamples.update(sample.id, {
          scannedBin,
          conflictBin: scannedBin,
          binConflict: true,
          lastScanBatch: file.batch,
        })
        summary.conflicts += 1
      }
    }

    // 漏扫的已搬迁样本仍留在原柜：不换格、不标争议、不改记录，只计数；
    // 其 lastScanBatch 不更新，仍作为“未落实”样本显示
    summary.missed = samples.filter(
      (sample) => Boolean(sample.relocationBatch) && !scanByNo.has(sample.sampleNo),
    ).length

    await db.appMeta.put({ key: APP_META_APPLIED_SCAN_BATCHES, value: [...applied, file.batch] })
  })

  return { summary, idempotent: false }
}

/** 争议处理：采用本机位置（新格让位给台账） */
export async function resolveConflictKeepLocal(id: number): Promise<void> {
  await db.transaction('rw', db.paperSamples, async () => {
    const sample = await db.paperSamples.get(id)
    if (!sample || !sample.binConflict) return
    await db.paperSamples.update(id, {
      baseBin: sample.archiveBin,
      conflictBin: undefined,
      binConflict: false,
    })
  })
}

/** 争议处理：采用清点器位置，样本落到扫描格 */
export async function resolveConflictKeepScanned(id: number): Promise<void> {
  await db.transaction('rw', db.paperSamples, async () => {
    const sample = await db.paperSamples.get(id)
    if (!sample || !sample.binConflict || !sample.conflictBin) return
    await db.paperSamples.update(id, {
      archiveBin: sample.conflictBin,
      baseBin: sample.conflictBin,
      scannedBin: sample.conflictBin,
      conflictBin: undefined,
      binConflict: false,
      relocationBatch: sample.lastScanBatch || sample.relocationBatch,
    })
  })
}

/** 本机调整柜位（不计入扫描，仅相对基准位产生本机改动） */
export async function updateLocalBin(id: number, bin: string): Promise<void> {
  const trimmed = bin.trim()
  if (!trimmed) throw new Error('柜格位置不能为空')
  await db.paperSamples.update(id, { archiveBin: trimmed, binConflict: false, conflictBin: undefined })
}
