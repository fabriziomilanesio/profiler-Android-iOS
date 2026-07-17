import { describe, expect, test } from 'bun:test'
import { parseDevices } from './parseDevices'

describe('parseDevices', () => {
  test('parsea output real de `adb devices -l` con un device', () => {
    const raw = [
      'List of devices attached',
      'R58M42XXXX             device usb:34603008X product:beyond1qltexx model:SM_G973F device:beyond1 transport_id:1',
      '',
    ].join('\n')

    expect(parseDevices(raw)).toEqual([
      {
        serial: 'R58M42XXXX',
        state: 'device',
        description:
          'usb:34603008X product:beyond1qltexx model:SM_G973F device:beyond1 transport_id:1',
      },
    ])
  })

  test('detecta device unauthorized', () => {
    const raw = 'List of devices attached\nemulator-5554\tunauthorized\n'
    expect(parseDevices(raw)).toEqual([
      { serial: 'emulator-5554', state: 'unauthorized', description: '' },
    ])
  })

  test('lista vacía y líneas de ruido del daemon', () => {
    const raw = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      '',
    ].join('\n')
    expect(parseDevices(raw)).toEqual([])
  })
})
