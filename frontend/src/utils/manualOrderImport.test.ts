import { describe, expect, it, vi } from 'vitest'

const readSheetMock = vi.hoisted(() => vi.fn())
vi.mock('read-excel-file/browser', () => ({ readSheet: readSheetMock }))

import {
  MANUAL_IMPORT_LIMITS,
  parseCsv,
  parseManualOrderFile,
  parseTabularRows,
  parseTrackingText,
} from './manualOrderImport'

describe('manual order import parsing', () => {
  it('splits common Chinese separators, normalizes and de-duplicates tracking numbers', () => {
    const preview = parseTrackingText(
      ' sf-12345678，YT12345678;\nSF12345678, bad ',
      { productName: '办公用品' },
    )
    expect(preview.fatalError).toBe('')
    expect(preview.rows.map((row) => [row.trackingNo, row.state])).toEqual([
      ['SF12345678', 'READY'],
      ['YT12345678', 'READY'],
      ['SF12345678', 'DUPLICATE_INPUT'],
      ['bad', 'FAILED'],
    ])
    expect(preview.rows[0]?.productName).toBe('办公用品')
  })

  it('fails the whole pasted batch for a likely split decimal tail without rejecting two long numeric tracking numbers', () => {
    expect(parseTrackingText('9818907591847,0')).toMatchObject({ rows: [], fatalError: expect.stringContaining('小数截断') })
    expect(parseTrackingText('SF12345678;9818907591847,0\nYT12345678')).toMatchObject({ rows: [], fatalError: expect.stringContaining('小数截断') })

    const valid = parseTrackingText('9818907591847,1234567890123456')
    expect(valid.fatalError).toBe('')
    expect(valid.rows.map((row) => row.state)).toEqual(['READY', 'READY'])
  })

  it('accepts compatible headers and marks a missing product for the backend default', () => {
    const preview = parseTabularRows([
      ['物流单号', '商品', '快递公司'],
      ['9818907591847', '', '邮政 EMS'],
      ['', '鞋子', '圆通'],
    ])
    expect(preview.fatalError).toBe('')
    expect(preview.rows[0]).toMatchObject({
      trackingNo: '9818907591847',
      state: 'READY',
      usesDefaultProduct: true,
      message: '可导入；商品名将使用“未填写商品名称”',
    })
    expect(preview.rows[1]).toMatchObject({ state: 'FAILED', message: '缺少运单号' })

    const commonBusinessHeaders = parseTabularRows([
      ['快递号', '品名', '快递'],
      ['SF87654321', '补录商品', '顺丰'],
    ])
    expect(commonBusinessHeaders.rows[0]).toMatchObject({
      trackingNo: 'SF87654321',
      productName: '补录商品',
      courier: '顺丰',
      state: 'READY',
    })
  })

  it('prefers an explicit logistics column over an earlier order-number fallback', () => {
    const preview = parseTabularRows([
      ['订单号', '商品名称', '运单号'],
      ['ORDER12345678', '商品', 'SF87654321'],
    ])
    expect(preview.rows[0]).toMatchObject({ trackingNo: 'SF87654321', state: 'READY' })
  })

  it('fails closed for multiple logistics columns and never treats purchase order columns as tracking', () => {
    const explicit = parseTabularRows([
      ['运单号', '快递单号'],
      ['SF12345678', 'YT12345678'],
    ])
    expect(explicit.rows).toEqual([])
    expect(explicit.fatalError).toContain('多个物流单号列')

    const fallback = parseTabularRows([
      ['订单号', '单号'],
      ['ORDER12345678', 'SF12345678'],
    ])
    expect(fallback.rows).toEqual([])
    expect(fallback.fatalError).toContain('采购订单号不能代替物流运单号')

    const orderOnly = parseTabularRows([
      ['订单号', '商品名称'],
      ['SF12345678', '商品'],
    ])
    expect(orderOnly.rows).toEqual([])
    expect(orderOnly.fatalError).toContain('把列名改成“运单号”')
  })

  it('only accepts string Excel tracking numbers and preserves long strings', () => {
    const preview = parseTabularRows([
      ['快递单号', '商品名称'],
      [9818907591847, '安全整数'],
      [981890759184712300, '已损失精度'],
      ['981890759184712300', '文本单号'],
    ])
    expect(preview.rows[0]).toMatchObject({ state: 'FAILED', message: expect.stringContaining('单号列必须为文本') })
    expect(preview.rows[1]).toMatchObject({
      state: 'FAILED',
      message: '单号列必须为文本，请在 Excel 中将单号列设为文本后重试',
    })
    expect(preview.rows[2]).toMatchObject({ state: 'READY', trackingNo: '981890759184712300' })
    const types = parseTabularRows([
      ['运单号'],
      [new Date('2026-08-24')],
      [true],
    ])
    expect(types.rows.every((row) => row.state === 'FAILED')).toBe(true)
  })

  it('reports oversized spreadsheet fields instead of silently truncating them', () => {
    const preview = parseTabularRows([
      ['运单号', '商品名称', '物流公司', '备注'],
      ['SF12345678', '商'.repeat(257), '顺丰', '正常'],
      ['YT12345678', '商品', '物'.repeat(129), '正常'],
      ['ZT12345678', '商品', '中通', '注'.repeat(513)],
    ])
    expect(preview.rows.map((row) => row.message)).toEqual([
      '商品名称超过 256 个字符，请缩短后重试',
      '物流公司超过 128 个字符，请缩短后重试',
      '备注超过 512 个字符，请缩短后重试',
    ])
    expect(preview.rows.every((row) => row.state === 'FAILED')).toBe(true)
  })

  it('parses quoted CSV cells and rejects oversized batches', () => {
    expect(parseCsv('\uFEFF运单号,商品名称\r\nSF12345678,"杯子, 蓝色"')).toEqual([
      ['运单号', '商品名称'],
      ['SF12345678', '杯子, 蓝色'],
    ])
    const preview = parseTrackingText(
      Array.from({ length: MANUAL_IMPORT_LIMITS.maxRows + 1 }, (_, index) => `SF${String(index).padStart(8, '0')}`).join('\n'),
    )
    expect(preview.fatalError).toContain(`最多导入 ${MANUAL_IMPORT_LIMITS.maxRows} 条`)
    expect(() => parseCsv('运单号,商品名称\n"SF12345678,杯子')).toThrow('CSV 引号未闭合')
    expect(() => parseCsv('运单号,商品名称\nSF"12345678,杯子')).toThrow('CSV 引号格式非法')
    expect(() => parseCsv('运单号,商品名称\n"SF12345678"多余,杯子')).toThrow('CSV 引号格式非法')
  })

  it('keeps original spreadsheet row numbers after blank rows', () => {
    const preview = parseTabularRows([
      ['运单号', '商品名称'],
      [],
      ['SF12345678', '商品'],
    ])
    expect(preview.rows[0]?.sourceRow).toBe(3)
  })

  it('fails the entire file when a data row has non-empty cells beyond the header', () => {
    const splitDecimalCsv = parseTabularRows(parseCsv('运单号\n9818907591847,0'))
    expect(splitDecimalCsv).toMatchObject({ rows: [], fatalError: expect.stringContaining('超出表头范围') })

    const extraColumn = parseTabularRows([
      ['运单号', '商品名称'],
      ['SF12345678', '商品', '意外第三列'],
    ])
    expect(extraColumn).toMatchObject({ rows: [], fatalError: expect.stringContaining('多余列') })
  })

  it('rejects scientific notation and date-shaped tracking values', () => {
    const preview = parseTrackingText('9.818907591847 E+12\n2026-08-24\n08/24/2026\n24/08/2026\n2026.08.24')
    expect(preview.rows[0]).toMatchObject({ state: 'FAILED', message: expect.stringContaining('科学计数法') })
    expect(preview.rows[1]).toMatchObject({ state: 'FAILED', message: expect.stringContaining('日期格式') })
    expect(preview.rows.slice(2).every((row) => row.state === 'FAILED' && row.message.includes('日期格式'))).toBe(true)
  })

  it('rejects decimal-shaped tracking values before punctuation normalization', () => {
    const preview = parseTabularRows([
      ['运单号'],
      ['9818907591847,0'],
      ['9818907591847.0'],
      ['9818907591847 , 0'],
    ])
    expect(preview.rows.every((row) => row.state === 'FAILED' && row.message.includes('Excel 数值改写'))).toBe(true)
    const quotedCsv = parseTabularRows(parseCsv('运单号,商品名称\n"9818907591847,0",鞋子'))
    expect(quotedCsv.rows[0]).toMatchObject({ state: 'FAILED', message: expect.stringContaining('Excel 数值改写') })
  })

  it('never merges multiple tracking numbers from one spreadsheet cell', () => {
    const preview = parseTabularRows([
      ['运单号'],
      ['SF12345678/YT87654321'],
      ['SF12345678\nYT87654321'],
      ['SF12345678;YT87654321'],
    ])
    expect(preview.rows.every((row) => row.state === 'FAILED' && row.message.includes('一个输入只能有一个运单号'))).toBe(true)
  })

  it('requires valid UTF-8 CSV bytes', async () => {
    const invalid = {
      name: 'gbk.csv', size: 2,
      arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer,
    } as unknown as File
    await expect(parseManualOrderFile(invalid)).resolves.toMatchObject({ fatalError: expect.stringContaining('UTF-8') })
  })

  it('reads the first worksheet from xlsx and clearly rejects legacy xls', async () => {
    readSheetMock.mockResolvedValueOnce([
      ['运单号', '商品名称'],
      ['SF12345678', '文件商品'],
    ])
    const xlsx = { name: 'orders.xlsx', size: 128 } as File
    await expect(parseManualOrderFile(xlsx)).resolves.toMatchObject({
      fatalError: '',
      rows: [expect.objectContaining({ trackingNo: 'SF12345678', productName: '文件商品' })],
    })
    expect(readSheetMock).toHaveBeenCalledWith(xlsx)

    const xls = { name: 'legacy.xls', size: 128 } as File
    await expect(parseManualOrderFile(xls)).resolves.toMatchObject({ fatalError: expect.stringContaining('另存为 .xlsx 或 CSV') })
  })
})
