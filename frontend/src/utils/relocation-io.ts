import type { PaperSample } from '../types/paper-sample'
import type { ReconcileSummary, RelocationBatch } from '../types/relocation-batch'
import { db, plain } from './db'
import { computeScanFingerprint, nextBatchNo, parseScanFile, planReconciliation } from './relocation'

export interface ImportResult {
  ok: boolean
  error?: string
  /** 同一份扫描结果完全已应用、本次未产生任何写入 */
  replayed?: boolean
  batch?: RelocationBatch
  summary?: ReconcileSummary
}

/**
 * 仅供验证使用：在样本写入后、批次写入前注入一次失败，
 * 用以证明整个对账在同一个 Dexie 事务中、失败即恢复搬迁前状态。
 */
let failureHook: null | (() => void) = null
export function __setFailureHookForTests(hook: null | (() => void)) {
  failureHook = hook
}

function sameRecord(a: PaperSample, b: PaperSample): boolean {
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b))
}

/** 带回离线清点器扫回的柜格记录并对账；整批一个事务，写入失败则恢复搬迁前状态 */
export async function importScanFile(text: string): Promise<ImportResult> {
  let scan
  try {
    scan = parseScanFile(text)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '扫描文件解析失败' }
  }
  if (scan.records.length === 0) {
    return { ok: false, error: '扫描文件中没有有效的柜格记录（需含样本编号与柜格）' }
  }

  const fingerprint = computeScanFingerprint(scan.records)
  const importedAt = new Date().toISOString()
  const scanBatchId = scan.scanBatchId || `离线清点-${fingerprint.slice(0, 12)}`

  try {
    return await db.transaction('rw', db.paperSamples, db.relocationBatches, async () => {
      const [allSamples, batches] = await Promise.all([
        db.paperSamples.toArray(),
        db.relocationBatches.orderBy('id').toArray(),
      ])
      const existing =
        batches.find((batch) => batch.scanBatchId === scanBatchId) ??
        batches.find((batch) => batch.scanFingerprint === fingerprint)
      // 重导既有批次：只对账该批次成员，绝不改动其他批次（含此前批次漏扫留原柜的样本）
      const samples = existing
        ? allSamples.filter((sample) => sample.relocationBatchId === (existing.id as number))
        : allSamples
      const originals = new Map(samples.map((sample) => [sample.id as number, sample]))

      const batchId = existing?.id ?? batches.reduce((max, batch) => Math.max(max, (batch.id as number) ?? 0), 0) + 1
      const batchNo = existing?.batchNo ?? nextBatchNo(batches)

      const plan = planReconciliation({
        samples,
        occupiedSamples: allSamples,
        records: scan.records,
        scanBatchId,
        scannedAt: scan.scannedAt || importedAt,
        fingerprint,
        batchId: batchId as number,
        batchNo,
        importedAt,
        existingBatch: existing,
      })

      const changed = plan.samplesToPut.filter((sample) => {
        const original = originals.get(sample.id as number)
        return !original || !sameRecord(original, sample)
      })
      const batchChanged = existing ? JSON.stringify(plain(existing)) !== JSON.stringify(plain(plan.batch)) : true

      // 成员可能改挂到新批次：把计数发生变化的旧批次一并刷新（仍在同一事务内）
      const batchesToPut: RelocationBatch[] = []
      for (const [id, stats] of plan.batchStatsById) {
        const row = batches.find((candidate) => candidate.id === id)
        if (!row) continue
        const refreshed = { ...row, ...stats }
        if (JSON.stringify(plain(row)) !== JSON.stringify(plain(refreshed))) batchesToPut.push(refreshed)
      }
      const anyBatchWrite = batchChanged || batchesToPut.length > 0

      // 重出一份扫描结果：全部已落实/未变化 → 不做任何写入，绝不重复占格
      if (changed.length === 0 && !anyBatchWrite) {
        return { ok: true, replayed: true, batch: existing, summary: plan.summary }
      }

      if (batchChanged) await db.relocationBatches.put(plain(plan.batch))
      for (const row of batchesToPut) {
        if (row.id === plan.batch.id && batchChanged) continue
        await db.relocationBatches.put(plain(row))
      }
      if (changed.length > 0) await db.paperSamples.bulkPut(changed.map(plain))
      failureHook?.()

      return { ok: true, replayed: false, batch: plan.batch, summary: plan.summary }
    })
  } catch (error) {
    // 事务已整体回滚：柜格占用与样本位置恢复到搬迁前状态
    return { ok: false, error: `对账写入失败，已恢复搬迁前状态：${error instanceof Error ? error.message : '未知错误'}` }
  }
}

export type DisputeChoice = 'scanned' | 'local'

export interface DisputeResult {
  ok: boolean
  error?: string
  sample?: PaperSample
}

/** 处理争议：采用扫描侧新格，或确认保留本机侧柜位；争议未决时不占新格 */
export async function resolveDispute(sampleId: number, choice: DisputeChoice): Promise<DisputeResult> {
  try {
    return await db.transaction('rw', db.paperSamples, db.relocationBatches, async () => {
      const sample = await db.paperSamples.get(sampleId)
      if (!sample) return { ok: false, error: '样本记录不存在' }
      if (sample.relocationStatus !== 'disputed') return { ok: false, error: '该样本当前没有待处理争议' }

      const keepLocal = choice === 'local'
      const targetBin = keepLocal ? (sample.previousBin ?? sample.archiveBin) : (sample.scannedBin ?? sample.archiveBin)

      if (!keepLocal) {
        const all = await db.paperSamples.toArray()
        const occupant = all.find((candidate) => candidate.archiveBin === targetBin && candidate.id !== sampleId)
        if (occupant && occupant.relocationStatus === 'settled') {
          return { ok: false, error: `扫描柜格 ${targetBin} 已被 ${occupant.sampleNo} 占用` }
        }
      }

      const batchId = sample.relocationBatchId ?? null
      const batch = batchId ? await db.relocationBatches.get(batchId) : undefined
      const resolved: PaperSample = {
        ...sample,
        archiveBin: targetBin,
        scannedBin: null,
        disputeReason: null,
        relocationStatus: 'settled',
        positionDirty: keepLocal,
        appliedScanId: keepLocal ? sample.appliedScanId : batch?.scanFingerprint || sample.appliedScanId,
        schemaRev: 3,
      }
      await db.paperSamples.put(plain(resolved))

      if (batchId && batch) {
        const members = await db.paperSamples.toArray()
        const own = members.filter((member) => member.relocationBatchId === batchId)
        await db.relocationBatches.put(
          plain({
            ...batch,
            settledCount: own.filter((member) => member.relocationStatus === 'settled').length,
            missedCount: own.filter((member) => member.relocationStatus === 'missed').length,
            disputedCount: own.filter((member) => member.relocationStatus === 'disputed').length,
          }),
        )
      }
      return { ok: true, sample: resolved }
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '争议处理失败' }
  }
}

export interface BinEditResult {
  ok: boolean
  error?: string
  sample?: PaperSample
}

/** 本机修改样本柜位：记为“本机改过”，对账时不会被扫描位置直接覆盖 */
export async function updateSampleBin(sampleId: number, binInput: string): Promise<BinEditResult> {
  const archiveBin = binInput.trim()
  if (!archiveBin) return { ok: false, error: '柜格不能为空' }
  try {
    return await db.transaction('rw', db.paperSamples, async () => {
      const sample = await db.paperSamples.get(sampleId)
      if (!sample) return { ok: false, error: '样本记录不存在' }
      if (sample.archiveBin === archiveBin) return { ok: true, sample }

      const occupant = (await db.paperSamples.toArray()).find(
        (candidate) => candidate.archiveBin === archiveBin && candidate.id !== sampleId,
      )
      if (occupant && occupant.relocationStatus === 'settled') {
        return { ok: false, error: `柜格 ${archiveBin} 已被 ${occupant.sampleNo} 占用` }
      }

      const next: PaperSample = {
        ...sample,
        archiveBin,
        positionDirty: sample.relocationStatus === 'settled' ? sample.positionDirty : true,
        schemaRev: 3,
      }
      await db.paperSamples.put(plain(next))
      return { ok: true, sample: next }
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '柜位更新失败' }
  }
}
