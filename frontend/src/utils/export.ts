import { db, plain, type AppMeta } from './db'

export async function exportDatabaseJson(): Promise<string> {
  const [moulds, fiberBatches, sheetRuns, paperSamples, appMeta] = await Promise.all([
    db.moulds.toArray(),
    db.fiberBatches.toArray(),
    db.sheetRuns.toArray(),
    db.paperSamples.toArray(),
    db.appMeta.toArray() as Promise<AppMeta[]>,
  ])
  const filename = `gbpapermill-backup-${new Date().toISOString().slice(0, 10)}.json`
  const backup = plain({
    database: 'gbpapermill-db',
    version: 3,
    exportedAt: new Date().toISOString(),
    moulds,
    fiberBatches,
    sheetRuns,
    paperSamples,
    appMeta,
  })
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
  return filename
}
