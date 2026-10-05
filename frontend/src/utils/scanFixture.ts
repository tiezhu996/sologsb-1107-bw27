import type { BinScanFile } from '../types/paper-sample'

/** 生成一份示例扫描结果，覆盖接收新位、漏扫、未知编号等情形，便于演示对账 */
export function buildDemoScanFile(existingNos: string[]): BinScanFile {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const batch = `BQ-${date}-01`
  const newBin = (index: number) => `新库-A${String(index).padStart(2, '0')}`
  // 故意漏掉最后一个样本，模拟漏扫；再附一个台账里没有的编号
  const records = existingNos.slice(0, -1).map((sampleNo, index) => ({ sampleNo, bin: newBin(index + 1) }))
  records.push({ sampleNo: 'YZ-99', bin: newBin(99) })
  return {
    batch,
    scannedAt: new Date().toISOString(),
    scannerId: 'QDQ-02',
    records,
  }
}
